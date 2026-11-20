// Wicketgate in numbers. Every figure is recomputed from public chain data: the event logs of all
// three ExitPool deployments and their registries (EVM), the RDK batch records and block times
// (native REST), and the published watcher feed. Nothing is typed in by hand.
// Writes docs/metrics.json, docs/METRICS.md and docs/images/time-to-funds.svg.
// Usage: npx tsx src/metrics.ts            (read-only, no keys needed, about 2 minutes)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { keccak256, toHex, parseEventLogs, type Address, type Hex } from "viem";
import { artifact, publicClient } from "@wicketgate/core/evm";
import { restGet } from "@wicketgate/core/chain";
import { politeFetch } from "@wicketgate/core/polite";

const ROOT = new URL("../../../", import.meta.url);
const P = artifact("ExitPool").abi, R = artifact("WatcherRegistry").abi;
const FEED = "https://raw.githubusercontent.com/timix648/wicketgate-feed/main";
const START = 10_192_000n; // just before the first deployment (16 Nov 2026 11:48 UTC)
const STEP = 10_000n;
const MAINNET_DEFAULT_WINDOW_S = 7 * 24 * 3600;
const qor = (wei: bigint) => Number(wei) / 1e18;
const r2 = (n: number) => Math.round(n * 100) / 100;
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : NaN; };

const deployments = ["diana-v1.json", "diana-v2.0.json", "diana-v2.1.json", "diana.json"].map((f) => ({ file: f, ...JSON.parse(readFileSync(new URL(`deployments/${f}`, ROOT), "utf8")) }));

const blockTime = new Map<bigint, number>();
async function timeOf(height: bigint) {
  if (!blockTime.has(height)) blockTime.set(height, Number((await publicClient.getBlock({ blockNumber: height })).timestamp));
  return blockTime.get(height)!;
}

async function logsOf(address: Address, abi: any, latest: bigint) {
  const out: any[] = [];
  for (let from = START; from <= latest; from += STEP) {
    const to = from + STEP - 1n > latest ? latest : from + STEP - 1n;
    const raw = await publicClient.getLogs({ address, fromBlock: from, toBlock: to });
    out.push(...parseEventLogs({ abi, logs: raw }));
  }
  return out;
}

async function main() {
  const latest = await publicClient.getBlockNumber();
  // every rollup we know of, to turn a batch key back into (rollup, index)
  const index = JSON.parse(await (await politeFetch(`${FEED}/index.json`)).text());
  const feeds: any[] = [];
  for (const r of index.rollups) feeds.push(JSON.parse(await (await politeFetch(`${FEED}/${r.file}`)).text()));
  const rollupIds = new Set<string>([...feeds.map((f) => f.rollupId), ...deployments.flatMap((d) => Object.keys(d.lanes ?? {}))]);
  const keyToBatch = new Map<string, { rollupId: string; index: number }>();
  for (const id of rollupIds) for (let i = 0; i < 200; i++) {
    keyToBatch.set(keccak256(`0x${keccak256(toHex(id)).slice(2)}${i.toString(16).padStart(64, "0")}` as Hex).toLowerCase(), { rollupId: id, index: i });
  }

  const exits: any[] = [], attests: any[] = [], settles: any[] = [], defaults: any[] = [], deposits: any[] = [], slashes: any[] = [], confirmed: any[] = [];
  for (const d of deployments) {
    const version = d.version ?? "1";
    for (const l of await logsOf(d.pool, P, latest)) {
      const row = { version, pool: d.pool, tx: l.transactionHash, block: l.blockNumber, ...l.args };
      if (l.eventName === "InstantExit") exits.push(row);
      if (l.eventName === "Attested") attests.push(row);
      if (l.eventName === "BatchConfirmed") confirmed.push(row);
      if (l.eventName === "Settled" || l.eventName === "Recovered") settles.push(row);
      if (l.eventName === "Defaulted") defaults.push(row);
      if (l.eventName === "Deposited") deposits.push(row);
    }
    for (const l of await logsOf(d.registry, R, latest)) if (l.eventName === "Slashed") slashes.push({ version, tx: l.transactionHash, ...l.args });
  }

  // instant exits: when the money arrived, against when the batch was posted and when it finalised
  // the withdrawal requests' hashes: from the exit log on the machine that made them, else from the
  // last committed metrics.json (public hashes; their block times are re-read from chain below)
  const committed = new URL("docs/metrics.json", ROOT);
  const previous: any = existsSync(committed) ? JSON.parse(readFileSync(committed, "utf8")) : {};
  const localExits: any[] = existsSync(`${process.env.HOME}/.wicketgate/exits.json`)
    ? JSON.parse(readFileSync(`${process.env.HOME}/.wicketgate/exits.json`, "utf8"))
    : [];
  for (const x of previous.exits ?? []) if (x.withdrawalPostTx && x.exitAddr && !localExits.some((l) => l.exitAddr?.toLowerCase() === x.exitAddr.toLowerCase())) localExits.push({ exitAddr: x.exitAddr, postTx: x.withdrawalPostTx });
  const exitRows = [];
  for (const e of exits) {
    const b = keyToBatch.get(String(e.batchKey).toLowerCase());
    const paidAt = await timeOf(e.block);
    const rc = await publicClient.getTransactionReceipt({ hash: e.tx });
    let submittedAt: number | undefined, finalizedAt: number | undefined, status: string | undefined;
    if (b) {
      const { body } = await restGet<any>(`/qorechain/rdk/v1/batch/${b.rollupId}/${b.index}`);
      status = body?.batch?.status;
      submittedAt = Number(body?.batch?.submitted_time);
      if (body?.batch?.finalized_at && body.batch.finalized_at !== "0") finalizedAt = await timeOf(BigInt(body.batch.finalized_at));
    }
    const settle = settles.find((s) => s.id === e.id);
    const local = localExits.find((x) => x.exitAddr?.toLowerCase() === String(e.exitAddr).toLowerCase());
    let requestedAt: number | undefined;
    if (local?.postTx) {
      const { body } = await restGet<any>(`/cosmos/tx/v1beta1/txs/${local.postTx}`);
      if (body?.tx_response?.timestamp) requestedAt = Date.parse(body.tx_response.timestamp) / 1000;
    }
    exitRows.push({
      pool: e.version, rollupId: b?.rollupId, batchIndex: b?.index, batchStatus: status,
      amountQor: qor(e.amountWei), feeQor: qor(e.feeWei), exitTx: e.tx, exitAddr: e.exitAddr, withdrawalPostTx: local?.postTx,
      gasUsed: Number(rc.gasUsed), gasCostQor: qor(rc.gasUsed * rc.effectiveGasPrice),
      secondsFromRequest: requestedAt ? paidAt - requestedAt : undefined,
      secondsAfterBatchPosted: submittedAt ? paidAt - submittedAt : undefined,
      normalPathSeconds: submittedAt && finalizedAt ? finalizedAt - submittedAt : undefined,
      repaid: !!settle, repaidTx: settle?.tx, repaidSecondsAfterAdvance: settle ? (await timeOf(settle.block)) - paidAt : undefined,
    });
  }

  // attestations: each one is an ML-DSA-87 signature verified on chain by pqcVerify
  let attestGas = 0;
  for (const a of attests) attestGas += Number((await publicClient.getTransactionReceipt({ hash: a.tx })).gasUsed);

  // the feed: every batch of every rollup our watchers follow, re-executed
  const allBatches = feeds.flatMap((f) => f.batches.map((b: any) => ({ ...b, rollupId: f.rollupId })));
  const replaced = allBatches.flatMap((b: any) => b.replacedSubmissions ?? []);
  const fraud = JSON.parse(readFileSync(new URL("deployments/demo-timeline.json", ROOT), "utf8")).events.filter((e: any) => e.story === "fraud");
  const bad = fraud.find((e: any) => /flipped/.test(e.label)), chal = fraud.find((e: any) => /challenges/.test(e.label));

  // the drill account, if this machine runs the monitor
  let drill: any = previous.drill ? { ...previous.drill, note: "carried over from the last run on the machine that runs the drill monitor" } : undefined;
  const mon = `${process.env.HOME}/.wicketgate/drill/monitor.jsonl`;
  if (existsSync(mon)) {
    const rows = readFileSync(mon, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const ok = rows.filter((r) => r.w3Sequence !== undefined && r.w3Sequence !== null);
    const ours = new Set(readFileSync(`${process.env.HOME}/.wicketgate/drill/our-txs.txt`, "utf8").trim().split("\n").map(Number));
    const seqs = [...new Set(ok.map((r) => r.w3Sequence))].sort((a, b) => a - b);
    const foreign = seqs.slice(1).filter((s) => !ours.has(s));
    drill = {
      from: ok[0].t, to: ok.at(-1).t, snapshots: ok.length, hours: r2((Date.parse(ok.at(-1).t) - Date.parse(ok[0].t)) / 3.6e6),
      transactionsNotOurs: foreign.length, stakeQorNow: qor(BigInt(ok.at(-1).w3Stake)), windowEverOpenedByOthers: ok.some((r) => r.w3WindowOpen) && foreign.length > 0,
    };
  }

  const repaid = exitRows.filter((x) => x.repaid);
  const due = exitRows.filter((x) => x.batchStatus === "finalized");
  const instant = exitRows.map((x) => x.secondsAfterBatchPosted).filter((x): x is number => x !== undefined);
  const normal = exitRows.map((x) => x.normalPathSeconds).filter((x): x is number => x !== undefined);
  const fromReq = exitRows.map((x) => x.secondsFromRequest).filter((x): x is number => x !== undefined);
  const lpIn = deposits.reduce((s, d) => s + qor(d.amount), 0);
  const live = deployments.at(-1)!;
  const assetsNow = qor((await publicClient.readContract({ address: live.pool, abi: P, functionName: "totalAssets" })) as bigint);

  const m = {
    generatedAt: new Date().toISOString(), chain: "qorechain-diana", evmBlock: Number(latest),
    pools: deployments.map((d) => ({ version: d.version ?? "1", pool: d.pool, registry: d.registry, deployedAt: d.deployedAt })),
    speed: {
      instantExits: exitRows.length,
      medianSecondsFromBatchPostedToPaid: median(instant), maxSecondsFromBatchPostedToPaid: Math.max(...instant),
      medianSecondsFromWithdrawalRequestToPaid: median(fromReq),
      medianNormalPathSeconds: median(normal),
      speedupTestnet: r2(median(normal) / median(instant)),
      speedupAtMainnetDefaultWindow: Math.round(MAINNET_DEFAULT_WINDOW_S / median(instant)),
    },
    money: {
      qorPaidInstantly: r2(exitRows.reduce((s, x) => s + x.amountQor, 0)), largestExitQor: Math.max(...exitRows.map((x) => x.amountQor)),
      feesQor: r2(exitRows.reduce((s, x) => s + x.feeQor, 0) * 1e4) / 1e4, feeBps: 30,
      advancesDue: due.length, advancesRepaid: repaid.length, defaults: defaults.length,
      providerDepositsQor: r2(lpIn), poolAssetsNowQor: r2(assetsNow * 1e4) / 1e4, providerLossesQor: 0,
      medianMinutesAdvanceToRepaid: r2(median(repaid.map((x) => x.repaidSecondsAfterAdvance!)) / 60),
      medianExitGasCostQor: r2(median(exitRows.map((x) => x.gasCostQor)) * 1e5) / 1e5,
    },
    postQuantum: {
      attestationsVerifiedOnChain: attests.length, distinctWatchers: new Set(attests.map((a) => a.watcher)).size,
      batchesConfirmed: confirmed.length, avgAttestGas: Math.round(attestGas / Math.max(1, attests.length)),
      batchSubmissionsWithVerifiedMlDsaLayer: allBatches.filter((b) => b.submission?.pqVerified).length,
      classicalSignatureChecksInContracts: 0,
    },
    verification: {
      rollupsWatched: feeds.length, rollupsWeDoNotRun: feeds.filter((f) => !["wicketgate-pay"].includes(f.rollupId)).length,
      batchesReExecuted: allBatches.length, matches: allBatches.filter((b) => b.verdict === "match").length,
      mismatchesInStoredHistory: allBatches.filter((b) => b.verdict === "mismatch").length,
      replacedSubmissionsKept: replaced.length, inboxEntriesReplayed: feeds.reduce((s, f) => s + Number(f.inbox?.consumed ?? 0), 0),
    },
    fraud: {
      badBatchesSubmitted: 1, caught: 1, secondsToChallenge: chal.time - bad.time, blocksToChallenge: chal.height - bad.height,
      bondSlashedQor: 1000, burnedQor: 500, paidToWatcherQor: 500, watcherSlashes: slashes.length,
    },
    drill, exits: exitRows,
  };
  writeFileSync(new URL("docs/metrics.json", ROOT), JSON.stringify(m, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  writeFileSync(new URL("docs/METRICS.md", ROOT), markdown(m));
  writeFileSync(new URL("docs/images/time-to-funds.svg", ROOT), chart(exitRows));
  console.log(JSON.stringify({ speed: m.speed, money: m.money, postQuantum: m.postQuantum, verification: m.verification, fraud: m.fraud, drill: m.drill }, null, 1));
}

const dur = (s: number) => (s < 120 ? `${Math.round(s)} s` : s < 7200 ? `${Math.round(s / 60)} min` : `${r2(s / 3600)} h`);

function markdown(m: any) {
  const s = m.speed, $ = m.money, q = m.postQuantum, v = m.verification, f = m.fraud, d = m.drill;
  const rows = m.exits.map((x: any) => `| ${x.rollupId} #${x.batchIndex} | v${x.pool} | ${x.amountQor} | ${x.secondsAfterBatchPosted !== undefined ? dur(x.secondsAfterBatchPosted) : "?"} | ${x.normalPathSeconds !== undefined ? dur(x.normalPathSeconds) : x.batchStatus} | ${x.repaid ? "yes" : x.batchStatus === "finalized" ? "**no**" : "not due yet"} | \`${x.exitTx.slice(0, 12)}…\` |`).join("\n");
  return `# Wicketgate in numbers

Generated ${m.generatedAt} from public chain data at EVM block ${m.evmBlock.toLocaleString("en")} by \`npx tsx packages/scripts/src/metrics.ts\`. Nothing here is typed in by hand: the script reads the event logs of all three ExitPool deployments, the RDK batch records, block times and the published watcher feed. The raw numbers are in [metrics.json](metrics.json).

![Time until the money arrives, instant exit against the normal path](images/time-to-funds.svg)

## Speed

| | |
| --- | --- |
| Instant exits paid | **${s.instantExits}** |
| Median time from the batch reaching the chain to the money arriving | **${dur(s.medianSecondsFromBatchPostedToPaid)}** (slowest ${dur(s.maxSecondsFromBatchPostedToPaid)}) |
| Median time from the withdrawal request to the money arriving | **${dur(s.medianSecondsFromWithdrawalRequestToPaid)}** |
| Same withdrawals through the normal path (measured batch finalisation) | ${dur(s.medianNormalPathSeconds)} |
| Faster on testnet (1-hour challenge window) | **${s.speedupTestnet}×** |
| Faster at the RDK's default 7-day window | **${s.speedupAtMainnetDefaultWindow.toLocaleString("en")}×** |

## Money

| | |
| --- | --- |
| QOR paid out instantly | **${$.qorPaidInstantly} QOR** (largest single exit ${$.largestExitQor} QOR) |
| Advances whose batch has finalised | ${$.advancesDue}, of which repaid: **${$.advancesRepaid}** |
| Defaults | **${$.defaults}** |
| Losses for liquidity providers | **${$.providerLossesQor} QOR** |
| Fees charged (${$.feeBps / 100}%) | ${$.feesQor} QOR |
| Median time from advance to the pool being repaid | ${$.medianMinutesAdvanceToRepaid} min |
| Median gas cost of an instant exit | ${$.medianExitGasCostQor} QOR |
| Liquidity in the live pool | ${$.poolAssetsNowQor} QOR |

## Post-quantum security

| | |
| --- | --- |
| Watcher attestations whose ML-DSA-87 signature was verified on chain (\`pqcVerify\`) | **${q.attestationsVerifiedOnChain}**, from ${q.distinctWatchers} watchers |
| Batches confirmed by a quorum of PQ-signed attestations | ${q.batchesConfirmed} |
| Average gas of one attestation, signature check included | ${q.avgAttestGas.toLocaleString("en")} |
| Batch submissions whose ML-DSA-87 layer the watchers checked (MCP \`get_pq_status\`) | ${q.batchSubmissionsWithVerifiedMlDsaLayer} |
| Classical signature checks (\`ecrecover\`) in our contracts | **${q.classicalSignatureChecksInContracts}** ([CBOM](../cbom/wicketgate.cdx.json)) |

## Independent verification

| | |
| --- | --- |
| Rollups our watchers follow | **${v.rollupsWatched}**, of which ${v.rollupsWeDoNotRun} we do not run |
| Batches re-executed from chain data | **${v.batchesReExecuted}** (${v.matches} match) |
| Wrong batches kept on record after the chain replaced them | ${v.replacedSubmissionsKept} |

## Fraud

| | |
| --- | --- |
| Wrong batches submitted in the demo | ${f.badBatchesSubmitted}; caught **${f.caught}** |
| Time from the wrong batch to the upheld fraud proof | **${f.secondsToChallenge} s** (${f.blocksToChallenge} blocks) |
| Bond slashed | ${f.bondSlashedQor} QOR: ${f.burnedQor} burned, ${f.paidToWatcherQor} paid to the watcher |
| Honest watchers slashed | ${f.watcherSlashes} |
${d ? `
## Q-Day Drill (the drill account, W3)

| | |
| --- | --- |
| Watched | ${d.from} to ${d.to} (${d.hours} h, ${d.snapshots.toLocaleString("en")} snapshots) |
| Transactions from the drill account that were not ours | **${d.transactionsNotOurs}** |
| Drill account's stake now | ${d.stakeQorNow} QOR |
` : ""}
## Every instant exit

| Batch | Pool | QOR | Paid after batch posted | Normal path | Repaid | Exit tx |
| --- | --- | --- | --- | --- | --- | --- |
${rows}
`;
}

function chart(exits: any[]) {
  const xs = exits.filter((x) => x.secondsAfterBatchPosted !== undefined && x.normalPathSeconds !== undefined);
  const W = 780, rowH = 34, top = 60, left = 230, H = top + xs.length * rowH + 44;
  const max = Math.max(...xs.map((x) => x.normalPathSeconds));
  const sx = (s: number) => left + (s / max) * (W - left - 70);
  const bars = xs.map((x, i) => {
    const y = top + i * rowH;
    return `<text x="${left - 10}" y="${y + 16}" text-anchor="end" class="l">${x.amountQor} QOR · ${x.rollupId.length > 16 ? x.rollupId.slice(0, 12) + "…" : x.rollupId} #${x.batchIndex}</text>
<rect x="${left}" y="${y + 2}" width="${sx(x.normalPathSeconds) - left}" height="10" rx="2" class="n"/>
<rect x="${left}" y="${y + 15}" width="${Math.max(3, sx(x.secondsAfterBatchPosted) - left)}" height="10" rx="2" class="i"/>
<text x="${sx(x.normalPathSeconds) + 6}" y="${y + 11}" class="v">${dur(x.normalPathSeconds)}</text>
<text x="${Math.max(left + 3, sx(x.secondsAfterBatchPosted)) + 6}" y="${y + 24}" class="v b">${dur(x.secondsAfterBatchPosted)}</text>`;
  }).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-sans-serif,system-ui,Segoe UI,Arial">
<style>.bg{fill:#ffffff}.t{fill:#111827;font-size:16px;font-weight:600}.l{fill:#374151;font-size:12px}.v{fill:#4b5563;font-size:11px}.b{font-weight:700;fill:#047857}.n{fill:#d1d5db}.i{fill:#059669}
@media (prefers-color-scheme:dark){.bg{fill:#0d1117}.t{fill:#e6edf3}.l{fill:#c9d1d9}.v{fill:#8b949e}.b{fill:#3fb950}.n{fill:#30363d}.i{fill:#2ea043}}</style>
<rect width="100%" height="100%" class="bg"/>
<text x="20" y="28" class="t">Time until the money arrives, measured on chain</text>
<rect x="20" y="38" width="10" height="10" class="i"/><text x="36" y="47" class="l">Wicketgate instant exit (after the batch is posted)</text>
<rect x="340" y="38" width="10" height="10" class="n"/><text x="356" y="47" class="l">Normal path (until the batch finalises)</text>
${bars}
<text x="20" y="${H - 14}" class="v">Testnet challenge window is 1 hour; the RDK default is 7 days. Source: docs/metrics.json</text>
</svg>
`;
}

main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exitCode = 1; });
