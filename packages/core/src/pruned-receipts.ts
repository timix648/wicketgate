// Settlement receipts that stay verifiable after QoreChain prunes the batch record.
//
// The chain deletes a finalised batch's record after `finalized_batch_retention_blocks` (432,000
// blocks, about 7 days on testnet). From then on the RDK's verifySettlementReceipt stops at "batch
// N not found on chain", although everything that proves the receipt is still on chain: the
// rollup's layer, the anchor for that batch (layer height = batch index) with its state root and
// ML-DSA-87 signature, and the creator's post-quantum key.
//
// verifyReceiptPruneSafe runs the RDK's own verifier unchanged. Only when the chain shows that the
// batch record was pruned (it answers 404, the rollup has later batches, and the batch's anchor is
// older than the retention window) does it take the batch's state root from the chain's anchor for
// that batch instead of the deleted record. Nothing is ever taken from the receipt itself, and
// every other check (anchor fields, creator key, signature, chain binding) runs as before. The
// result says `pruned: true` so a reader knows which path was used.
import { createRdkClient, verifySettlementReceipt, type SettlementReceipt } from "@qorechain/rdk";

type Client = ReturnType<typeof createRdkClient>;
export type PruneSafeVerification = Awaited<ReturnType<typeof verifySettlementReceipt>> & { pruned: boolean; prunedReason?: string };

async function getJson(url: string): Promise<any> {
  const r = await fetch(url);
  if (!r.ok) throw Object.assign(new Error(`GET ${url} -> ${r.status}`), { status: r.status });
  return r.json();
}

/** Why the chain no longer holds batch `index` of `rollupId`, or undefined if it has not pruned it. */
export async function batchPrunedReason(restUrl: string, rollupId: string, layerId: string, index: number): Promise<{ reason: string; anchorRoot: string } | undefined> {
  const base = restUrl.replace(/\/$/, "");
  const status = await fetch(`${base}/qorechain/rdk/v1/batch/${rollupId}/${index}`).then((r) => r.status);
  if (status !== 404) return undefined;
  const params = (await getJson(`${base}/qorechain/rdk/v1/params`)).params;
  const retention = Number(params.finalized_batch_retention_blocks);
  const height = Number((await getJson(`${base}/cosmos/base/tendermint/v1beta1/blocks/latest`)).block.header.height);
  const anchors = (await getJson(`${base}/qorechain/multilayer/v1/anchors/${layerId}`)).anchors as any[];
  const a = anchors.find((x) => Number(x.layer_height) === index);
  if (!a) return undefined;
  const age = height - Number(a.main_chain_height);
  if (age < retention) return undefined; // a 404 on a young batch is not pruning: refuse
  return {
    reason: `batch ${index} record pruned by the chain (404; its anchor is ${age} blocks old, retention ${retention}); state root taken from the chain's anchor for layer height ${index}`,
    anchorRoot: Buffer.from(a.state_root, "base64").toString("hex"),
  };
}

/** verifySettlementReceipt, still able to verify receipts whose batch record the chain has pruned. */
export async function verifyReceiptPruneSafe(receipt: SettlementReceipt, client: Client, restUrl: string): Promise<PruneSafeVerification> {
  const v = await verifySettlementReceipt(receipt, { client });
  if (v.valid || !/batch \d+ not found on chain/.test(v.reason ?? "")) return { ...v, pruned: false };
  const p = await batchPrunedReason(restUrl, receipt.rollupId, receipt.layerId, receipt.batchIndex);
  if (!p) return { ...v, pruned: false };
  const rest = client.rest as any;
  const shim = new Proxy(rest, {
    get(target, prop, recv) {
      if (prop === "getBatch") {
        return async (rollupId: string, index: number | bigint) =>
          rollupId === receipt.rollupId && Number(index) === receipt.batchIndex ? { rollupId, batchIndex: Number(index), stateRoot: p.anchorRoot } : target.getBatch(rollupId, index);
      }
      const val = Reflect.get(target, prop, recv);
      return typeof val === "function" ? val.bind(target) : val;
    },
  });
  const v2 = await verifySettlementReceipt(receipt, { client: { ...client, rest: shim } as Client });
  return { ...v2, pruned: true, prunedReason: p.reason };
}
