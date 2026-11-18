// Q-Day simulation, step 4: the attacker uses the classical key recovered by qday-crack.ts.
// The same watcher, W4, with the same broken secp256k1 key, guards two pools that differ only in how
// they check a watcher's signature:
//  - ClassicalTwin (contracts/demo): secp256k1 checked with ecrecover, as most bridges and
//    fast-exit pools do today;
//  - Wicketgate's ExitPool v2.1: ML-DSA-87 checked with the pqcVerify precompile.
// Phase 1, W4's EVM window closed: every way in is tried against both. QoreChain itself stops the
//   stolen key: native transactions need the ML-DSA-87 half, EVM transactions need a window, and
//   since v3.2.8 ecrecover treats the account's signature as invalid outside a window.
// Phase 2, W4's routine window open (qday-routine.ts open, signed by W4's real key, scoped to the two
//   pools, as a watcher does to work): the chain now lets the stolen classical key through to those
//   contracts. ClassicalTwin is drained; Wicketgate refuses on chain, because it checks ML-DSA-87.
// The attacker's inputs are the recovered key (~/.wicketgate/qday-cracked.json, written from public
// chain data) and the attacker's own account (MALLORY). W4's secrets are never read here.
// Writes docs/qday.json and docs/QDAY.md. Usage: npx tsx src/qday-attack.ts closed|open
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { unifiedAccountFromSeed, EthNativeSigner, openEvmWindowMsg, fetchEvmWindow } from "@qorechain/sdk";
import { StargateClient } from "@cosmjs/stargate";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http, keccak256, toHex, parseSignature, decodeFunctionData, type Abi, type Address, type Hex } from "viem";
import { NET, DEPLOYMENTS_FILE, qdayAccount } from "@wicketgate/core/env";
import { accountSeq, balanceUqor } from "@wicketgate/core/chain";
import { artifact, closeWindow, openWindow, publicClient, walletFor, windowBudget } from "@wicketgate/core/evm";

const ROOT = new URL("../../../", import.meta.url);
const REPORT = new URL("docs/qday.json", ROOT);
const dep = JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8"));
const TWIN = JSON.parse(readFileSync(new URL("deployments/qday-twin.json", ROOT), "utf8")).twin as Address;
const TWIN_ABI = JSON.parse(readFileSync(new URL("contracts/out/ClassicalTwin.sol/ClassicalTwin.json", ROOT), "utf8")).abi as Abi;
const P = artifact("ExitPool").abi, R = artifact("WatcherRegistry").abi;
const PAY = keccak256(toHex("wicketgate-pay"));
const q = (wei: bigint) => Number(wei) / 1e18;
const short = (s: string) => String(s).replace(/\s+/g, " ").replace(/ \[cosmossdk.*$/, "").slice(0, 200);

function reason(e: any): string {
  for (let c = e; c; c = c.cause) if (c.data?.errorName) return `reverted: ${c.data.errorName}`;
  return short(e?.details ?? e?.shortMessage ?? e?.message ?? e);
}

async function revertName(hash: Hex): Promise<string> {
  const tx = await publicClient.getTransaction({ hash });
  const rc = await publicClient.getTransactionReceipt({ hash });
  if (rc.status === "success") return "ACCEPTED";
  // replay it against the state it ran on, to read the revert reason
  for (const abi of [P, TWIN_ABI]) {
    let d;
    try { d = decodeFunctionData({ abi, data: tx.input }); } catch { continue; }
    try { await publicClient.simulateContract({ address: tx.to!, abi, functionName: d.functionName, args: d.args, account: tx.from, blockNumber: rc.blockNumber - 1n } as any); }
    catch (e: any) { for (let c = e; c; c = c.cause) if (c.data?.errorName) return `reverted on chain: ${c.data.errorName}(${(c.data.args ?? []).join(", ")})`; }
  }
  return "reverted on chain";
}

async function main() {
  const phase = process.argv[2];
  if (phase === "render") return writeFileSync(new URL("docs/QDAY.md", ROOT), markdown(JSON.parse(readFileSync(REPORT, "utf8"))));
  if (phase !== "closed" && phase !== "open") throw new Error("usage: qday-attack.ts closed|open|render");
  const cracked = JSON.parse(readFileSync(`${process.env.HOME}/.wicketgate/qday-cracked.json`, "utf8"));
  const stolen = privateKeyToAccount(cracked.privateKey as Hex);
  const mallory = await qdayAccount("MALLORY");
  const report: any = phase === "closed" || !existsSync(REPORT) ? {} : JSON.parse(readFileSync(REPORT, "utf8"));
  Object.assign(report, { generatedAt: new Date().toISOString(), victim: { cosmos: cracked.address, evm: stolen.address }, attacker: mallory.evm,
    crack: { seconds: cracked.seconds, at: cracked.at }, twin: TWIN, pool: dep.pool, registry: dep.registry });

  const window = await fetchEvmWindow({ rest: NET.rest, address: cracked.address });
  if (phase === "closed" && window.found) throw new Error("W4's window is open; close it first (qday-routine.ts close)");
  if (phase === "open" && !window.found) throw new Error("W4's window is closed; open it first (qday-routine.ts open)");
  const snap = async () => ({
    w4Qor: Number(await balanceUqor(cracked.address)) / 1e6,
    w4StakeQor: q((((await publicClient.readContract({ address: dep.registry, abi: R, functionName: "watchers", args: [stolen.address] })) as any[])[0]) as bigint),
    w4Active: (await publicClient.readContract({ address: dep.registry, abi: R, functionName: "isActive", args: [stolen.address] })) as boolean,
    poolQor: q((await publicClient.readContract({ address: dep.pool, abi: P, functionName: "totalAssets" })) as bigint),
    twinQor: q(await publicClient.getBalance({ address: TWIN })),
    w4Sequence: (await accountSeq(cracked.address))!.sequence,
  });
  const before = await snap();
  console.log(`phase: W4's window ${phase}. Before: ${JSON.stringify(before)}\n`);
  const attempts: any[] = [];
  const attempt = async (target: string, layer: string, what: string, run: () => Promise<string>) => {
    let result: string;
    try { result = await run(); } catch (e: any) { result = reason(e); }
    const refused = !/^ACCEPTED/.test(result);
    attempts.push({ target, layer, what, refused, result });
    console.log(`${refused ? "REFUSED " : "ACCEPTED"} [${target} | ${layer}] ${what}\n         ${result}`);
  };

  // the invented batch: its exit tree pays the attacker the twin's whole balance
  const loot = await publicClient.getBalance({ address: TWIN });
  const tf = { stateRoot: keccak256(toHex("invented state")), withdrawalsRoot: keccak256(toHex("invented withdrawals")),
    exitRoot: (await publicClient.readContract({ address: TWIN, abi: TWIN_ABI, functionName: "exitLeaf", args: [0n, mallory.evm, loot] })) as Hex };
  const index = BigInt(Date.now() % 1_000_000_000); // a fresh batch index per run
  const digest = (await publicClient.readContract({ address: TWIN, abi: TWIN_ABI, functionName: "digest", args: [PAY, index, tf] })) as Hex;
  const sig = parseSignature(await stolen.sign({ hash: digest }));
  const twinArgs = [PAY, index, tf, Number(sig.v ?? 27n), sig.r, sig.s];
  const forgedPq = await stolen.sign({ hash: keccak256(toHex("W4 attests an invented batch")) }); // the best the attacker can offer as an ML-DSA-87 signature
  const evm = createWalletClient({ account: stolen, chain: { id: NET.evmChainId, name: "diana", nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 }, rpcUrls: { default: { http: [NET.evm] } } } as any, transport: http(NET.evm) });

  if (phase === "closed") {
    const seq = (await accountSeq(cracked.address))!;
    const stargate = await StargateClient.connect(NET.rpc);
    const native = async (mode: "classical" | "hybrid", messages: any[]) => {
      const acc = unifiedAccountFromSeed(new Uint8Array(Buffer.from(cracked.privateKey.slice(2), "hex")), { pqcSecret: new Uint8Array(randomBytes(32)) }); // ML-DSA half: a guess
      const r: any = await new EthNativeSigner(acc as any, { rest: NET.rest, signMode: mode }).signAndBroadcast(stargate as any, {
        chainId: NET.chainId, accountNumber: seq.accountNumber, sequence: seq.sequence, fee: { amount: [{ denom: "uqor", amount: "90000" }], gas: "600000" }, messages });
      return r.code === 0 ? `ACCEPTED ${r.transactionHash}` : `code ${r.code}: ${short(r.rawLog)}`;
    };
    const sendAll = [{ typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { fromAddress: cracked.address, toAddress: mallory.cosmos, amount: [{ denom: "uqor", amount: String(Math.floor((before.w4Qor - 0.1) * 1e6)) }] } }];
    await attempt("W4's funds", "QoreChain: hybrid signatures", "Move W4's balance to the attacker, signed with the stolen secp256k1 key only", () => native("classical", sendAll));
    await attempt("W4's funds", "QoreChain: hybrid signatures", "The same, with an ML-DSA-87 signature from a guessed key", () => native("hybrid", sendAll));
    await attempt("W4's funds", "QoreChain: hybrid signatures", "Open an EVM window for W4 with the stolen key", () => native("classical", [openEvmWindowMsg({ sender: cracked.address, blocks: 300, maxTxs: 5, maxValue: "100000000" })]));
    await attempt("W4's stake", "QoreChain: EVM windows", "requestLeave from W4, an EVM transaction signed with the stolen key", async () =>
      `ACCEPTED ${await evm.writeContract({ address: dep.registry, abi: R, functionName: "requestLeave", args: [], gas: 120_000n } as any)}`);
    await attempt("ClassicalTwin", "QoreChain: ecrecover outside a window", "Confirm an invented batch in the twin with W4's stolen signature (submitted by the attacker)", async () => {
      await publicClient.simulateContract({ address: TWIN, abi: TWIN_ABI, functionName: "attest", args: twinArgs, account: mallory.evm as Address } as any);
      return "ACCEPTED (simulated)";
    });
    await attempt("Wicketgate", "Wicketgate: ML-DSA-87 via pqcVerify", "Attest the invented batch in W4's name in ExitPool (submitted by the attacker)", async () => {
      await publicClient.simulateContract({ address: dep.pool, abi: P, functionName: "attest", args: [PAY, index, tf, forgedPq], account: mallory.evm as Address } as any);
      return "ACCEPTED (simulated)";
    });
  } else {
    // W4's routine window admits both pools: the stolen key now reaches them
    await attempt("ClassicalTwin", "ecrecover inside W4's window", "Confirm the invented batch with W4's stolen signature, then exit the twin's whole balance to the attacker", async () => {
      await openWindow(mallory, { blocks: 300, maxTxs: 2, maxValueUqor: await windowBudget(2, 300_000n), allowedTargets: [TWIN] });
      try {
        const wm = walletFor(mallory);
        const a = await wm.writeContract({ address: TWIN, abi: TWIN_ABI, functionName: "attest", args: twinArgs, gas: 200_000n } as any);
        const ra = await publicClient.waitForTransactionReceipt({ hash: a });
        if (ra.status !== "success") return `attest ${await revertName(a)} (${a})`;
        const x = await wm.writeContract({ address: TWIN, abi: TWIN_ABI, functionName: "instantExit", args: [PAY, index, tf, 0n, mallory.evm, loot, []], gas: 200_000n } as any);
        const rx = await publicClient.waitForTransactionReceipt({ hash: x });
        if (rx.status !== "success") return `exit ${await revertName(x)} (${x})`;
        report.drain = { attestTx: a, drainTx: x, stolenQor: q(loot) };
        return `ACCEPTED: ${q(loot)} QOR stolen. attest ${a}, drain ${x}`;
      } finally { await closeWindow(mallory); }
    });
    await attempt("Wicketgate", "Wicketgate: ML-DSA-87 via pqcVerify", "Attest the invented batch as W4 itself, a real EVM transaction inside W4's window, signed with the stolen key", async () => {
      const h = await evm.writeContract({ address: dep.pool, abi: P, functionName: "attest", args: [PAY, index, tf, forgedPq], gas: 600_000n } as any);
      return `${await revertName(h)} (${h})`;
    });
    await attempt("W4's stake", "QoreChain: window scope", "requestLeave from W4 inside its window (the registry is not in the window's scope)", async () =>
      `ACCEPTED ${await evm.writeContract({ address: dep.registry, abi: R, functionName: "requestLeave", args: [], gas: 120_000n } as any)}`);
  }
  const after = await snap();
  console.log(`\nAfter: ${JSON.stringify(after)}`);
  report[phase] = { at: new Date().toISOString(), before, after, attempts };
  writeFileSync(REPORT, JSON.stringify(report, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  if (report.closed && report.open) writeFileSync(new URL("docs/QDAY.md", ROOT), markdown(report));
}

function markdown(r: any) {
  const row = (x: any) => `| ${x.target} | ${x.what} | ${x.layer} | ${x.refused ? "**refused**" : "**ACCEPTED**"}: ${String(x.result).replace(/^ACCEPTED:? ?/, "").replace(/\|/g, "\\|")} |`;
  const c = r.closed, o = r.open;
  return `# Q-Day, simulated on chain

Generated ${r.generatedAt} on the \`qorechain-diana\` testnet. Re-run from \`packages/scripts\`: \`qday-crack.ts ${r.victim.cosmos}\`, \`qday-attack.ts closed\`, \`qday-routine.ts open\`, \`qday-attack.ts open\`, \`qday-routine.ts close\`.

## The setup

One watcher, **W4** (\`${r.victim.evm}\`), guards two pools with the same keys. Its secp256k1 key is a 40-bit number, weak on purpose: it stands in for what Shor's algorithm will do to every secp256k1 key once a large enough quantum computer exists. Its ML-DSA-87 key comes from a separate 256-bit secret. W4 is a staked watcher in Wicketgate's live registry (5 QOR) and the watcher of ClassicalTwin (10 QOR of liquidity). The two pools differ only in how they check a watcher's signature:

| | ClassicalTwin ([contracts/demo/ClassicalTwin.sol](../contracts/demo/ClassicalTwin.sol), demo only) | Wicketgate ExitPool v2.1 |
| --- | --- | --- |
| Watcher signature | secp256k1, checked with \`ecrecover\` (as most bridges and fast-exit pools today) | ML-DSA-87, checked with the \`pqcVerify\` precompile |
| Address | \`${r.twin}\` | \`${r.pool}\` |

## Step 1: the key falls

The attacker read W4's public key from \`GET /cosmos/auth/v1beta1/accounts/${r.victim.cosmos}\` (every account that has signed a transaction has published it) and recovered the private key with baby-step giant-step in **${r.crack.seconds} s** on one CPU core ([qday-crack.ts](../packages/scripts/src/qday-crack.ts)). Nothing else in this simulation is simulated.

## Step 2: W4's EVM window closed. QoreChain stops the stolen key

| Target | Attempt | Layer | Result |
| --- | --- | --- | --- |
${c.attempts.map(row).join("\n")}

${c.onChainEvidence ? `${c.onChainEvidence}\n\n` : ""}With no window open, QoreChain alone protects even the classical contract: an account with a registered post-quantum key must hybrid-sign native transactions, needs a window (opened only by a hybrid-signed message) for any EVM transaction, and, since v3.2.8, its \`ecrecover\` signatures count only for contracts its live window admits.

## Step 3: W4's routine window open. The classical pool falls, Wicketgate does not

A watcher has to open windows to work: Wicketgate's own watchers open one scoped to the pool every round they attest. W4 opened its routine window with its real ML-DSA-87 key, scoped to the two pools it watches. While it is open, the chain lets the stolen classical key through to those contracts:

| Target | Attempt | Layer | Result |
| --- | --- | --- | --- |
${o.attempts.map(row).join("\n")}

| | Before | After |
| --- | --- | --- |
| ClassicalTwin liquidity | ${c.before.twinQor} QOR | **${o.after.twinQor} QOR** |
| Wicketgate pool assets | ${c.before.poolQor} QOR | **${o.after.poolQor} QOR** |
| W4's stake in Wicketgate | ${c.before.w4StakeQor} QOR | ${o.after.w4StakeQor} QOR |
| W4's balance | ${o.before.w4Qor} QOR | ${o.after.w4Qor} QOR: the attacker can make W4 pay gas for transactions inside its window, up to the window's spending cap (here 0.5 QOR) |

## What this shows

1. **QoreChain's protections are real**: with the window closed, the stolen key could not move W4's funds, open a window, touch its stake, or pass \`ecrecover\`.
2. **They are bounded by the window**: a window is how an account uses the EVM at all, and while it is open the classical key is enough for the contracts it admits. A pool that trusts \`ecrecover\` is then only as safe as its watchers' secp256k1 keys.
3. **Wicketgate does not depend on the window being closed**: every attestation and admin action is an ML-DSA-87 signature checked inside the contract by \`pqcVerify\`, so the stolen classical key gets nowhere even with the window open. There is no \`ecrecover\` in Wicketgate's contracts ([CBOM](../cbom/wicketgate.cdx.json)).
`;
}
main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exitCode = 1; });
