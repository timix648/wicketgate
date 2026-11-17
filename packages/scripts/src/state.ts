// Prints ExitPool and WatcherRegistry state: batches per lane, advances, watcher stake. Read-only.
import { readFileSync } from "node:fs";
import { keccak256, toHex, type Address, type Hex } from "viem";
import { DEPLOYMENTS_FILE } from "@wicketgate/core/env";
import { artifact, publicClient } from "@wicketgate/core/evm";
const dep = JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8"));
const P = artifact("ExitPool").abi, R = artifact("WatcherRegistry").abi;
const rd = (address: Address, abi: any, functionName: string, args: unknown[] = []) => publicClient.readContract({ address, abi, functionName, args }) as Promise<any>;
const q = (w: bigint) => (Number(w) / 1e18).toString();
async function main() {
  console.log(`pool: assets ${q(await rd(dep.pool, P, "totalAssets"))} QOR, idle ${q(await rd(dep.pool, P, "idleLiquidity"))}, outstanding ${q(await rd(dep.pool, P, "outstandingWei"))}`);
  for (const id of Object.keys(dep.lanes)) {
    const rk = keccak256(toHex(id));
    for (let i = 0; i < 8; i++) {
      const bk = (await rd(dep.pool, P, "batchKey", [rk, BigInt(i)])) as Hex;
      const b = await rd(dep.pool, P, "getBatch", [bk]);
      if (b[1] === 0n) continue;
      console.log(`  ${id} batch ${i}: confirmed ${new Date(Number(b[1]) * 1000).toISOString()} contested=${b[2]} released=${b[3]} open=${b[4]} cover=${q(b[5])} advanced=${q(b[6])} watchers=${b[7].length}`);
    }
  }
  let exits: any[] = [];
  try { exits = JSON.parse(readFileSync(`${process.env.HOME}/.wicketgate/exits.json`, "utf8")); } catch {} // only on the team's machine
  for (const e of exits) {
    const id = await rd(dep.pool, P, "advanceOfExit", [e.exitAddr]);
    if (/^0x0+$/.test(id)) { console.log(`  exit ${e.exitAddr} (${e.rollupId}): no advance`); continue; }
    const a = await rd(dep.pool, P, "advances", [id]);
    console.log(`  exit ${e.exitAddr} (${e.rollupId}): advance ${id.slice(0, 10)} state ${a[8]} (2 = settled) amount ${q(a[2])} fee ${q(a[3])}; exit balance ${q(await publicClient.getBalance({ address: e.exitAddr }))}`);
  }
  for (const w of ["0xe754DfBe7C4C4061D089B8e262f6F4C36e563bC0", "0x65261E42C226E4A34256F5f144aE2Ea63Db5BaE4", "0xAC82Ffe5610f14d09eF451E5c71254Be9164cc88"]) {
    const s = await rd(dep.registry, R, "watchers", [w]);
    console.log(`  watcher ${w.slice(0, 10)}: stake ${q(s[0])} locked ${q(s[1])} active ${s[3]} credit ${q(await rd(dep.pool, P, "watcherCredit", [w]))}`);
  }
}
main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exitCode = 1; });
