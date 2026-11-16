// Prints each role's addresses, balance and post-quantum key status. Read-only.
import { ROLES, account } from "./lib/env.js";
import { balanceUqor, pqcStatus, qor } from "./lib/chain.js";

async function main() {
  for (const role of ROLES) {
    const a = await account(role);
    const [bal, pq] = await Promise.all([balanceUqor(a.cosmos), pqcStatus(a.cosmos)]);
    console.log(
      `${role.padEnd(8)} ${a.cosmos} ${a.evm}  ${qor(bal).padStart(16)}  pq key: ${
        pq.registered ? (pq.proven ? "registered, proven" : "registered, NOT proven") : "not registered"
      }`,
    );
  }
}
main().catch((e) => {
  console.error(e.message ?? e);
  process.exitCode = 1;
});
