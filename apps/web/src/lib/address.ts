// Accept an address as 0x hex or as its qor1 bech32 form (same 20 bytes on QoreChain).
import { getAddress, isAddress, type Address } from "viem";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function polymod(values: number[]): number {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= G[i];
  }
  return chk;
}

function bech32Decode(s: string): { hrp: string; bytes: Uint8Array } | undefined {
  const str = s.toLowerCase();
  const pos = str.lastIndexOf("1");
  if (pos < 1 || pos + 7 > str.length) return undefined;
  const hrp = str.slice(0, pos);
  const data: number[] = [];
  for (const c of str.slice(pos + 1)) {
    const d = CHARSET.indexOf(c);
    if (d === -1) return undefined;
    data.push(d);
  }
  const expand = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
  if (polymod([...expand, ...data]) !== 1) return undefined;
  // 5-bit groups to bytes
  let acc = 0, bits = 0;
  const out: number[] = [];
  for (const v of data.slice(0, -6)) {
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return { hrp, bytes: Uint8Array.from(out) };
}

/** Returns the checksummed EVM address, or undefined if the input is neither form. */
export function parseAddress(input: string): Address | undefined {
  const s = input.trim();
  if (isAddress(s, { strict: false })) return getAddress(s);
  if (/^qor1[a-z0-9]+$/i.test(s)) {
    const d = bech32Decode(s);
    if (d?.hrp === "qor" && d.bytes.length === 20) return getAddress(`0x${[...d.bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`);
  }
  return undefined;
}
