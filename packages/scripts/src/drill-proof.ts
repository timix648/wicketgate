// Q-Day Drill proof: one normal hybrid-signed transaction from the drill account (W3),
// a 1 uqor self-transfer. Paste the printed hash on the project page.
import { account } from "./lib/env.js";
import { sendNative, explorerTx } from "./lib/chain.js";

async function main() {
  const w = await account("W3");
  const r = await sendNative(w, [
    { typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { fromAddress: w.cosmos, toAddress: w.cosmos, amount: [{ denom: "uqor", amount: "1" }] } },
  ], { memo: "wicketgate drill proof" });
  console.log(`drill proof tx: ${r.transactionHash}\n${explorerTx(r.transactionHash)}`);
}
main().catch((e) => {
  console.error(e.message ?? e);
  process.exitCode = 1;
});
