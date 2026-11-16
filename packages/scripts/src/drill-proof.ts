// Q-Day Drill proof: a normal project action from the drill account (W3), hybrid-signed on the
// native lane so no EVM window is ever opened: W3 deposits 0.5 QOR into its own ledger account on
// the wicketgate-pay rollup. Paste the printed hash on the project page (accepted until 19 Nov).
// Falls back to a 1 uqor self-transfer if the deposit fails.
import { depositToRollupMsg, bytesToHex } from "@qorechain/rdk";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { account, ledgerKey, STATE_DIR } from "@wicketgate/core/env";
import { sendNative, explorerTx, accountSeq } from "@wicketgate/core/chain";

/** Tell the drill monitor that this sequence is ours, so it does not report it as an attack. */
async function markOurs(address: string) {
  const seq = await accountSeq(address);
  if (!seq) return;
  mkdirSync(join(STATE_DIR, "drill"), { recursive: true });
  appendFileSync(join(STATE_DIR, "drill", "our-txs.txt"), `${seq.sequence + 1}\n`);
}

async function main() {
  const w = await account("W3");
  const l = await ledgerKey("W3");
  await markOurs(w.cosmos);
  try {
    const r = await sendNative(w, [depositToRollupMsg({ depositor: w.cosmos, rollupId: "wicketgate-pay", account: l.accountId, amount: "500000" })], { gas: 500_000, memo: "wicketgate drill proof" });
    console.log(`drill proof: W3 deposited 0.5 QOR into wicketgate-pay (ledger ${bytesToHex(l.accountId).slice(0, 16)}…)\ntx ${r.transactionHash}\n${explorerTx(r.transactionHash)}`);
  } catch (e: any) {
    console.log(`deposit failed (${e?.message}); sending a self-transfer instead`);
    const r = await sendNative(w, [{ typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { fromAddress: w.cosmos, toAddress: w.cosmos, amount: [{ denom: "uqor", amount: "1" }] } }], { memo: "wicketgate drill proof" });
    console.log(`drill proof tx ${r.transactionHash}\n${explorerTx(r.transactionHash)}`);
  }
}
main().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
