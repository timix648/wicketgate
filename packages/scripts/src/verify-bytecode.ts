// Shows that the contracts deployed on diana are exactly the source in this repository. The
// QoreChain explorer has no source verification, so this compares the runtime code on chain
// with `forge build` output (solc 0.8.24, optimizer 200 runs, EVM paris), after filling in each
// contract's immutables, which only exist after deployment. Needs `forge build` first.
// It also confirms the runtime code contains the PQC precompile addresses (0x...0a01, 0x...0a02).
// Usage: npx tsx src/verify-bytecode.ts
import { readFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import { DEPLOYMENTS_FILE } from "@wicketgate/core/env";
import { publicClient } from "@wicketgate/core/evm";

const dep = JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8"));
const CONTRACTS: [string, Address][] = [
  ["WatcherRegistry", dep.registry], ["ExitPool", dep.pool], ["Directory", dep.directory], ["MemoBoard", dep.memoBoard],
];

async function main() {
  let ok = true;
  for (const [name, address] of CONTRACTS) {
    const j = JSON.parse(readFileSync(new URL(`../../../contracts/out/${name}.sol/${name}.json`, import.meta.url), "utf8"));
    const built = (j.deployedBytecode.object as string).replace(/^0x/, "").toLowerCase();
    const onChain = ((await publicClient.getCode({ address })) ?? "0x").replace(/^0x/, "").toLowerCase();
    // copy the on-chain bytes into the immutable slots of the built code, then compare everything else
    const refs = Object.values(j.deployedBytecode.immutableReferences ?? {}).flat() as { start: number; length: number }[];
    let filled = built;
    for (const r of refs) filled = filled.slice(0, r.start * 2) + onChain.slice(r.start * 2, (r.start + r.length) * 2) + filled.slice((r.start + r.length) * 2);
    // the metadata hash at the end depends on file paths; compare up to it
    const cbor = (code: string) => code.slice(0, code.length - (parseInt(code.slice(-4), 16) + 2) * 2);
    const match = cbor(filled) === cbor(onChain);
    const pqc = name === "Directory" || name === "MemoBoard" ? "n/a" : /610a01|610a02/.test(onChain) ? "present" : "MISSING";
    console.log(`${name.padEnd(16)} ${address}  runtime ${onChain.length / 2} bytes  matches source: ${match ? "YES" : "NO"}  PQC precompile addresses in code: ${pqc}  (${refs.length} immutable slots)`);
    ok &&= match;
  }
  console.log(ok ? "RESULT: the deployed contracts are this source" : "RESULT: mismatch");
  if (!ok) process.exitCode = 1;
}
main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exitCode = 1; });
