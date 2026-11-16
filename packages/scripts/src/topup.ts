// Moves test QOR from ADMIN_A to other roles. Usage: pnpm topup ROLE=QOR [ROLE=QOR ...]
import { account, type Role } from "@wicketgate/core/env";
import { sendNative, explorerTx } from "@wicketgate/core/chain";
async function main() {
  const A = await account("ADMIN_A");
  const msgs = [];
  for (const kv of process.argv.slice(2)) {
    const [role, q] = kv.split("=");
    const to = await account(role as Role);
    msgs.push({ typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { fromAddress: A.cosmos, toAddress: to.cosmos, amount: [{ denom: "uqor", amount: String(Math.round(Number(q) * 1e6)) }] } });
    console.log(`  ${role} +${q} QOR`);
  }
  const r = await sendNative(A, msgs, { gas: 200_000 + 100_000 * msgs.length });
  console.log(`sent: ${explorerTx(r.transactionHash)}`);
}
main().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
