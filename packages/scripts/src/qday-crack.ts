// Q-Day simulation, step 2: the attacker breaks a watcher's classical key from public chain data.
// Input: an address. The script reads the account's secp256k1 public key from the chain (any account
// that has signed a transaction has published it) and solves the discrete logarithm with
// baby-step giant-step. The key is 40 bits, so an ordinary computer finishes in seconds; the 40-bit
// bound stands in for Shor's algorithm, which would do the same to a full 256-bit key on a large
// enough quantum computer. This script reads NO key file: only the public REST endpoint.
// Prints the recovered private key (it is a throwaway testnet key made weak on purpose) and writes
// it to a file for the next step. Usage: npx tsx src/qday-crack.ts <qor1… address> [out-file]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1";
import { politeFetch } from "@wicketgate/core/polite";

const REST = process.env.QORE_REST ?? "https://api-testnet.qore.host";
const P = secp256k1.ProjectivePoint;
const LO = 1n << 39n, BITS = 40n; // the attacker's search range: [2^39, 2^40)
const M = 1 << 20; // baby steps
const CHUNK = 4096;
const key48 = (x: bigint) => Number(x & 0xffffffffffffn);

async function main() {
  const address = process.argv[2];
  const out = process.argv[3] ?? `${process.env.HOME}/.wicketgate/qday-cracked.json`;
  if (!address?.startsWith("qor1")) throw new Error("usage: qday-crack.ts <qor1… address> [out-file]");
  const res = await politeFetch(`${REST}/cosmos/auth/v1beta1/accounts/${address}`);
  const body: any = await res.json();
  const pkB64 = body?.account?.pub_key?.key;
  if (!pkB64) throw new Error(`${address} has not published a public key yet`);
  const pubHex = Buffer.from(pkB64, "base64").toString("hex");
  const Q = P.fromHex(pubHex);
  console.log(`target ${address}`);
  console.log(`public key from chain: 0x${pubHex} (account sequence ${body.account.sequence})`);
  console.log(`searching [2^39, 2^40) with baby-step giant-step: ${M.toLocaleString("en")} baby steps, up to ${(Number(LO) / M).toLocaleString("en")} giant steps`);
  const t0 = performance.now();

  // baby steps: table of x(j·G) for j in [0, M)
  const table = new Map<number, number>();
  let cur = P.ZERO;
  for (let j = 0; j < M; j += CHUNK) {
    const batch: InstanceType<typeof P>[] = [];
    for (let i = 0; i < CHUNK; i++) { batch.push(cur); cur = cur.add(P.BASE); }
    const aff = P.normalizeZ(batch);
    for (let i = 0; i < CHUNK; i++) if (j + i > 0) table.set(key48(aff[i].x), j + i);
  }
  const t1 = performance.now();

  // giant steps: Q − LO·G − i·M·G, looked up in the table
  const step = P.BASE.multiply(BigInt(M)).negate();
  let g = Q.add(P.BASE.multiply(LO).negate());
  let found: bigint | undefined;
  const giants = Number(LO) / M;
  outer: for (let i = 0; i < giants; i += CHUNK) {
    const batch: InstanceType<typeof P>[] = [];
    for (let k = 0; k < CHUNK; k++) { batch.push(g); g = g.add(step); }
    const aff = P.normalizeZ(batch);
    for (let k = 0; k < CHUNK; k++) {
      if (aff[k].equals(P.ZERO)) { found = LO + BigInt(i + k) * BigInt(M); break outer; }
      const j = table.get(key48(aff[k].x));
      if (j === undefined) continue;
      for (const cand of [LO + BigInt(i + k) * BigInt(M) + BigInt(j), LO + BigInt(i + k) * BigInt(M) - BigInt(j)]) {
        if (cand > 0n && P.BASE.multiply(cand).equals(Q)) { found = cand; break outer; }
      }
    }
  }
  const t2 = performance.now();
  if (found === undefined) throw new Error("not found in range");
  const priv = `0x${found.toString(16).padStart(64, "0")}`;
  console.log(`\nPRIVATE KEY RECOVERED in ${((t2 - t0) / 1000).toFixed(1)} s (table ${((t1 - t0) / 1000).toFixed(1)} s, search ${((t2 - t1) / 1000).toFixed(1)} s)`);
  console.log(`  ${priv}  (${BITS}-bit; checks: k·G equals the on-chain public key)`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ address, publicKey: `0x${pubHex}`, privateKey: priv, seconds: Number(((t2 - t0) / 1000).toFixed(1)), at: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
  console.log(`written to ${out}`);
}
main().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
