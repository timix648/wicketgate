// Probe: adversarially fuzz the ML-DSA-87 verify precompile (0x0A01) that every Wicketgate
// attestation and admin action depends on. Read-only eth_call; no key stored, no funds needed.
// Two batteries: (1) content/malleability/cross-key/length attacks through the typed ABI, and
// (2) hand-crafted malformed calldata (lying length fields, out-of-bounds offsets, aliasing,
// truncation). A pass means the precompile never returns true for anything but a genuine valid
// signature. Usage: npx tsx src/probe-pqcfuzz.ts
import { randomBytes } from "node:crypto";
import { mldsa87 } from "@qorechain/pqc";
import { createPublicClient, http, keccak256, parseAbi, toBytes, toHex, type Hex } from "viem";
const client = createPublicClient({ transport: http(process.env.QORE_EVM ?? "https://evm-testnet.qore.host") });
const VERIFY = "0x0000000000000000000000000000000000000a01";
const ABI = parseAbi(["function pqcVerify(bytes pubkey, bytes signature, bytes message) view returns (bool)"]);
const SEL = keccak256(toBytes("pqcVerify(bytes,bytes,bytes)")).slice(0, 10);
const cat = (...xs: Uint8Array[]) => { const o = new Uint8Array(xs.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of xs) { o.set(x, i); i += x.length; } return o; };
const flip = (b: Uint8Array, i: number) => { const c = Uint8Array.from(b); c[i] ^= 1; return c; };
const u256 = (n: bigint | number) => { const b = new Uint8Array(32); let v = BigInt(n); for (let i = 31; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; };
const pad32 = (b: Uint8Array) => { const o = new Uint8Array(Math.ceil(b.length / 32) * 32); o.set(b); return o; };

const kp = mldsa87.keygen(randomBytes(32)), kp2 = mldsa87.keygen(randomBytes(32));
const msg = randomBytes(96), sig = mldsa87.sign(kp.secretKey, msg);
const sig2 = mldsa87.sign(kp.secretKey, randomBytes(96));

const typed = async (pk: Uint8Array, s: Uint8Array, m: Uint8Array) => {
  try { return await client.readContract({ address: VERIFY, abi: ABI, functionName: "pqcVerify", args: [toHex(pk), toHex(s), toHex(m)] }) as boolean; }
  catch (e: any) { return "REVERT"; }
};
const raw = async (data: Hex) => {
  try { const r = await client.call({ to: VERIFY, data }); return r.data && BigInt(r.data) === 1n ? true : false; }
  catch { return "REVERT"; }
};
function build(o: { pkLen?: number; sigLen?: number; msgLen?: number; pkOff?: bigint; sigOff?: bigint; msgOff?: bigint }) {
  const pkB = cat(u256(o.pkLen ?? kp.publicKey.length), pad32(kp.publicKey));
  const sgB = cat(u256(o.sigLen ?? sig.length), pad32(sig));
  const msB = cat(u256(o.msgLen ?? msg.length), pad32(msg));
  const pkOff = o.pkOff ?? 96n, sgOff = o.sigOff ?? BigInt(96 + pkB.length), msOff = o.msgOff ?? BigInt(96 + pkB.length + sgB.length);
  return toHex(cat(toBytes(SEL), u256(pkOff), u256(sgOff), u256(msOff), pkB, sgB, msB));
}
async function main() {
  let fail = 0, n = 0;
  const check = (name: string, got: any, okTrue: boolean) => {
    n++; const bad = got === true && !okTrue; if (bad) fail++;
    console.log(`${bad ? "!! FORGERY" : "ok       "} ${name.padEnd(30)} -> ${got}`);
  };
  // battery 1: typed
  check("valid", await typed(kp.publicKey, sig, msg), true);
  check("msg bit flipped", await typed(kp.publicKey, sig, flip(msg, 5)), false);
  check("sig bit flipped", await typed(kp.publicKey, flip(sig, 5), msg), false);
  check("sig zeros", await typed(kp.publicKey, new Uint8Array(4627), msg), false);
  check("sig random", await typed(kp.publicKey, randomBytes(4627), msg), false);
  check("sig +32 trailing", await typed(kp.publicKey, cat(sig, new Uint8Array(32)), msg), false);
  check("sig truncated", await typed(kp.publicKey, sig.subarray(0, 4626), msg), false);
  check("sig of other msg", await typed(kp.publicKey, sig2, msg), false);
  check("sig vs other key", await typed(kp2.publicKey, sig, msg), false);
  check("key zeros", await typed(new Uint8Array(2592), sig, msg), false);
  check("msg +trailing", await typed(kp.publicKey, sig, cat(msg, new Uint8Array(1))), false);
  // battery 2: raw calldata
  check("raw valid", await raw(build({})), true);
  check("raw msgLen=0", await raw(build({ msgLen: 0 })), false);
  check("raw sigLen=0", await raw(build({ sigLen: 0 })), false);
  check("raw sigLen=4626", await raw(build({ sigLen: 4626 })), false);
  check("raw pkOff oob", await raw(build({ pkOff: 0xffffffffn })), false);
  check("raw sigOff oob", await raw(build({ sigOff: 0xffffffffffffffffn })), false);
  check("raw offsets=0", await raw(build({ pkOff: 0n, sigOff: 0n, msgOff: 0n })), false);
  console.log(fail === 0 ? `\nRESULT: ${n} adversarial vectors, 0 forgeries — pqcVerify accepts only genuine ML-DSA-87 signatures` : `\nRESULT: ${fail} FORGERIES of ${n}`);
  process.exitCode = fail === 0 ? 0 : 1;
}
main().catch((e) => { console.error(e?.shortMessage ?? e?.message ?? e); process.exitCode = 2; });
