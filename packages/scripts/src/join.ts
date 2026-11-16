// Watchers join the registry named by the deployments file: pnpm join W1=50 W2=200 (default 10 each
// for W1..W3). Each uses a window scoped to the registry with one transaction, closed straight after.
import { readFileSync } from "node:fs";
import type { Address } from "viem";
import { account, DEPLOYMENTS_FILE, type Role } from "@wicketgate/core/env";
import { artifact, closeWindow, openWindow, publicClient, walletFor, windowBudget } from "@wicketgate/core/evm";

async function main() {
  const registry = JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8")).registry as Address;
  const { abi } = artifact("WatcherRegistry");
  const args = process.argv.slice(2).length ? process.argv.slice(2) : ["W1=10", "W2=10", "W3=10"];
  for (const kv of args) {
    const [role, q] = kv.split("=");
    const w = await account(role as Role);
    if (await publicClient.readContract({ address: registry, abi, functionName: "isActive", args: [w.evm] })) {
      console.log(`${role} already active in ${registry}`);
      continue;
    }
    const uq = BigInt(Math.round(Number(q) * 1e6));
    await openWindow(w, { blocks: 300, maxTxs: 1, maxValueUqor: await windowBudget(1, 400_000n, uq), allowedTargets: [registry] });
    try {
      const hash = await walletFor(w).writeContract({ address: registry, abi, functionName: "join", args: [], value: uq * 10n ** 12n, gas: 300_000n } as any);
      const rc = await publicClient.waitForTransactionReceipt({ hash });
      console.log(`${role} joined ${registry} with ${q} QOR: ${rc.status} ${hash}`);
    } finally {
      await closeWindow(w);
    }
  }
}
main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exitCode = 1; });
