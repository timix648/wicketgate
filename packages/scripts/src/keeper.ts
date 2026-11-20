// A keeper anyone can run (pool v3). Each round it finds every advance and confirmed batch from the
// pool's events and, for the ones that are due:
//  - executes the rollup withdrawal behind an open advance once its batch is final, with the proof
//    the watchers publish in their public feed, so the chain pays the exit address (no team server
//    or rollup state needed: a stranger can do it),
//  - settles an advance whose exit address the chain has paid,
//  - writes off an advance that was not paid by its due time (the confirming watchers' stake repays the pool),
//  - releases a batch's watcher stake once it can take no more advances,
// then claims its credit (v3 pays keepers 10% of each settled or written-off advance's fee).
// Every action is dry-run first; only the ones that would succeed are sent, through one EVM window
// scoped to the pool. The keeper needs no role: any account with a proven ML-DSA-87 key works.
// Usage: npx tsx src/keeper.ts --as <NAME> [--interval 60] [--once] [--claim-above 0.05] [--feed <url-or-dir>]
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { executeWithdrawalMsg, hexToBytes } from "@qorechain/rdk";
import { sendNative, explorerTx } from "@wicketgate/core/chain";
import { politeFetch } from "@wicketgate/core/polite";
import { parseEventLogs, type Address, type Hex } from "viem";
import { account, DEPLOYMENTS_FILE } from "@wicketgate/core/env";
import { artifact, closeWindow, openWindow, publicClient, walletFor, windowBudget } from "@wicketgate/core/evm";

const args = process.argv.slice(2);
const arg = (k: string, d?: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const NAME = arg("as");
const INTERVAL = Number(arg("interval", "60"));
const ONCE = args.includes("--once");
const CLAIM_ABOVE = BigInt(Math.round(Number(arg("claim-above", "0.05")) * 1e18));
const FEED = arg("feed", "https://raw.githubusercontent.com/timix648/wicketgate-feed/main")!;
const dep = JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8"));
const POOL = dep.pool as Address;
const P = artifact("ExitPool").abi;
const OPEN = 1, DEFAULTED = 3;
const log = (m: string) => console.log(`${new Date().toISOString()} [keeper] ${m}`);

const advanceIds = new Set<Hex>();
const batches = new Map<Hex, Hex>(); // batchKey -> rollupKey
let scanned = BigInt(dep.deployBlock ?? 0) - 1n;

async function scan() {
  const latest = await publicClient.getBlockNumber();
  for (let from = scanned + 1n; from <= latest; from += 10_000n) {
    const to = from + 9_999n > latest ? latest : from + 9_999n;
    const logs = parseEventLogs({ abi: P, logs: await publicClient.getLogs({ address: POOL, fromBlock: from, toBlock: to }) }) as any[];
    for (const l of logs) {
      if (l.eventName === "InstantExit") advanceIds.add(l.args.id);
      if (l.eventName === "BatchConfirmed") {
        const key = (await publicClient.readContract({ address: POOL, abi: P, functionName: "batchKey", args: [l.args.rollupKey, l.args.batchIndex] })) as Hex;
        batches.set(key, l.args.rollupKey);
      }
    }
    scanned = to;
  }
}

async function feedFile(name: string): Promise<any> {
  if (/^https?:/.test(FEED)) return JSON.parse(await (await politeFetch(`${FEED}/${name}`)).text());
  const p = join(FEED, name);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : undefined;
}

/** Open advances whose exit address is unpaid and whose withdrawal sits in a finalised batch. */
async function toExecute() {
  const open: { exitAddr: string; amountWei: bigint }[] = [];
  for (const id of advanceIds) {
    const a = (await publicClient.readContract({ address: POOL, abi: P, functionName: "advances", args: [id] })) as any[];
    const [, exitAddr, amountWei, , , , , , state] = a;
    if (state !== OPEN) continue;
    if ((await publicClient.getBalance({ address: exitAddr })) >= amountWei) continue;
    open.push({ exitAddr: String(exitAddr).toLowerCase(), amountWei });
  }
  if (!open.length) return [];
  const index = await feedFile("index.json");
  const out: { rollupId: string; batch: number; w: any }[] = [];
  for (const r of index?.rollups ?? []) {
    const feed = await feedFile(r.file);
    for (const b of feed?.batches ?? []) {
      if (b.status !== "finalized") continue;
      for (const w of b.withdrawals ?? []) {
        if (open.some((o) => o.exitAddr === String(w.recipientEvm ?? "").toLowerCase())) out.push({ rollupId: feed.rollupId, batch: b.index, w });
      }
    }
  }
  return out;
}

async function due(me: Address) {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const work: { fn: string; args: unknown[]; why: string }[] = [];
  for (const id of advanceIds) {
    const a = (await publicClient.readContract({ address: POOL, abi: P, functionName: "advances", args: [id] })) as any[];
    const [, exitAddr, amountWei, , , , , dueBy, state] = a;
    if (state !== OPEN && state !== DEFAULTED) continue;
    const funded = (await publicClient.getBalance({ address: exitAddr })) >= amountWei;
    if (funded) work.push({ fn: "settle", args: [id], why: `advance ${id.slice(0, 10)} repaid by the chain` });
    else if (state === OPEN && now > dueBy) work.push({ fn: "markDefault", args: [id], why: `advance ${id.slice(0, 10)} unpaid past its due time` });
  }
  for (const [key, rollupKey] of batches) {
    const b = (await publicClient.readContract({ address: POOL, abi: P, functionName: "getBatch", args: [key] })) as any[];
    const lane = (await publicClient.readContract({ address: POOL, abi: P, functionName: "lanes", args: [rollupKey] })) as any[];
    if (b[3] || b[4] !== 0 || now <= b[1] + lane[0] + lane[1]) continue; // released, open advances, or not due
    work.push({ fn: "release", args: [key], why: `batch ${key.slice(0, 10)} past its window and grace` });
  }
  // keep only what would succeed now
  const ok = [];
  for (const w of work) {
    try { await publicClient.simulateContract({ address: POOL, abi: P, functionName: w.fn, args: w.args, account: me } as any); ok.push(w); }
    catch { /* someone else got there first, or not due yet */ }
  }
  return ok;
}

async function round(me: Awaited<ReturnType<typeof account>>) {
  await scan();
  // 1. native lane: have the chain pay the exit addresses whose withdrawals are final
  for (const x of await toExecute()) {
    try {
      const r = await sendNative(me, [executeWithdrawalMsg({
        submitter: me.cosmos, rollupId: x.rollupId, batchIndex: x.batch, withdrawalIndex: String(x.w.index),
        recipient: x.w.recipient, denom: "uqor", amount: String(x.w.amountUqor), proof: (x.w.chainProof ?? []).map((h: string) => hexToBytes(h)),
      })], { gas: 600_000 });
      log(`executed withdrawal ${x.w.index} of ${x.rollupId} batch ${x.batch} to ${x.w.recipientEvm}: ${explorerTx(r.transactionHash)}`);
    } catch (e: any) {
      log(`withdrawal ${x.w.index} of ${x.rollupId} batch ${x.batch}: ${String(e?.message ?? e).slice(0, 160)}`);
    }
  }
  // 2. EVM lane: settle, write off, release, claim
  const work = await due(me.evm as Address);
  // count the credit this round's settlements will add (each pays its execution fee and 10% of its fee)
  let credit = (await publicClient.readContract({ address: POOL, abi: P, functionName: "watcherCredit", args: [me.evm] })) as bigint;
  for (const w of work) if (w.fn === "settle" || w.fn === "markDefault") {
    const a = (await publicClient.readContract({ address: POOL, abi: P, functionName: "advances", args: w.args })) as any[];
    credit += (a[3] * 1000n) / 10_000n + (a[9] ?? 0n);
  }
  const claim = credit >= CLAIM_ABOVE && credit > 0n;
  if (!work.length && !claim) return log(`${advanceIds.size} advances and ${batches.size} batches watched; nothing due; credit ${Number(credit) / 1e18} QOR`);
  const n = work.length + (claim ? 1 : 0);
  await openWindow(me, { blocks: 300, maxTxs: n, maxValueUqor: await windowBudget(n, 700_000n), allowedTargets: [POOL] });
  try {
    const wallet = walletFor(me);
    for (const w of work) {
      const hash = await wallet.writeContract({ address: POOL, abi: P, functionName: w.fn, args: w.args, gas: 700_000n } as any);
      const rc = await publicClient.waitForTransactionReceipt({ hash });
      log(`${w.fn} (${w.why}): ${rc.status} ${hash}`);
    }
    if (claim) {
      const after = (await publicClient.readContract({ address: POOL, abi: P, functionName: "watcherCredit", args: [me.evm] })) as bigint;
      const hash = await wallet.writeContract({ address: POOL, abi: P, functionName: "claimCredit", args: [], gas: 120_000n } as any);
      const rc = await publicClient.waitForTransactionReceipt({ hash });
      log(`claimed ${Number(after) / 1e18} QOR of keeper credit: ${rc.status} ${hash}`);
    }
  } finally {
    await closeWindow(me);
  }
}

async function main() {
  if (!NAME) throw new Error("usage: keeper.ts --as <NAME> [--interval 60] [--once] [--claim-above 0.05]");
  if (!(P as any[]).some((x) => x.name === "KeeperPaid")) throw new Error("these ABIs are not pool v3; keepers are paid only from v3 on");
  const me = await account(NAME);
  log(`keeper ${me.evm} on pool ${POOL}`);
  for (;;) {
    try { await round(me); } catch (e: any) { log(`round failed: ${e?.shortMessage ?? e?.message ?? e}`); }
    if (ONCE) break;
    await new Promise((r) => setTimeout(r, INTERVAL * 1000));
  }
}
main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exitCode = 1; });
