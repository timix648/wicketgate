// Watchers ask to leave the registry named by the deployments file (stake returns after the
// leave delay with `pnpm leave --finish`). Usage: pnpm leave W1 W2 W3 [--finish]
import { readFileSync } from "node:fs";
import type { Address } from "viem";
import { account, DEPLOYMENTS_FILE, type Role } from "@wicketgate/core/env";
import { artifact, closeWindow, openWindow, publicClient, walletFor, windowBudget } from "@wicketgate/core/evm";
async function main() {
  const finish = process.argv.includes("--finish");
  const registry = JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8")).registry as Address;
  const { abi } = artifact("WatcherRegistry");
  for (const role of process.argv.slice(2).filter((a) => !a.startsWith("--"))) {
    const w = await account(role as Role);
    const s = (await publicClient.readContract({ address: registry, abi, functionName: "watchers", args: [w.evm] })) as any[];
    if (finish ? s[0] === 0n : !s[3]) { console.log(`${role}: nothing to do in ${registry}`); continue; }
    await openWindow(w, { blocks: 300, maxTxs: 1, maxValueUqor: await windowBudget(1, 300_000n), allowedTargets: [registry] });
    try {
      const hash = await walletFor(w).writeContract({ address: registry, abi, functionName: finish ? "leave" : "requestLeave", args: [], gas: 200_000n } as any);
      const rc = await publicClient.waitForTransactionReceipt({ hash });
      console.log(`${role} ${finish ? "left" : "asked to leave"} ${registry}: ${rc.status} ${hash}`);
    } finally {
      await closeWindow(w);
    }
  }
}
main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exitCode = 1; });
