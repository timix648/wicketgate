// Moves test QOR from ADMIN_A (funded by the faucet) to the other roles, then registers
// every role's ML-DSA-87 key with a proof of possession. Safe to rerun.
import { ROLES, account, type Role } from "./lib/env.js";
import { balanceUqor, pqcStatus, registerPqc, sendNative, qor, explorerTx } from "./lib/chain.js";

const TARGET_UQOR: Record<Role, bigint> = {
  ADMIN_A: 0n,
  ADMIN_B: 2_000_000n, // fees only
  W1: 12_000_000n, // 10 QOR stake + fees
  W2: 12_000_000n,
  W3: 12_000_000n,
};

async function main() {
  const funder = await account("ADMIN_A");
  if (!(await pqcStatus(funder.cosmos)).registered) {
    const r = await registerPqc(funder);
    console.log(`ADMIN_A post-quantum key registered: ${explorerTx(r.transactionHash)}`);
  }
  for (const role of ROLES) {
    if (role === "ADMIN_A") continue;
    const a = await account(role);
    const have = await balanceUqor(a.cosmos);
    const want = TARGET_UQOR[role];
    if (have < want) {
      const r = await sendNative(funder, [
        {
          typeUrl: "/cosmos.bank.v1beta1.MsgSend",
          value: { fromAddress: funder.cosmos, toAddress: a.cosmos, amount: [{ denom: "uqor", amount: String(want - have) }] },
        },
      ]);
      console.log(`sent ${qor(want - have)} to ${role}: ${explorerTx(r.transactionHash)}`);
    }
    if (!(await pqcStatus(a.cosmos)).registered) {
      const r = await registerPqc(a);
      console.log(`${role} post-quantum key registered: ${explorerTx(r.transactionHash)}`);
    }
  }
  console.log("Done. Check with: pnpm status");
}
main().catch((e) => {
  console.error(e.message ?? e);
  process.exitCode = 1;
});
