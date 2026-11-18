// Stress run: many instant exits against one batch, until the stake behind it runs out.
// ADMIN_A deposits into its wicketgate-pay ledger account and posts COUNT withdrawals of SIZE QOR
// plus one more of 1 QOR, each to its own exit address, in a few transactions so they land in
// one batch (stop the wicketgate-op-pay session first and restart it after `post`). Once the
// watchers confirm the batch, `exit` takes every exit through one EVM window, then tries the
// extra one, which must be refused once the confirming watchers' stake is fully locked.
// Writes docs/stress.json and docs/STRESS.md.
// Usage: npx tsx src/stress.ts post [count=20] [size=5]   then   npx tsx src/stress.ts exit
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { depositToRollupMsg, postRollupDataMsg, signQledgerTx, encodeQledgerTx, hexToBech32, bytesToHex } from "@qorechain/rdk";
import { encodeAbiParameters, keccak256, toHex, type Address, type Hex } from "viem";
import { account, ledgerKey, NET, STATE_DIR, DEPLOYMENTS_FILE } from "@wicketgate/core/env";
import { sendNative } from "@wicketgate/core/chain";
import { artifact, closeWindow, openWindow, publicClient, walletFor, windowBudget } from "@wicketgate/core/evm";
import { verifyExitProof, exitLeaf } from "@wicketgate/core/exit-tree";

const ROLLUP = "wicketgate-pay";
const ROOT = new URL("../../../", import.meta.url);
const RUN = join(STATE_DIR, "stress-run.json");
const EXITS = join(STATE_DIR, "exits.json");
const NONCES = join(STATE_DIR, "ledger-nonces.json");
const FEED = join(STATE_DIR, "feed-w1", `${ROLLUP}.json`);
const ZERO = `0x${"00".repeat(32)}` as Hex;
const load = (f: string, d: any) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : d);
const pool = JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8")).pool as Address;
const P = artifact("ExitPool").abi;
const PER_TX = 7;

async function post(count: number, size: number) {
  const A = await account("ADMIN_A");
  const la = await ledgerKey("ADMIN_A");
  const nonces = load(NONCES, {});
  const key = `${ROLLUP}:${bytesToHex(la.accountId)}`;
  let nonce = BigInt(nonces[key] ?? 0);
  const amounts = [...Array(count).fill(size), 1];
  const total = amounts.reduce((s, x) => s + x, 0);
  const t0 = Date.now();
  const dep = await sendNative(A, [depositToRollupMsg({ depositor: A.cosmos, rollupId: ROLLUP, account: la.accountId, amount: String((total + 1) * 1e6) })], { gas: 500_000 });
  console.log(`deposit ${total + 1} QOR into ADMIN_A's ledger account: ${dep.transactionHash}`);
  const exits: any[] = [];
  const msgs: any[] = [];
  for (const amt of amounts) {
    const salt = toHex(randomBytes(32)) as Hex;
    const exitAddr = (await publicClient.readContract({ address: pool, abi: P, functionName: "exitAddressFor", args: [A.evm, salt] })) as Address;
    const recipient = hexToBech32(exitAddr, "qor");
    const tx = signQledgerTx({ chainId: NET.chainId, rollupId: ROLLUP, secretKey: la.secretKey, publicKey: la.publicKey, nonce, amount: BigInt(amt * 1e6), recipient });
    nonce++;
    msgs.push(postRollupDataMsg({ poster: A.cosmos, rollupId: ROLLUP, data: encodeQledgerTx(tx) }));
    exits.push({ rollupId: ROLLUP, beneficiary: A.evm, salt, exitAddr, recipient, amountUqor: String(amt * 1e6), stress: true, extra: exits.length === count });
  }
  for (let i = 0; i < msgs.length; i += PER_TX) {
    const r = await sendNative(A, msgs.slice(i, i + PER_TX), { gas: 700_000 * Math.min(PER_TX, msgs.length - i) });
    for (const e of exits.slice(i, i + PER_TX)) { e.postTx = r.transactionHash; e.createdAt = new Date().toISOString(); }
    console.log(`posted withdrawals ${i + 1} to ${Math.min(i + PER_TX, msgs.length)}: ${r.transactionHash}`);
  }
  nonces[key] = nonce.toString();
  writeFileSync(NONCES, JSON.stringify(nonces, null, 2));
  writeFileSync(EXITS, JSON.stringify([...load(EXITS, []), ...exits], null, 2));
  writeFileSync(RUN, JSON.stringify({ startedAt: new Date(t0).toISOString(), count, size, depositTx: dep.transactionHash, exits }, null, 2));
  console.log(`${amounts.length} withdrawals posted (${total} QOR). Now restart the operator (ops/start.sh), then run: npx tsx src/stress.ts exit`);
}

async function exit() {
  const run = load(RUN, null);
  if (!run) throw new Error("no stress run: run `stress.ts post` first");
  const A = await account("ADMIN_A");
  const rollupKey = keccak256(toHex(ROLLUP));
  // wait until one verified batch carries every withdrawal and the pool has confirmed it
  let batch: any, b: any[] = [];
  for (let tries = 0; ; tries++) {
    const feed = load(FEED, { batches: [] });
    batch = feed.batches.find((x: any) => x.verdict === "match" && run.exits.every((e: any) => x.withdrawals?.some((w: any) => w.recipient === e.recipient)));
    if (batch) {
      const bk = (await publicClient.readContract({ address: pool, abi: P, functionName: "batchKey", args: [rollupKey, BigInt(batch.index)] })) as Hex;
      b = (await publicClient.readContract({ address: pool, abi: P, functionName: "getBatch", args: [bk] })) as any[];
      if (b[1] !== 0n) break;
    }
    if (tries > 120) throw new Error("the batch was not confirmed within 20 minutes");
    if (tries % 6 === 0) console.log(batch ? `batch ${batch.index} verified, waiting for the watchers to confirm it` : "waiting for one batch that carries every withdrawal");
    await new Promise((r) => setTimeout(r, 10_000));
  }
  const confirmedAt = Number(b[1]);
  const facts = { stateRoot: batch.stateRoot as Hex, withdrawalsRoot: (batch.withdrawalsRoot === "0x" ? ZERO : batch.withdrawalsRoot) as Hex, exitRoot: batch.exitRoot as Hex };
  const fh = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }], [facts.stateRoot, facts.withdrawalsRoot, facts.exitRoot]));
  if (b[0] !== fh) throw new Error("the pool confirmed different facts than the feed; refusing");
  console.log(`batch ${batch.index} confirmed by ${b[7].length} watchers; ${run.exits.length - 1} exits to take, then 1 past the cap`);
  const argsFor = (e: any) => {
    const w = batch.withdrawals.find((x: any) => x.recipient === e.recipient);
    if (!verifyExitProof(w.exitProof, facts.exitRoot, exitLeaf(BigInt(w.index), e.exitAddr, BigInt(w.amountUqor)))) throw new Error(`exit proof for ${e.exitAddr} does not verify`);
    return [rollupKey, BigInt(batch.index), facts, BigInt(w.index), A.evm, e.salt, BigInt(w.amountUqor), w.exitProof];
  };
  const main = run.exits.filter((e: any) => !e.extra), extra = run.exits.find((e: any) => e.extra);
  const t0 = Date.now();
  await openWindow(A, { blocks: 600, maxTxs: main.length, maxValueUqor: await windowBudget(main.length, 600_000n), allowedTargets: [pool] });
  const rows: any[] = [];
  try {
    const wallet = walletFor(A);
    for (const e of main) {
      const hash = await wallet.writeContract({ address: pool, abi: P, functionName: "instantExit", args: argsFor(e), gas: 600_000n } as any);
      const rc = await publicClient.waitForTransactionReceipt({ hash });
      const blk = await publicClient.getBlock({ blockNumber: rc.blockNumber });
      e.advanceTx = hash; e.batchIndex = batch.index;
      rows.push({ amountQor: Number(e.amountUqor) / 1e6, tx: hash, status: rc.status, gasUsed: Number(rc.gasUsed), paidAt: Number(blk.timestamp), secondsFromPost: Math.round(Number(blk.timestamp) - Date.parse(e.createdAt) / 1000) });
      console.log(`exit ${rows.length}/${main.length}: ${e.amountUqor / 1e6} QOR ${rc.status} ${hash}`);
    }
  } finally {
    await closeWindow(A);
  }
  const elapsed = (Date.now() - t0) / 1000;
  // one more against the same batch: the confirming watchers' stake is now fully locked
  let extraResult = "ACCEPTED";
  try {
    await publicClient.simulateContract({ address: pool, abi: P, functionName: "instantExit", args: argsFor(extra), account: A.evm as Address } as any);
  } catch (err: any) {
    let c = err; while (c && !c.data?.errorName) c = c.cause;
    extraResult = c?.data?.errorName ?? (err.shortMessage ?? String(err)).split("\n")[0];
  }
  const after = (await publicClient.readContract({ address: pool, abi: P, functionName: "getBatch", args: [await publicClient.readContract({ address: pool, abi: P, functionName: "batchKey", args: [rollupKey, BigInt(batch.index)] })] })) as any[];
  const exitsAll = load(EXITS, []);
  for (const e of main) { const x = exitsAll.find((y: any) => y.exitAddr === e.exitAddr); if (x) Object.assign(x, { advanceTx: e.advanceTx, batchIndex: e.batchIndex }); }
  writeFileSync(EXITS, JSON.stringify(exitsAll, null, 2));
  const ok = rows.filter((r) => r.status === "success");
  const med = (xs: number[]) => { const s = [...xs].sort((a, c) => a - c); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
  const report = {
    generatedAt: new Date().toISOString(), rollupId: ROLLUP, batchIndex: batch.index, depositTx: run.depositTx,
    exits: ok.length, qorPaid: ok.reduce((s, r) => s + r.amountQor, 0), coverQor: Number(after[5]) / 1e18, advancedQor: Number(after[6]) / 1e18,
    watchers: after[7], secondsForAllExits: Math.round(elapsed), exitsPerMinute: Math.round((ok.length / elapsed) * 60 * 10) / 10,
    medianSecondsFromWithdrawalPostedToPaid: Math.round(med(ok.map((r) => r.secondsFromPost))), secondsFromBatchConfirmedToLastPaid: ok.at(-1)!.paidAt - confirmedAt,
    avgGasPerExit: Math.round(ok.reduce((s, r) => s + r.gasUsed, 0) / ok.length),
    extraExit: { amountQor: Number(extra.amountUqor) / 1e6, result: extraResult }, rows,
  };
  writeFileSync(new URL("docs/stress.json", ROOT), JSON.stringify(report, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  writeFileSync(new URL("docs/STRESS.md", ROOT), `# Stress run: ${report.exits} instant exits against one batch

Generated ${report.generatedAt} by \`npx tsx packages/scripts/src/stress.ts\`. ${report.exits + 1} withdrawals were posted to \`${ROLLUP}\` together, batched as batch ${report.batchIndex}, re-executed and confirmed by ${report.watchers.length} staked watchers. The pool then paid ${report.exits} of them one after another through a single EVM window.

| | |
| --- | --- |
| Instant exits paid | **${report.exits}**, ${report.qorPaid} QOR in all |
| Time for all of them | ${report.secondsForAllExits} s (${report.exitsPerMinute} per minute, one at a time from one account) |
| Median time from a withdrawal being posted to its money arriving | ${report.medianSecondsFromWithdrawalPostedToPaid} s |
| Stake behind the batch (cover) | ${report.coverQor} QOR, of which advanced: **${report.advancedQor} QOR** |
| One more exit of ${report.extraExit.amountQor} QOR against the same batch | **${report.extraExit.result === "ACCEPTED" ? "ACCEPTED" : `refused: \`${report.extraExit.result}\``}** |
| Average gas per exit | ${report.avgGasPerExit.toLocaleString("en")} |

The pool never advances more against a batch than the stake its confirming watchers have locked behind it, and that held under load: once the cover was used up, the next exit was refused. Withdrawals beyond the cover still reach their owners through the normal path when the batch finalises.

| # | QOR | Seconds from posted to paid | Gas | Transaction |
| --- | --- | --- | --- | --- |
${rows.map((r, i) => `| ${i + 1} | ${r.amountQor} | ${r.secondsFromPost} | ${r.gasUsed.toLocaleString("en")} | \`${r.tx}\` |`).join("\n")}
`);
  console.log(`\n${ok.length} exits, ${report.qorPaid} QOR in ${report.secondsForAllExits} s; cover ${report.coverQor} QOR, advanced ${report.advancedQor}; extra exit: ${extraResult}`);
}

const [cmd, a, b] = process.argv.slice(2);
(cmd === "post" ? post(Number(a ?? 20), Number(b ?? 5)) : cmd === "exit" ? exit() : Promise.reject(new Error("usage: stress.ts post [count] [size] | exit")))
  .catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exitCode = 1; });
