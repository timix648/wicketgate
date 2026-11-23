// A routed instant exit, live, the way the wallet does it: ask every pool serving the rollup (our
// pool and each LaneHub lane) for its fee, pick the cheapest that can pay, withdraw on the rollup to
// that pool's exit address, seal the request to the operator bound to that pool, queue it through
// the live app, and wait until the operator pays it from that pool.
// Usage: npx tsx src/routed-exit-live.ts [rollup] [QOR] [app-url]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { keccak256, toHex, type Address, type Hex } from "viem";
import { postRollupDataMsg, signQledgerTx, encodeQledgerTx, hexToBech32 } from "@qorechain/rdk";
import { account, ledgerKey, NET, STATE_DIR, DEPLOYMENTS_FILE } from "@wicketgate/core/env";
import { sendNative, explorerTx } from "@wicketgate/core/chain";
import { artifact, publicClient } from "@wicketgate/core/evm";
import { sealExitRequest } from "@wicketgate/core/sealed-exit";

const ROLLUP = process.argv[2] ?? "wicketgate-pay";
const AMOUNT = BigInt(Math.round(Number(process.argv[3] ?? "1") * 1e6));
const APP = process.argv[4] ?? "https://wicketgate-psi.vercel.app";
const P = artifact("ExitPool").abi, H = artifact("LaneHub").abi;
const read = <T>(address: Address, functionName: string, args: unknown[] = [], abi: any = P) => publicClient.readContract({ address, abi, functionName, args }) as Promise<T>;

const key = keccak256(toHex(ROLLUP));
const main = JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8")).pool as Address;
const hub = JSON.parse(readFileSync(new URL("lanehub.json", DEPLOYMENTS_FILE), "utf8")).hub as Address;
const pools: Address[] = [main, ...((await read<any[]>(hub, "lanesOf", [key], H)).map((l) => l.pool as Address))];
const wei = AMOUNT * 10n ** 12n;
const quotes = [];
for (const pool of pools) {
  const lane = await read<any[]>(pool, "lanes", [key]);
  if (!lane[5]) continue;
  const [bps, risk, idle] = await Promise.all([read<bigint>(pool, "feeBpsFor", [key, wei]), read<any[]>(pool, "risk", [key]), read<bigint>(pool, "idleLiquidity")]);
  const fee = (wei * bps) / 10_000n + BigInt(risk[4]);
  const ok = fee < wei && wei - fee <= idle && (BigInt(risk[2]) === 0n || wei <= BigInt(risk[2]));
  quotes.push({ pool, fee, ok });
  console.log(`  ${pool === main ? "main pool " : "LaneHub lane"} ${pool}: fee ${Number(fee) / 1e18} QOR${ok ? "" : " (cannot pay now)"}`);
}
const best = quotes.filter((q) => q.ok).sort((a, b) => (a.fee < b.fee ? -1 : 1))[0];
if (!best) throw new Error("no pool can pay this exit now");
console.log(`routed to ${best.pool === main ? "the main pool" : "a LaneHub lane"} ${best.pool} (cheapest of ${quotes.length})`);

const A = await account("ADMIN_A");
const la = await ledgerKey("ADMIN_A");
const nonces = JSON.parse(readFileSync(join(STATE_DIR, "ledger-nonces.json"), "utf8"));
const nk = `${ROLLUP}:0x${Buffer.from(la.accountId).toString("hex")}`;
const nkAlt = Object.keys(nonces).find((k) => k.startsWith(`${ROLLUP}:`) && k.toLowerCase().endsWith(Buffer.from(la.accountId).toString("hex")));
const nonce = BigInt(nonces[nkAlt ?? nk] ?? 0);
const salt = `0x${randomBytes(32).toString("hex")}` as Hex;
const exitAddr = await read<Address>(best.pool, "exitAddressFor", [A.evm, salt]);
const wd = signQledgerTx({ chainId: NET.chainId, rollupId: ROLLUP, secretKey: la.secretKey, publicKey: la.publicKey, nonce, amount: AMOUNT, recipient: hexToBech32(exitAddr, "qor") });
const w = await sendNative(A, [postRollupDataMsg({ poster: A.cosmos, rollupId: ROLLUP, data: encodeQledgerTx(wd) })], { gas: 700_000 });
nonces[nkAlt ?? nk] = (nonce + 1n).toString();
writeFileSync(join(STATE_DIR, "ledger-nonces.json"), JSON.stringify(nonces, null, 2));
console.log(`withdrew ${Number(AMOUNT) / 1e6} QOR to ${exitAddr} (nonce ${nonce}): ${explorerTx(w.transactionHash)}`);

const card = JSON.parse(readFileSync(new URL("../../../cards/security.json", import.meta.url), "utf8"));
const viaApp = ((u: string, i?: RequestInit) => { const m = u.match(/\/qorechain\/pqc\/v1\/(kem|account)\/(\w+)$/)!; return fetch(`${APP}/api/kem/${m[1]}/${m[2]}`, i); }) as typeof fetch;
const sealed = await sealExitRequest({ rest: APP, fetch: viaApp, chainId: NET.chainId, pool: best.pool, card, request: { rollupId: ROLLUP, beneficiary: A.evm, salt, amountUqor: AMOUNT.toString() } });
const q: any = await (await fetch(`${APP}/api/exit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rollupId: ROLLUP, sealed }) })).json();
console.log(`queued sealed request ${q.id} (bound to ${best.pool})`);
for (let i = 0; i < 60; i++) {
  const s: any = await (await fetch(`${APP}/api/exit/${q.id}`)).json();
  if (s.status !== "queued") { console.log(`${new Date().toISOString()} ${JSON.stringify(s)}`); break; }
  await new Promise((r) => setTimeout(r, 30_000));
}
