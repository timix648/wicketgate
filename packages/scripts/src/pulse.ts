// Keep-alive pulse for wicketgate-pay. The chain deletes a finalised batch's record about 7 days
// after it finalises, and the RDK's stock verifySettlementReceipt cannot check a receipt after that
// (ours can: core/pruned-receipts). So that anyone, with any verifier, always finds fresh receipts,
// this posts a tiny signed transfer (0.01 QOR, ADMIN_A -> W1 ledger accounts) whenever the newest
// batch is older than PULSE_MAX_AGE_H hours; the operator then batches, anchors and finalises it.
// The nonce comes from the watcher feed (the chain's own ledger state), not a local counter.
//   npx tsx src/pulse.ts [--once]        (tmux session wicketgate-pulse; checks every 6 hours)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { postRollupDataMsg, signQledgerTx, encodeQledgerTx, bytesToHex } from "@qorechain/rdk";
import { account, ledgerKey, NET, STATE_DIR } from "@wicketgate/core/env";
import { sendNative, explorerTx } from "@wicketgate/core/chain";

const ROLLUP = "wicketgate-pay";
const MAX_AGE_H = Number(process.env.PULSE_MAX_AGE_H ?? 48);
const log = (m: string) => console.log(`${new Date().toISOString()} [pulse] ${m}`);

async function once() {
  const feed = JSON.parse(readFileSync(join(STATE_DIR, "feed-w1", `${ROLLUP}.json`), "utf8"));
  const last = (feed.batches ?? []).at(-1);
  const r = await fetch(`${NET.rest}/qorechain/rdk/v1/batch/${ROLLUP}/${last.index}`).then((x) => x.json());
  const ageH = (Date.now() / 1000 - Number(r.batch.submitted_time)) / 3600;
  if (ageH < MAX_AGE_H) return log(`newest batch ${last.index} is ${ageH.toFixed(1)} h old; nothing to do`);
  const A = await account("ADMIN_A");
  const la = await ledgerKey("ADMIN_A");
  const lb = await ledgerKey("W1");
  const me = (feed.accounts ?? []).find((a: any) => a.id.replace(/^0x/, "") === bytesToHex(la.accountId).replace(/^0x/, ""));
  if (!me) throw new Error("ADMIN_A's ledger account is not in the feed");
  const tx = signQledgerTx({ chainId: NET.chainId, rollupId: ROLLUP, secretKey: la.secretKey, publicKey: la.publicKey, nonce: BigInt(me.nonce), amount: 10_000n, to: lb.accountId });
  const res = await sendNative(A, [postRollupDataMsg({ poster: A.cosmos, rollupId: ROLLUP, data: encodeQledgerTx(tx) })], { gas: 700_000 });
  log(`newest batch ${last.index} was ${ageH.toFixed(1)} h old; posted a 0.01 QOR pulse (nonce ${me.nonce}): ${explorerTx(res.transactionHash)}`);
}

for (;;) {
  await once().catch((e) => log(`failed: ${e?.message ?? e}`));
  if (process.argv.includes("--once")) break;
  await new Promise((r) => setTimeout(r, 6 * 3600_000));
}
