// Withdraw all of ADMIN_A's liquidity shares from the pool named by the deployments file
// (set WICKETGATE_DEPLOYMENTS=deployments/diana-v1.json for the v1 pool).
import { readFileSync } from "node:fs";
import type { Address } from "viem";
import { account, DEPLOYMENTS_FILE } from "@wicketgate/core/env";
import { artifact, closeWindow, openWindow, publicClient, walletFor, windowBudget } from "@wicketgate/core/evm";
async function main() {
  const A = await account("ADMIN_A");
  const pool = JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8")).pool as Address;
  const { abi } = artifact("ExitPool");
  const shares = (await publicClient.readContract({ address: pool, abi, functionName: "shares", args: [A.evm] })) as bigint;
  if (shares === 0n) return console.log(`no shares in ${pool}`);
  await openWindow(A, { blocks: 300, maxTxs: 1, maxValueUqor: await windowBudget(1, 400_000n), allowedTargets: [pool] });
  try {
    const before = await publicClient.getBalance({ address: A.evm as Address });
    const hash = await walletFor(A).writeContract({ address: pool, abi, functionName: "withdraw", args: [shares], gas: 300_000n } as any);
    const rc = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`withdrew all shares from ${pool}: ${rc.status} ${hash}; received about ${Number((await publicClient.getBalance({ address: A.evm as Address })) - before) / 1e18} QOR`);
  } finally {
    await closeWindow(A);
  }
}
main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exitCode = 1; });
