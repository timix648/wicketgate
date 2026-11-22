// Probe: read a real wrapped inbox post three ways, live on the chain. No key, no funds.
//
// wicketgate-pay inbox entry 43 (19 Nov 2026) is a valid post wrapped in an authz MsgExec. It is the
// entry behind the forged batch 12 that finalised unchallenged, because the RDK's fetcher cannot
// see a wrapped post. This probe reads entries 42..44 with:
//   1. the RDK fetcher as shipped          -> expected to fail ("payload could not be matched")
//   2. the RDK fetcher through robustRest  -> what Wicketgate's main watchers run
//   3. the independent reader              -> recovers each payload by its committed hash
// and checks that 2 and 3 return byte-identical entries that match the chain's inbox accumulator.
// Usage: npx tsx src/probe-blind.ts [rollup] [from] [to]
import { RestClient, fetchQledgerEntries, postedDataHash } from "@qorechain/rdk";
import { NET } from "@wicketgate/core/env";
import { robustRest } from "@wicketgate/core/robust-rest";
import { fetchEntriesIndependent } from "@wicketgate/core/independent-entries";

const [rollupId = "wicketgate-pay", fromArg = "42", toArg = "44"] = process.argv.slice(2);
const from = Number(fromArg), to = Number(toArg);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

async function main() {
  const plain = new RestClient(NET.rest);
  const accFrom = (await plain.getPostedData(rollupId, from)).inboxAcc;
  const input = { chainId: NET.chainId, rollupId, from, to, accFrom };
  console.log(`reading ${rollupId} inbox entries ${from + 1}..${to}`);

  let rdkOk = false;
  try { await fetchQledgerEntries(new RestClient(NET.rest), input); rdkOk = true; console.log("1. RDK fetcher as shipped:     read them (no wrapped post in this range)"); }
  catch (e: any) { console.log(`1. RDK fetcher as shipped:     BLIND -> ${String(e?.message ?? e).slice(0, 110)}`); }

  const viaRobust = await fetchQledgerEntries(robustRest(new RestClient(NET.rest)), input);
  console.log(`2. RDK fetcher + robustRest:   read ${viaRobust.length} entries, accumulator matches the chain`);
  const viaIndependent = await fetchEntriesIndependent(new RestClient(NET.rest), input);
  console.log(`3. independent reader:         read ${viaIndependent.length} entries, accumulator matches the chain`);

  const same = viaRobust.length === viaIndependent.length && viaRobust.every((e, i) => hex(e.payload) === hex(viaIndependent[i].payload) && e.poster === viaIndependent[i].poster && e.height === viaIndependent[i].height);
  for (const [i, e] of viaIndependent.entries()) console.log(`   entry ${from + 1 + i}: ${e.payload.length} bytes, sha256 ${hex(postedDataHash(e.payload)).slice(0, 16)}..., poster ${e.poster}, height ${e.height}`);
  console.log(same ? "RESULT: both Wicketgate readers return identical entries; the RDK fetcher as shipped " + (rdkOk ? "also read them" : "is blind to this range") : "RESULT: MISMATCH between the two readers");
  process.exitCode = same ? 0 : 1;
}
main().catch((e) => { console.error("probe failed:", e?.message ?? e); process.exitCode = 2; });
