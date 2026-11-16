// wicketgate-operator --rollup <id> [--as ADMIN_A] [--bond <QOR>] [--interval s] [--once]
// Relay queue settings come from the environment: WICKETGATE_RELAY_URL, WICKETGATE_RELAY_TOKEN.
import { account, type Role } from "@wicketgate/core/env";
import { Operator } from "./operator.js";

function arg(name: string, fallback?: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const rollupId = arg("rollup");
  if (!rollupId) throw new Error("--rollup <id> is required");
  const me = await account((arg("as", "ADMIN_A") as Role));
  const op = new Operator({
    rollupId, me, relayUrl: process.env.WICKETGATE_RELAY_URL, relayToken: process.env.WICKETGATE_RELAY_TOKEN,
  });
  const bond = arg("bond");
  if (bond) await op.bond(BigInt(Math.round(Number(bond) * 1e6)));
  const interval = Number(arg("interval", "20")) * 1000;
  console.log(`wicketgate operator: rollup=${rollupId} as ${me.cosmos}`);
  for (;;) {
    await op.round().catch((e) => console.error(`round failed: ${e?.message ?? e}`));
    if (process.argv.includes("--once")) break;
    await new Promise((r) => setTimeout(r, interval));
  }
}
main().catch((e) => {
  console.error(e?.message ?? e);
  process.exitCode = 1;
});
