// A settlement receipt for every batch of a rollup. Builds each receipt from the chain, verifies it
// by re-reading every field (layer binding, state root, anchor, creator authority, ML-DSA-87
// signature, chain binding), and saves receipts/<rollup>/batch-<n>.json plus receipts/<rollup>/index.json.
// Batches that the chain rejected have no receipt and are listed as such.
// Usage: npx tsx src/receipts-all.ts [rollup-id]       (read-only, no key needed)
import { mkdirSync, writeFileSync } from "node:fs";
import { createRdkClient, buildSettlementReceipt, verifySettlementReceipt, RestClient, isRestNotFound } from "@qorechain/rdk";
import { NET } from "@wicketgate/core/env";
import { politeFetch } from "@wicketgate/core/polite";

const ROLLUP = process.argv[2] ?? "wicketgate-pay";

async function main() {
  const client = createRdkClient({ network: "testnet", endpoints: { rest: NET.rest, rpc: NET.rpc } as any });
  const rest = new RestClient(NET.rest, { fetch: politeFetch as any });
  // WICKETGATE_RECEIPTS_DIR lets the feed publisher write them into the public feed instead
  const base = process.env.WICKETGATE_RECEIPTS_DIR ? new URL(`file://${process.env.WICKETGATE_RECEIPTS_DIR.replace(/\/?$/, "/")}`) : new URL("../../../receipts/", import.meta.url);
  const dir = new URL(`${ROLLUP}/`, base);
  mkdirSync(dir, { recursive: true });
  const rows: any[] = [];
  for (let i = 0; ; i++) {
    let b: any;
    try { b = await rest.getBatch(ROLLUP, i); } catch (e) { if (isRestNotFound(e)) break; throw e; }
    if (b.status === "rejected") { rows.push({ batch: i, status: "rejected", valid: null }); console.log(`batch ${i}: rejected on chain, no receipt`); continue; }
    try {
      const receipt = await buildSettlementReceipt(client, ROLLUP, i);
      const v = await verifySettlementReceipt(receipt, { client });
      const passed = Object.values(v.checks).filter(Boolean).length, total = Object.keys(v.checks).length;
      writeFileSync(new URL(`batch-${i}.json`, dir), JSON.stringify({ receipt, verification: { valid: v.valid, mode: v.mode, checks: v.checks, checkedAt: new Date().toISOString() } }, null, 2) + "\n");
      rows.push({ batch: i, status: b.status, valid: v.valid, checks: `${passed}/${total}`, stateRoot: receipt.stateRoot, anchorHeight: receipt.mainChainHeight, algorithm: receipt.algorithm, file: `batch-${i}.json` });
      console.log(`batch ${i}: ${b.status}, receipt ${v.valid ? "VALID" : "INVALID"} (${passed}/${total} checks)${v.reason ? ` ${v.reason}` : ""}`);
    } catch (e: any) {
      rows.push({ batch: i, status: b.status, valid: false, error: String(e?.message ?? e).slice(0, 200) });
      console.log(`batch ${i}: ${b.status}, no receipt: ${String(e?.message ?? e).slice(0, 160)}`);
    }
  }
  const withReceipt = rows.filter((r) => r.valid !== null);
  const valid = withReceipt.filter((r) => r.valid).length;
  writeFileSync(new URL("index.json", dir), JSON.stringify({ rollupId: ROLLUP, generatedAt: new Date().toISOString(), batches: rows.length, receipts: withReceipt.length, valid, rows }, null, 2) + "\n");
  console.log(`\n${ROLLUP}: ${valid} of ${withReceipt.length} receipts valid (${rows.length - withReceipt.length} batches rejected on chain have none). Saved ${dir.pathname}`);
  if (valid !== withReceipt.length) process.exitCode = 1;
}
main().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
