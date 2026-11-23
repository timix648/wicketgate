// wicketgate-watcher [--lanes deployments/lanes] [--rollup id[,id]|all] [--mode observe|attest|challenge] [--as W1] [--feed dir] [--interval s] [--reader rdk|independent] [--once]
import { readFileSync, readdirSync } from "node:fs";
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
  // --lanes <dir>: attest each rollup to its own LaneHub lane (deployments/lanes/<rollup>.json)
  const lanesDir = arg("lanes");
  const pools: Record<string, Address> = {};
  if (lanesDir) for (const f of readdirSync(lanesDir).filter((x) => x.endsWith(".json"))) {
    const d = JSON.parse(readFileSync(resolve(lanesDir, f), "utf8"));
    for (const id of Object.keys(d.lanes ?? {})) pools[id] = d.pool;
  }
  const rollups = (arg("rollup", lanesDir ? Object.keys(pools).join(",") : "rdk-v328-e2e-mwd5v89d") as string).split(",").map((s) => s.trim()).filter(Boolean);
  const feedDir = resolve(arg("feed", "./feed") as string);
  const interval = Number(arg("interval", "20")) * 1000;
  let me;
  let pool: Address | undefined = arg("pool") as Address | undefined;
  try {
    pool ??= JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8")).pool;
  } catch {}
  if (mode !== "observe") me = await account(arg("as", "W1") as string);
  const reader = (arg("reader", "rdk") as "rdk" | "independent");
  if (reader !== "rdk" && reader !== "independent") throw new Error("--reader must be rdk or independent");
  const w = new Watcher({ rollups, mode, me, pool: lanesDir ? undefined : pool, ...(lanesDir ? { pools } : {}), feedDir, reader });
  console.log(`wicketgate watcher: mode=${mode} reader=${reader} rollups=${rollups.join(",")} feed=${feedDir}${me ? ` as ${me.evm}` : ""}`);
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
