// wicketgate-watcher [--rollup id[,id]|all] [--mode observe|attest|challenge] [--as W1] [--feed dir] [--interval s] [--once]
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Address } from "viem";
import { account, DEPLOYMENTS_FILE, type Role } from "@wicketgate/core/env";
import { Watcher, type Mode } from "./watcher.js";

function arg(name: string, fallback?: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const mode = (arg("mode", "observe") as Mode);
  const rollups = (arg("rollup", "rdk-v328-e2e-mwd5v89d") as string).split(",").map((s) => s.trim()).filter(Boolean);
  const feedDir = resolve(arg("feed", "./feed") as string);
  const interval = Number(arg("interval", "20")) * 1000;
  let me;
  let pool: Address | undefined = arg("pool") as Address | undefined;
  try {
    pool ??= JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8")).pool;
  } catch {}
  if (mode !== "observe") me = await account((arg("as", "W1") as Role));
  const w = new Watcher({ rollups, mode, me, pool, feedDir });
  console.log(`wicketgate watcher: mode=${mode} rollups=${rollups.join(",")} feed=${feedDir}${me ? ` as ${me.evm}` : ""}`);
  for (;;) {
    // a watcher must outlive any network error: log it and try again next round
    await w.round().catch((e) => console.error(`${new Date().toISOString()} round failed: ${e?.shortMessage ?? e?.message ?? e}`));
    if (process.argv.includes("--once")) break;
    await new Promise((r) => setTimeout(r, interval));
  }
}
main().catch((e) => {
  console.error(e?.message ?? e);
  process.exitCode = 1;
});
