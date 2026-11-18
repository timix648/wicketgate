// Q-Day simulation: the victim's routine. A watcher has to open EVM authorisation windows to do its
// job (Wicketgate's watchers open one, scoped to the pool, every round they attest). This opens such
// a window for W4, signed with W4's real ML-DSA-87 key, scoped to the pools it watches
// (ClassicalTwin and Wicketgate's ExitPool) and to a few transactions; `close` closes it.
// Usage: npx tsx src/qday-routine.ts open|close
import { readFileSync } from "node:fs";
import { qdayAccount, DEPLOYMENTS_FILE } from "@wicketgate/core/env";
import { closeWindow, openWindow } from "@wicketgate/core/evm";

async function main() {
  const w4 = await qdayAccount("W4");
  if (process.argv[2] === "close") return closeWindow(w4);
  const pool = JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8")).pool;
  const twin = JSON.parse(readFileSync(new URL("../../../deployments/qday-twin.json", import.meta.url), "utf8")).twin;
  console.log("W4's routine window, scoped to the pools it watches:");
  await openWindow(w4, { blocks: 300, maxTxs: 4, maxValueUqor: 500_000n, allowedTargets: [twin, pool] });
}
main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exitCode = 1; });
