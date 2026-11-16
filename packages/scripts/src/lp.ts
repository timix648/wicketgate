// Add liquidity to the ExitPool from ADMIN_A: pnpm lp <QOR>
import { readFileSync } from "node:fs";
import type { Address } from "viem";
import { account, DEPLOYMENTS_FILE } from "@wicketgate/core/env";
import { artifact, closeWindow, openWindow, publicClient, walletFor, windowBudget } from "@wicketgate/core/evm";
async function main() {
  const q = Number(process.argv[2] ?? "100");
  const A = await account("ADMIN_A");
  const pool = JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8")).pool as Address;
  const { abi } = artifact("ExitPool");
  await openWindow(A, { blocks: 300, maxTxs: 1, maxValueUqor: await windowBudget(1, 300_000n, BigInt(Math.round(q * 1e6))), allowedTargets: [pool] });
  try {
    const hash = await walletFor(A).writeContract({ address: pool, abi, functionName: "deposit", args: [], value: BigInt(Math.round(q * 1e6)) * 10n ** 12n } as any);
    const rc = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`deposit ${q} QOR: ${rc.status} ${hash}; pool assets now ${Number(await publicClient.readContract({ address: pool, abi, functionName: "totalAssets", args: [] })) / 1e18} QOR`);
  } finally {
    await closeWindow(A);
  }
}
main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exitCode = 1; });
