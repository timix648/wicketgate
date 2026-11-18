// Q-Day simulation, step 3: deploys ClassicalTwin (contracts/demo, deliberately vulnerable), the
// ecrecover-based design most fast-exit pools and bridges use today, with W4 as its watcher and
// 10 QOR of liquidity. ADMIN_A deploys it through an unscoped window, closed straight after.
// Writes deployments/qday-twin.json. Needs `forge build` (or `forge test`) first.
// Usage: npx tsx src/qday-twin.ts
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { Abi, Hex } from "viem";
import { account, qdayAccount } from "@wicketgate/core/env";
import { closeWindow, openWindow, publicClient, walletFor, windowBudget } from "@wicketgate/core/evm";

const OUT = new URL("../../../deployments/qday-twin.json", import.meta.url);
const LIQ_UQOR = 10_000_000n;

async function main() {
  if (existsSync(OUT)) return console.log(`already deployed: ${JSON.parse(readFileSync(OUT, "utf8")).twin}`);
  const j = JSON.parse(readFileSync(new URL("../../../contracts/out/ClassicalTwin.sol/ClassicalTwin.json", import.meta.url), "utf8"));
  const A = await account("ADMIN_A"), w4 = await qdayAccount("W4");
  await openWindow(A, { blocks: 300, maxTxs: 1, maxValueUqor: await windowBudget(1, 1_500_000n, LIQ_UQOR) });
  try {
    const hash = await walletFor(A).deployContract({ abi: j.abi as Abi, bytecode: j.bytecode.object as Hex, args: [[w4.evm]], value: LIQ_UQOR * 10n ** 12n, gas: 1_500_000n } as any);
    const rc = await publicClient.waitForTransactionReceipt({ hash });
    if (rc.status !== "success" || !rc.contractAddress) throw new Error(`deploy failed: ${hash}`);
    writeFileSync(OUT, JSON.stringify({ twin: rc.contractAddress, deployTx: hash, watcher: w4.evm, liquidityQor: 10, deployedAt: new Date().toISOString(),
      note: "DEMO ONLY: deliberately vulnerable classical (ecrecover) twin of ExitPool for the Q-Day simulation" }, null, 2) + "\n");
    console.log(`ClassicalTwin ${rc.contractAddress} with 10 QOR, watcher W4 ${w4.evm}: ${hash}`);
  } finally {
    await closeWindow(A);
  }
}
main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exitCode = 1; });
