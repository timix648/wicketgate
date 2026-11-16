// Each watcher joins the registry with a 10 QOR stake, through a window scoped to the
// registry alone, which is closed straight after.
import { readFileSync } from "node:fs";
import type { Address } from "viem";
import { account, DEPLOYMENTS_FILE, type Role } from "@wicketgate/core/env";
import { artifact, closeWindow, openWindow, publicClient, walletFor, windowBudget } from "@wicketgate/core/evm";

const STAKE = 10n * 10n ** 18n;

async function main() {
  const dep = JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8"));
  const registry = dep.registry as Address;
  const { abi } = artifact("WatcherRegistry");
  for (const role of ["W1", "W2", "W3"] as Role[]) {
    const w = await account(role);
    const active = await publicClient.readContract({ address: registry, abi, functionName: "isActive", args: [w.evm] });
    if (active) {
      console.log(`${role} already active`);
      continue;
    }
    console.log(`${role} ${w.evm}`);
    await openWindow(w, { blocks: 300, maxTxs: 1, maxValueUqor: await windowBudget(1, 400_000n, 10_000_000n), allowedTargets: [registry] });
    try {
      const hash = await walletFor(w).writeContract({ address: registry, abi, functionName: "join", args: [], value: STAKE } as any);
      const rc = await publicClient.waitForTransactionReceipt({ hash });
      console.log(`  join: ${rc.status} tx ${hash}`);
    } finally {
      await closeWindow(w);
    }
  }
}
main().catch((e) => {
  console.error(e.shortMessage ?? e.message ?? e);
  process.exitCode = 1;
});
