// Watchers add stake: pnpm stake W1=25 W2=25 (each through a window scoped to the registry).
import { readFileSync } from "node:fs";
import type { Address } from "viem";
import { account, DEPLOYMENTS_FILE, type Role } from "@wicketgate/core/env";
import { artifact, closeWindow, openWindow, publicClient, walletFor, windowBudget } from "@wicketgate/core/evm";
async function main() {
  const registry = JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8")).registry as Address;
  const { abi } = artifact("WatcherRegistry");
  for (const kv of process.argv.slice(2)) {
    const [role, q] = kv.split("=");
    const w = await account(role as Role);
    const value = BigInt(Math.round(Number(q) * 1e6)) * 10n ** 12n;
    await openWindow(w, { blocks: 300, maxTxs: 1, maxValueUqor: await windowBudget(1, 300_000n, BigInt(Math.round(Number(q) * 1e6))), allowedTargets: [registry] });
    try {
      const hash = await walletFor(w).writeContract({ address: registry, abi, functionName: "topUp", args: [], value } as any);
      const rc = await publicClient.waitForTransactionReceipt({ hash });
      const free = (await publicClient.readContract({ address: registry, abi, functionName: "freeStake", args: [w.evm] })) as bigint;
      console.log(`${role} topUp ${q} QOR: ${rc.status} ${hash}; free stake now ${Number(free) / 1e18} QOR`);
    } finally {
      await closeWindow(w);
    }
  }
}
main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exitCode = 1; });
