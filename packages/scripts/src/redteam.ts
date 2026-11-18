// Red team: replays attacks against the live ExitPool v2.1 and WatcherRegistry on diana and shows
// that each one is refused, and by which check. Every attack is an eth_call (nothing is sent, no
// key is needed), and most run against the pool's exact state at the block of a real exit, using
// the real signatures, facts, proofs and salts read back from those transactions. Anyone can re-run it.
// Writes docs/redteam.json and docs/REDTEAM.md. Exits non-zero if any attack is not refused.
// Usage: npx tsx src/redteam.ts
import { readFileSync, writeFileSync } from "node:fs";
import { decodeFunctionData, parseEventLogs, keccak256, toHex, type Address, type Hex } from "viem";
import { artifact, publicClient } from "@wicketgate/core/evm";

const ROOT = new URL("../../../", import.meta.url);
const dep = JSON.parse(readFileSync(new URL("deployments/diana.json", ROOT), "utf8"));
const P = artifact("ExitPool").abi, R = artifact("WatcherRegistry").abi;
const pool = dep.pool as Address, registry = dep.registry as Address;
const ATTACKER = "0xbad0000000000000000000000000000000000bad" as Address;
const PAY = keccak256(toHex("wicketgate-pay")), VIGIL = keccak256(toHex("vigil-1"));
// two real instant exits on pool v2.1 (see PROOF.md): one long settled, one taken from another team's rollup
const PAY_EXIT = "0xa4e4fd21cceb52815c7461eb267e2725332ccc1e176c4ddae03bf56465004a54" as Hex;
const VIGIL_EXIT = "0x4e0914e3727930742de619e2394d4fdd84cf186523d4e760e1e6b17c2740f811" as Hex;

async function txArgs(hash: Hex) {
  const [tx, rc] = await Promise.all([publicClient.getTransaction({ hash }), publicClient.getTransactionReceipt({ hash })]);
  const d = decodeFunctionData({ abi: P, data: tx.input });
  return { fn: d.functionName, args: d.args as any[], from: tx.from, block: rc.blockNumber, logs: rc.logs };
}

async function logs(abi: any, address: Address, from: bigint, to: bigint) {
  const out: any[] = [];
  for (let a = from; a <= to; a += 10_000n) {
    const raw = await publicClient.getLogs({ address, fromBlock: a, toBlock: a + 9_999n > to ? to : a + 9_999n });
    out.push(...parseEventLogs({ abi, logs: raw }));
  }
  return out;
}

type Attack = { id: string; threat: string; who: string; at: string; expect: string; run: () => Promise<unknown> };

function errorName(e: any): string {
  for (let c = e; c; c = c.cause) {
    if (c.data?.errorName) return c.data.errorName === "Panic" ? `Panic(${c.data.args?.[0]})` : c.data.errorName;
    if (c.reason) return c.reason;
  }
  return (e.shortMessage ?? e.message ?? String(e)).split("\n")[0];
}

async function main() {
  const latest = await publicClient.getBlockNumber();
  const pay = await txArgs(PAY_EXIT);
  const vig = await txArgs(VIGIL_EXIT);
  const [, payIndex, payFacts, wIndex, beneficiary, salt, amountUqor, proof] = pay.args;
  const [, vigIndex, , , vBeneficiary, vSalt] = vig.args;
  const vigId = (parseEventLogs({ abi: P, logs: vig.logs, eventName: "InstantExit" })[0] as any).args.id as Hex;
  const vigKey = (await publicClient.readContract({ address: pool, abi: P, functionName: "batchKey", args: [VIGIL, vigIndex] })) as Hex;

  // a real ML-DSA-87 attestation for wicketgate-pay batch `payIndex`, read back from chain
  const att = (await logs(P, pool, pay.block - 9_000n, pay.block)).filter((l: any) => l.eventName === "Attested" && l.args.rollupKey === PAY && l.args.batchIndex === payIndex);
  const real = await txArgs(att[0].transactionHash);
  const [, , realFacts, realSig] = real.args;
  const watcher = real.from;

  // a real two-admin setLane, read back from chain
  const laneSet = (await logs(P, pool, 10_212_000n, pay.block)).find((l: any) => l.eventName === "LaneSet" && l.args.rollupKey === PAY);
  const sl = await txArgs(laneSet.transactionHash);

  const before = pay.block - 1n; // the block before the real 3 QOR exit: batch confirmed, inside its window
  const call = (address: Address, abi: any, functionName: string, args: unknown[], account: Address, blockNumber?: bigint) =>
    publicClient.simulateContract({ address, abi, functionName, args, account, blockNumber } as any);
  const forged = (`0x${"ab".repeat(4627)}`) as Hex;
  const otherRoot = keccak256(toHex("attacker's exit tree"));

  const attacks: Attack[] = [
    { id: "A1", threat: "A stranger attests a batch", who: "attacker", at: "now", expect: "NotWatcher",
      run: () => call(pool, P, "attest", [PAY, 999n, realFacts, realSig], ATTACKER) },
    { id: "A2", threat: "Forge a watcher's ML-DSA-87 signature (a quantum attacker who has the address but not the key)", who: "a real watcher's address", at: "now", expect: "BadSignature",
      run: () => call(pool, P, "attest", [PAY, 999n, realFacts, forged], watcher) },
    { id: "A3", threat: "Replay a watcher's real signature on another batch", who: "a real watcher's address", at: "now", expect: "BadSignature",
      run: () => call(pool, P, "attest", [PAY, 999n, realFacts, realSig], watcher) },
    { id: "A4", threat: "Replay a watcher's real signature with different facts (a fake exit root)", who: "a real watcher's address", at: "now", expect: "BadSignature",
      run: () => call(pool, P, "attest", [PAY, 998n, { ...realFacts, exitRoot: otherRoot }, realSig], watcher) },
    { id: "A5", threat: "A watcher votes twice on the same batch", who: "a real watcher's address", at: "now", expect: "AlreadyVoted",
      run: () => call(pool, P, "attest", [PAY, payIndex, realFacts, realSig], watcher) },
    { id: "A6", threat: "Exit against a batch nobody has verified", who: "attacker", at: "now", expect: "NotConfirmed",
      run: () => call(pool, P, "instantExit", [PAY, 999n, payFacts, wIndex, ATTACKER, salt, amountUqor, proof], ATTACKER) },
    { id: "A7", threat: "Exit with forged facts (the attacker's own exit tree)", who: "attacker", at: `block ${before} (batch confirmed, window open)`, expect: "WrongFacts",
      run: () => call(pool, P, "instantExit", [PAY, payIndex, { ...payFacts, exitRoot: otherRoot }, wIndex, ATTACKER, salt, amountUqor, proof], ATTACKER, before) },
    { id: "A8", threat: "Invent a 300 QOR withdrawal in a verified batch", who: "attacker", at: `block ${before}`, expect: "BadProof",
      run: () => call(pool, P, "instantExit", [PAY, payIndex, payFacts, 7n, ATTACKER, salt, 300_000_000n, proof], ATTACKER, before) },
    { id: "A9", threat: "Front-run a real exit and redirect it to the attacker", who: "attacker", at: `block ${before}`, expect: "BadProof",
      run: () => call(pool, P, "instantExit", [PAY, payIndex, payFacts, wIndex, ATTACKER, salt, amountUqor, proof], ATTACKER, before) },
    { id: "A10", threat: "Take the same exit twice (replay the real exit call)", who: "attacker", at: `block ${pay.block} (right after it was paid)`, expect: "ExitUsed",
      run: () => call(pool, P, "instantExit", pay.args, ATTACKER, pay.block) },
    { id: "A11", threat: "Exit after the challenge window closed", who: "the real beneficiary", at: "now", expect: "TooLate",
      run: () => call(pool, P, "instantExit", pay.args, beneficiary) },
    { id: "A12", threat: "Write off an advance early to slash the watchers", who: "attacker", at: `block ${vig.block} (vigil-1 exit just paid)`, expect: "NotDue",
      run: () => call(pool, P, "markDefault", [vigId], ATTACKER, vig.block) },
    { id: "A13", threat: "Free the watchers' stake while an advance is open", who: "attacker", at: `block ${vig.block}`, expect: "NotDue",
      run: () => call(pool, P, "release", [vigKey], ATTACKER, vig.block) },
    { id: "A14", threat: "Mark an unpaid advance as repaid", who: "attacker", at: `block ${vig.block}`, expect: "NotFunded",
      run: () => call(pool, P, "settle", [vigId], ATTACKER, vig.block) },
    { id: "A15", threat: "Sweep an exit address while the pool's advance on it is open", who: "attacker", at: `block ${vig.block}`, expect: "StillOpen",
      run: () => call(pool, P, "sweepToBeneficiary", [vBeneficiary, vSalt], ATTACKER, vig.block) },
    { id: "A16", threat: "Withdraw liquidity the attacker never deposited", who: "attacker", at: "now", expect: "Panic(17)",
      run: () => call(pool, P, "withdraw", [10n ** 18n], ATTACKER) },
    { id: "A17", threat: "Raise the fee to 10% by replaying both admins' real signatures on a changed lane", who: "attacker", at: `block ${sl.block - 1n} (signatures still within their deadline)`, expect: "BadSignature",
      run: () => call(pool, P, "setLane", [sl.args[0], { ...sl.args[1], feeBps: 1000 }, sl.args[2], sl.args[3], sl.args[4]], ATTACKER, sl.block - 1n) },
    { id: "A18", threat: "Slash a watcher's stake directly in the registry", who: "attacker", at: "now", expect: "NotPool",
      run: () => call(registry, R, "slash", [watcher, 10n ** 18n, ATTACKER], ATTACKER) },
  ];

  // controls: the honest calls, at the same blocks, must be accepted, so a refusal above is the
  // check doing its job and not the harness failing
  const controls: Attack[] = [
    { id: "C1", threat: "The real 3 QOR exit, by its real sender", who: "the real sender", at: `block ${before}`, expect: "accepted",
      run: () => call(pool, P, "instantExit", pay.args, pay.from, before) },
    { id: "C2", threat: "The real attestation, by its watcher", who: "the real watcher", at: `block ${real.block - 1n}`, expect: "accepted",
      run: () => call(pool, P, "attest", real.args, watcher, real.block - 1n) },
    { id: "C3", threat: "The real two-admin setLane, unchanged", who: "anyone", at: `block ${sl.block - 1n}`, expect: "accepted",
      run: () => call(pool, P, "setLane", sl.args, ATTACKER, sl.block - 1n) },
  ];
  const controlResults = [];
  for (const c of controls) {
    let got: string;
    try { await c.run(); got = "accepted"; } catch (e) { got = errorName(e); }
    controlResults.push({ ...c, run: undefined, got, asExpected: got === "accepted" });
    console.log(`${got === "accepted" ? "ACCEPTED" : "FAILED  "}  ${c.id.padEnd(4)} control: ${c.threat}  ->  ${got}`);
  }
  console.log("");
  const results = [];
  for (const a of attacks) {
    let got: string, refused: boolean;
    try { await a.run(); got = "ACCEPTED"; refused = false; } catch (e) { got = errorName(e); refused = true; }
    const ok = refused && got === a.expect;
    results.push({ ...a, run: undefined, got, refused, asExpected: ok });
    console.log(`${ok ? "REFUSED" : refused ? "refused?" : "ACCEPTED"}  ${a.id.padEnd(4)} ${a.threat}  ->  ${got}${ok ? "" : `  (expected ${a.expect})`}`);
  }
  const passed = results.filter((r) => r.asExpected).length;
  const controlsOk = controlResults.every((c) => c.asExpected);
  console.log(`\n${passed} of ${results.length} attacks refused by the expected check`);
  const out = { generatedAt: new Date().toISOString(), evmBlock: Number(latest), pool, registry, attacker: ATTACKER,
    sources: { payExit: PAY_EXIT, vigilExit: VIGIL_EXIT, attestation: att[0].transactionHash, setLane: laneSet.transactionHash }, passed, total: results.length, controlsOk, controls: controlResults, results };
  writeFileSync(new URL("docs/redteam.json", ROOT), JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  writeFileSync(new URL("docs/REDTEAM.md", ROOT), `# Red team: ${passed} of ${results.length} attacks refused

Generated ${out.generatedAt} at EVM block ${out.evmBlock.toLocaleString("en")} by \`npx tsx packages/scripts/src/redteam.ts\` (no key needed, about 30 s).

Each attack is an \`eth_call\` against the live ExitPool v2.1 (\`${pool}\`) and WatcherRegistry (\`${registry}\`) on diana, from an address with no role (\`${ATTACKER}\`) or from a real watcher's address. Where timing matters, it runs against the chain's state at the exact block of a real exit, so the batch is confirmed and its challenge window is open, as it would be for a live attacker. The signatures, facts, proofs and salts are the real ones, read back from these transactions: the 3 QOR exit [\`${PAY_EXIT.slice(0, 12)}…\`], the vigil-1 exit [\`${VIGIL_EXIT.slice(0, 12)}…\`], a watcher attestation [\`${String(att[0].transactionHash).slice(0, 12)}…\`] and a two-admin \`setLane\` [\`${String(laneSet.transactionHash).slice(0, 12)}…\`].

| # | Attack | Who | Against the state at | Refused by |
| --- | --- | --- | --- | --- |
${results.map((r) => `| ${r.id} | ${r.threat} | ${r.who} | ${r.at} | ${r.asExpected ? "✅" : "❌"} \`${r.got}\` |`).join("\n")}

**Controls.** The honest version of each kind of call, at the same blocks, is accepted, so every refusal above is the named check doing its job and not the harness failing:

| # | Honest call | At | Result |
| --- | --- | --- | --- |
${controlResults.map((c) => `| ${c.id} | ${c.threat} | ${c.at} | ${c.asExpected ? "✅ accepted" : `❌ ${c.got}`} |`).join("\n")}

What the refusals mean:

- **A2 to A4, A17:** every authorisation is an ML-DSA-87 signature checked on chain by the \`pqcVerify\` precompile, over a message bound to the chain, this pool, the rollup, the batch and the exact facts (or, for admin actions, the action, its payload, a nonce and a deadline). A signature cannot be forged without the key, even by an attacker with a quantum computer, and a real one cannot be moved to another batch, other facts, or a changed lane.
- **A6 to A11:** the pool pays only against a batch that a quorum of staked watchers re-executed and signed, only for a withdrawal that is a leaf of the exit tree they signed, only to the exit address the rollup's withdrawal names, only once, and only while the chain can still repay it.
- **A12 to A15:** nobody can slash the watchers, unlock their stake or take the repayment before the batch has had its full window plus grace.
- **A16, A18:** liquidity and stake only move through the pool's own accounting.

The same properties are tested with random sequences of actions in \`contracts/test/Invariants.t.sol\` (see [PROOF.md](../PROOF.md)).
`);
  if (passed !== results.length || !controlsOk) process.exitCode = 1;
}
main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exitCode = 1; });
