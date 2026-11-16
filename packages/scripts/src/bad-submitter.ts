// Fraud demo: ADMIN_B bonds as a submitter on a rollup, posts one ledger transfer, then submits
// the next batch with ONE BYTE of its state root flipped. Watchers in challenge mode should
// refuse to attest it and send the fraud proof that slashes ADMIN_B's bond.
// Usage: pnpm bad [rollup-id]   (stop the honest operator first so it does not batch first)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  RestClient, QledgerLedger, EMPTY_INBOX_ACC, executeQledger, fetchQledgerEntries, qledgerAccumulate,
  planQledgerBatch, submitBatchMsg, bondRollupSubmitterMsg, postRollupDataMsg, signQledgerTx, encodeQledgerTx, bytesToHex,
} from "@qorechain/rdk";
import { account, ledgerKey, NET, STATE_DIR } from "@wicketgate/core/env";
import { sendNative, explorerTx } from "@wicketgate/core/chain";

const ROLLUP = process.argv[2] ?? "wicketgate-pay";
const NONCES = join(STATE_DIR, "ledger-nonces.json");

async function main() {
  const A = await account("ADMIN_A");
  const B = await account("ADMIN_B");
  const rest = new RestClient(NET.rest);
  const env = { chainId: NET.chainId, rollupId: ROLLUP };

  const bond = await rest.getSubmitterBond(ROLLUP, B.cosmos).catch(() => undefined as any);
  if (!bond || BigInt(bond.amount ?? 0) === 0n) {
    const r = await sendNative(B, [bondRollupSubmitterMsg({ submitter: B.cosmos, rollupId: ROLLUP, amount: "1000000000" })], { gas: 500_000 });
    console.log(`ADMIN_B bonded 1,000 QOR: ${explorerTx(r.transactionHash)}`);
  }

  // one honest transfer for the batch to carry
  const la = await ledgerKey("ADMIN_A"), lb = await ledgerKey("W1");
  const nonces = existsSync(NONCES) ? JSON.parse(readFileSync(NONCES, "utf8")) : {};
  const key = `${ROLLUP}:${bytesToHex(la.accountId)}`;
  const nonce = BigInt(nonces[key] ?? 0);
  const tx = signQledgerTx({ chainId: NET.chainId, rollupId: ROLLUP, secretKey: la.secretKey, publicKey: la.publicKey, nonce, amount: 100_000n, to: lb.accountId });
  const p = await sendNative(A, [postRollupDataMsg({ poster: A.cosmos, rollupId: ROLLUP, data: encodeQledgerTx(tx) })], { gas: 700_000 });
  nonces[key] = (nonce + 1n).toString();
  writeFileSync(NONCES, JSON.stringify(nonces, null, 2));
  console.log(`posted a 0.1 QOR transfer: ${explorerTx(p.transactionHash)}`);

  // rebuild the honest ledger, plan the next batch, then corrupt it
  const ledger = new QledgerLedger();
  let acc: Uint8Array | string = EMPTY_INBOX_ACC;
  for (let i = 0; ; i++) {
    let b; try { b = await rest.getBatch(ROLLUP, i); } catch { break; }
    if (b.status === "rejected") continue;
    const e = await fetchQledgerEntries(rest, { ...env, from: b.inboxStart, to: b.inboxEnd, accFrom: acc });
    executeQledger(env, ledger, e);
    acc = qledgerAccumulate({ ...env, from: b.inboxStart, accFrom: acc, entries: e });
  }
  const plan = await planQledgerBatch(rest, { chainId: NET.chainId, rollupId: ROLLUP, submitter: B.cosmos, ledger });
  const bad = Uint8Array.from(plan.input.stateRoot);
  bad[31] ^= 0x01;
  console.log(`batch ${plan.input.batchIndex}: honest state root ${bytesToHex(plan.input.stateRoot)}`);
  console.log(`batch ${plan.input.batchIndex}: submitted root      ${bytesToHex(bad)}  (last byte flipped)`);
  const r = await sendNative(B, [submitBatchMsg({ ...plan.input, stateRoot: bad, sequencer: B.cosmos } as any)], { gas: 2_000_000 });
  console.log(`ADMIN_B submitted the wrong batch: ${explorerTx(r.transactionHash)}`);
}
main().catch((e) => {
  console.error(e.shortMessage ?? e.message ?? e);
  process.exitCode = 1;
});
