// Queue the newest saved exit (from pnpm seed) through the LIVE app as a sealed request, the way
// the wallet does: sealed to the exit operator's ML-KEM-1024 key via the app's KEM relay, posted
// to /api/exit, then followed until the operator pays it. Usage: npx tsx src/sealed-exit-live.ts [app-url]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NET, STATE_DIR, DEPLOYMENTS_FILE } from "@wicketgate/core/env";
import { sealExitRequest } from "@wicketgate/core/sealed-exit";

const APP = process.argv[2] ?? "https://wicketgate-psi.vercel.app";
const card = JSON.parse(readFileSync(new URL("../../../cards/security.json", import.meta.url), "utf8"));
const pool = JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8")).pool as string;
const ex = JSON.parse(readFileSync(join(STATE_DIR, "exits.json"), "utf8")).at(-1);
const viaApp = ((u: string, i?: RequestInit) => { const m = u.match(/\/qorechain\/pqc\/v1\/(kem|account)\/(\w+)$/)!; return fetch(`${APP}/api/kem/${m[1]}/${m[2]}`, i); }) as typeof fetch;

const sealed = await sealExitRequest({ rest: APP, fetch: viaApp, chainId: NET.chainId, pool, card, request: { rollupId: ex.rollupId, beneficiary: ex.beneficiary, salt: ex.salt, amountUqor: ex.amountUqor } });
const res = await fetch(`${APP}/api/exit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rollupId: ex.rollupId, sealed }) });
const q: any = await res.json();
console.log(`POST /api/exit -> ${res.status} ${JSON.stringify(q)}  (sent ${sealed.length} chars of ciphertext; exit address ${ex.exitAddr})`);
if (!q.id) process.exit(1);
for (let i = 0; i < 180; i++) {
  const s: any = await (await fetch(`${APP}/api/exit/${q.id}`)).json();
  if (s.status !== "queued") { console.log(`${new Date().toISOString()} ${JSON.stringify(s)}`); break; }
  if (i % 10 === 0) console.log(`${new Date().toISOString()} still queued`);
  await new Promise((r) => setTimeout(r, 30_000));
}
