// Withdraw ADMIN_A's liquidity shares from the pool named by the deployments file
// (set WICKETGATE_DEPLOYMENTS=deployments/diana-v1.json for the v1 pool).
// Usage: npx tsx src/lp-withdraw.ts [percent of shares, default 100]: less than 100 when part of
// the pool is still out on advances, since only idle liquidity can be withdrawn.
import { readFileSync } from "node:fs";
import type { Address } from "viem";
import { account, DEPLOYMENTS_FILE } from "@wicketgate/core/env";
import { artifact, closeWindow, openWindow, publicClient, walletFor, windowBudget } from "@wicketgate/core/evm";
async function main() {
  const A = await account("ADMIN_A");
  const pool = JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8")).pool as Address;
  const { abi } = artifact("ExitPool");
  const all = (await publicClient.readContract({ address: pool, abi, functionName: "shares", args: [A.evm] })) as bigint;
  const pct = BigInt(Math.round(Number(process.argv[2] ?? "100") * 100));
  const shares = (all * pct) / 10_000n;
  if (shares === 0n) return console.log(`no shares in ${pool}`);
  await openWindow(A, { blocks: 300, maxTxs: 1, maxValueUqor: await windowBudget(1, 400_000n), allowedTargets: [pool] });
  try {
    const before = await publicClient.getBalance({ address: A.evm as Address });
    const hash = await walletFor(A).writeContract({ address: pool, abi, functionName: "withdraw", args: [shares], gas: 300_000n } as any);
    const rc = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`withdrew ${Number(pct) / 100}% of ADMIN_A's shares from ${pool}: ${rc.status} ${hash}; received about ${Number((await publicClient.getBalance({ address: A.evm as Address })) - before) / 1e18} QOR`);
  } finally {
    await closeWindow(A);
  }
}
main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exitCode = 1; });
