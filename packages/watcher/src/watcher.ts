// The Wicketgate watcher. Each round it rebuilds every watched rollup's ledger from
// chain data alone, re-executes every batch, and then, depending on its mode:
//   observe   - publishes verdicts only (needs no key)
//   attest    - also signs ML-DSA-87 attestations for matching batches and sends them to ExitPool
//   challenge - also sends a fraud proof for any wrong batch that is still in its window
// It also releases its locked stake once a confirmed batch can take no more advances.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  RestClient,
  isRestNotFound,
  QledgerLedger,
  EMPTY_INBOX_ACC,
  executeQledger,
  fetchQledgerEntries,
  qledgerAccumulate,
  qledgerWithdrawalProof,
  buildQledgerFraudProof,
  checkQledgerFraud,
  challengeBatchMsg,
  bytesToHex,
  type QledgerEntry,
  type QledgerWithdrawal,
} from "@qorechain/rdk";
import { encodeAbiParameters, keccak256, toHex, type Address, type Hex } from "viem";
import type { UnifiedAccount } from "@qorechain/sdk";
import { NET } from "@wicketgate/core/env";
import { sendNative, explorerTx } from "@wicketgate/core/chain";
import { artifact, closeWindow, openWindow, pqSign, publicClient, walletFor, windowBudget } from "@wicketgate/core/evm";
import { buildExitTree, ZERO_ROOT } from "@wicketgate/core/exit-tree";
import { TOOLS as MCP_TOOLS, toolContext } from "@qorechain/mcp";
import { restGet } from "@wicketgate/core/chain";
import { politeFetch } from "@wicketgate/core/polite";
import { robustRest } from "@wicketgate/core/robust-rest";
import { fetchEntriesIndependent } from "@wicketgate/core/independent-entries";
import { alert } from "@wicketgate/core/alert";

const PQ_STATUS = MCP_TOOLS.find((t) => t.name === "get_pq_status")!;
const MCP_CTX = toolContext({ defaultNetwork: "testnet" });

/** Who submitted a batch, and whether the chain-verified ML-DSA-87 layer of that tx checks out (QoreChain MCP get_pq_status). */
export interface Provenance { tx: string; height: number; signer: string | null; pqVerified: boolean | null; tier: string | null }

export type Mode = "observe" | "attest" | "challenge";

export interface WatcherConfig {
  rollups: string[];
  mode: Mode;
  me?: UnifiedAccount; // required for attest and challenge
  pool?: Address;
  feedDir: string;
  log?: (msg: string) => void;
  /**
   * How inbox entries are read: "rdk" = the RDK fetcher with wrapped posts hoisted (robust-rest.ts);
   * "independent" = our own reader that recovers each payload by its committed hash
   * (independent-entries.ts). Running both kinds of watcher means one reader's bug cannot blind all.
   */
  reader?: "rdk" | "independent";
}

export interface BatchVerdict {
  index: number;
  status: string;
  inboxStart: number;
  inboxEnd: number;
  submittedTime: number;
  stateRoot: string;
  withdrawalsRoot: string;
  verdict: "match" | "mismatch" | "rejected-on-chain";
  reason?: string;
  exitRoot?: Hex;
  attestationTx?: string | null;
  challengeTx?: string | null;
  withdrawals?: {
    index: string;
    recipient: string;
    recipientEvm: string | null;
    amountUqor: string;
    exitProof: Hex[] | null;
    chainProof: Hex[];
  }[];
}

const POOL = artifact("ExitPool").abi;
const hex = (v: Uint8Array | string) => `0x${(typeof v === "string" ? v : bytesToHex(v)).replace(/^0x/, "").toLowerCase()}` as Hex;
const factsHash = (f: { stateRoot: Hex; withdrawalsRoot: Hex; exitRoot: Hex }) =>
  keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }], [f.stateRoot, f.withdrawalsRoot, f.exitRoot]));
/** ExitPool.batchKey, computed locally. */
const batchKeyOf = (rollupKey: Hex, i: number) =>
  keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint64" }], [rollupKey, BigInt(i)]));
/** The chain stores an empty withdrawals root; the contract needs 32 bytes. */
const root32 = (r: string) => (r && r !== "0x" ? hex(r) : ZERO_ROOT);

const BLIND_ALERT_S = Number(process.env.WICKETGATE_BLIND_ALERT_S ?? 180);

/** Seconds since the chain's latest block, or undefined if the RPC cannot be read. */
async function chainStalledFor(): Promise<number | undefined> {
  try {
    const res = await fetch(`${NET.rpc}/status`, { signal: AbortSignal.timeout(15_000) });
    const t = (await res.json())?.result?.sync_info?.latest_block_time;
    return t ? (Date.now() - Date.parse(t)) / 1000 : undefined;
  } catch {
    return undefined;
  }
}

export class Watcher {
  private rest = robustRest(new RestClient(NET.rest, { fetch: politeFetch as any }));
  /** The independent reader gets its own client, so it shares no code with robustRest above HTTP. */
  private plainRest = new RestClient(NET.rest, { fetch: politeFetch as any });
  private lastOk = new Map<string, number>(); // per rollup: when it was last fully verified
  private blind = new Set<string>(); // rollups we alerted as blind, to say when they recover
  private entryCache = new Map<string, QledgerEntry[]>();
  private sent = new Set<string>();
  private provenance = new Map<string, Provenance>(); // by tx hash
  /** Per rollup: the ledger after its longest prefix of finalised batches, and their verdicts. */
  private checkpoints = new Map<string, { upto: number; ledger: QledgerLedger; acc: Uint8Array | string; verdicts: BatchVerdict[] }>();
  /** Pool state of batches that can no longer change (released, or final and never confirmed). */
  private poolCache = new Map<string, any>(); // attestations/challenges sent this process, to avoid repeats while txs land
  private log: (m: string) => void;

  constructor(private cfg: WatcherConfig) {
    this.log = cfg.log ?? ((m) => console.log(`${new Date().toISOString()} ${m}`));
    if (cfg.mode !== "observe" && (!cfg.me || !cfg.pool)) throw new Error(`mode ${cfg.mode} needs a watcher account and the pool address`);
    mkdirSync(cfg.feedDir, { recursive: true });
  }

  /** "all" = every rollup on chain that runs the qledger-v1 execution VM, rediscovered each round. */
  private async rollupList(): Promise<string[]> {
    if (!this.cfg.rollups.includes("all")) return this.cfg.rollups;
    const { body } = await restGet<any>("/qorechain/rdk/v1/rollups?pagination.limit=200");
    return (body?.rollups ?? []).filter((r: any) => r.execution_vm === "qledger-v1" && r.status !== "stopped").map((r: any) => r.rollup_id);
  }

  async round(): Promise<void> {
    const index: Record<string, unknown>[] = [];
    let rollups: string[];
    try {
      rollups = await this.rollupList();
    } catch (e: any) {
      this.log(`could not list rollups: ${e?.message ?? e}`);
      return;
    }
    for (const rollupId of rollups) {
      try {
        const feed = await this.checkRollup(rollupId);
        index.push({ rollupId, updatedAt: feed.updatedAt, batches: feed.batches.length, file: `${rollupId}.json` });
        this.lastOk.set(rollupId, Date.now());
        if (this.blind.delete(rollupId)) await alert(`recovered:${rollupId}`, `${rollupId} is being verified again.`);
      } catch (e: any) {
        const err = String(e?.shortMessage ?? e?.message ?? e);
        this.log(`[${rollupId}] round failed: ${err}`);
        // a watchtower that cannot verify is blind: say so while the challenge window is still open
        if (!this.lastOk.has(rollupId)) this.lastOk.set(rollupId, Date.now());
        const blindFor = (Date.now() - this.lastOk.get(rollupId)!) / 1000;
        if (blindFor >= BLIND_ALERT_S) {
          this.blind.add(rollupId);
          // a stopped chain (a planned upgrade, say) blinds everyone but also stops the clock on
          // batches: report that instead of a false fraud warning
          const stalled = await chainStalledFor();
          if (stalled !== undefined && stalled > 120) {
            await alert("chain-halted", `the chain has produced no block for ${Math.round(stalled / 60)} min (an upgrade?); watching resumes when it does.`);
          } else {
            await alert(`blind:${rollupId}`, `BLIND on ${rollupId} for ${Math.round(blindFor / 60)} min: cannot verify its batches, so a wrong batch could finalise unchallenged. Last error: ${err.slice(0, 300)}`);
          }
        }
      }
    }
    writeFileSync(join(this.cfg.feedDir, "index.json"), JSON.stringify({ version: 1, watcher: this.cfg.me?.evm ?? null, reader: this.cfg.reader ?? "rdk", rollups: index }, null, 2));
  }

  private async entries(rollupId: string, from: number, to: number, accFrom: Uint8Array | string): Promise<QledgerEntry[]> {
    const key = `${rollupId}:${from}:${to}:${hex(accFrom)}`;
    const hit = this.entryCache.get(key);
    if (hit) return hit;
    const input = { chainId: NET.chainId, rollupId, from, to, accFrom };
    const got = this.cfg.reader === "independent" ? await fetchEntriesIndependent(this.plainRest, input) : await fetchQledgerEntries(this.rest, input);
    this.entryCache.set(key, got);
    return got;
  }

  async checkRollup(rollupId: string) {
    const env = { chainId: NET.chainId, rollupId };
    const rollupKey = keccak256(toHex(rollupId));
    const [rollup, inbox] = await Promise.all([this.rest.getRollup(rollupId), this.rest.getInbox(rollupId)]);
    if ((rollup as any).executionVm && (rollup as any).executionVm !== "qledger-v1") {
      throw new Error(`execution VM ${(rollup as any).executionVm} is not qledger-v1; nothing to re-execute`);
    }
    const cp = this.checkpoints.get(rollupId);
    let ledger = cp ? cp.ledger.clone() : new QledgerLedger();
    let acc: Uint8Array | string = cp ? cp.acc : EMPTY_INBOX_ACC;
    const verdicts: BatchVerdict[] = cp ? cp.verdicts.map((v) => ({ ...v })) : [];
    const toAttest: { index: number; facts: { stateRoot: Hex; withdrawalsRoot: Hex; exitRoot: Hex } }[] = [];
    // extend the checkpoint while batches are final and match; anything after is re-checked every round
    let prefixFinal = true;

    for (let i = cp ? cp.upto : 0; ; i++) {
      let b;
      try {
        b = await this.rest.getBatch(rollupId, i);
      } catch (e) {
        if (isRestNotFound(e)) break; // the end of the batch list
        throw e; // anything else fails the round loudly; never check only part of a rollup
      }
      const base = {
        index: i, status: b.status, inboxStart: b.inboxStart, inboxEnd: b.inboxEnd, submittedTime: b.submittedTime,
        stateRoot: hex(b.stateRoot), withdrawalsRoot: b.withdrawalsRoot ? hex(b.withdrawalsRoot) : "0x",
      };
      if (b.status === "rejected") {
        // not cached: the chain may reuse a rejected batch's index for a resubmission
        prefixFinal = false;
        verdicts.push({ ...base, verdict: "rejected-on-chain", reason: "rejected by a fraud proof; its inbox range was rolled back" });
        continue;
      }
      const entries = await this.entries(rollupId, b.inboxStart, b.inboxEnd, acc);
      const parent = ledger.clone();
      const result = executeQledger(env, ledger, entries);
      const stateOk = hex(result.stateRoot) === hex(b.stateRoot);
      const wdOk = root32(bytesToHex(result.withdrawalsRoot)) === root32(b.withdrawalsRoot);
      const accFrom = acc;
      acc = qledgerAccumulate({ chainId: NET.chainId, rollupId, from: b.inboxStart, accFrom: acc, entries });

      if (stateOk && wdOk) {
        const ws = result.withdrawals as QledgerWithdrawal[];
        const tree = buildExitTree(ws.map((w) => ({ index: w.index, recipient: w.recipient, amount: w.amount })));
        const byIndex = new Map(tree.entries.map((e) => [e.withdrawal.index, e]));
        verdicts.push({
          ...base, verdict: "match", exitRoot: tree.root,
          withdrawals: ws.map((w, k) => ({
            index: w.index.toString(), recipient: w.recipient, recipientEvm: byIndex.get(w.index)?.recipientEvm ?? null,
            amountUqor: w.amount.toString(), exitProof: byIndex.get(w.index)?.proof ?? null,
            chainProof: qledgerWithdrawalProof(NET.chainId, rollupId, ws, k).map((p) => hex(p)),
          })),
        });
        // Only batches still in their challenge window: once a batch is final its withdrawals can be
        // paid by the chain directly, and confirming it would let an already-paid withdrawal be
        // advanced a second time.
        if (b.status === "submitted") {
          toAttest.push({ index: i, facts: { stateRoot: hex(b.stateRoot), withdrawalsRoot: root32(b.withdrawalsRoot), exitRoot: tree.root } });
        }
        if (prefixFinal && b.status === "finalized") {
          this.checkpoints.set(rollupId, { upto: i + 1, ledger: ledger.clone(), acc, verdicts: verdicts.map((v) => ({ ...v })) });
        } else {
          prefixFinal = false;
        }
      } else {
        ledger = parent; // never build on a wrong batch
        prefixFinal = false;
        const reason = !stateOk ? "state root differs from re-execution" : "withdrawals root differs from re-execution";
        const v: BatchVerdict = { ...base, verdict: "mismatch", reason, challengeTx: null };
        if (b.status === "submitted" && this.cfg.mode === "challenge") {
          v.challengeTx = await this.challenge(rollupId, i, parent, accFrom, entries, b);
        }
        verdicts.push(v);
        this.log(`[${rollupId}] batch ${i} MISMATCH (${reason})`);
        const where = b.status === "submitted"
          ? (v.challengeTx ? `challenged: ${v.challengeTx}` : "still in its window and NOT challenged: send a fraud proof now")
          : `already ${b.status}: its window has closed`;
        await alert(`mismatch:${rollupId}:${i}:${b.status}`, `${rollupId} batch ${i} is WRONG (${reason}); ${where}.`, join(this.cfg.feedDir, "alerts-sent.json"));
      }
    }

    if (this.cfg.mode !== "observe") await this.attestAll(rollupId, rollupKey, toAttest, verdicts, verdicts.length);

    const oldestPending =
      inbox.headSequence > inbox.consumedSequence
        ? (await this.rest.getPostedData(rollupId, inbox.consumedSequence + 1).catch(() => undefined as any))?.height ?? null
        : null;
    const subs = await this.submissions(rollupId).catch(() => new Map<number, Provenance[]>());
    for (const v of verdicts) {
      const all = subs.get(v.index) ?? [];
      // the current batch at an index is the latest submission; earlier ones were rejected and rolled back
      (v as any).submission = all[all.length - 1] ?? null;
      if (all.length > 1) (v as any).replacedSubmissions = all.slice(0, -1);
    }
    const pool = this.cfg.pool ? await this.poolState(rollupKey, verdicts.length, new Map(verdicts.map((v) => [v.index, v.status]))) : null;
    if (pool) for (const v of verdicts) (v as any).pool = pool.batches[v.index] ?? null;
    const feed = {
      version: 1,
      rollupId,
      rollupKey,
      lane: pool?.lane ?? null,
      updatedAt: new Date().toISOString(),
      watcher: this.cfg.me?.evm ?? null,
      mode: this.cfg.mode,
      reader: this.cfg.reader ?? "rdk",
      inbox: { head: inbox.headSequence, consumed: inbox.consumedSequence, oldestPendingHeight: oldestPending },
      // Every non-zero ledger account after the longest valid prefix of batches, so a wallet can show
      // real balances and nonces (the chain exposes neither for a rollup account). balance is in uqor.
      accounts: ledger.accounts().map((a) => ({ id: hex(a.id), balance: a.balance.toString(), nonce: Number(a.nonce) })),
      batches: verdicts,
    };
    writeFileSync(join(this.cfg.feedDir, `${rollupId}.json`), JSON.stringify(feed, null, 2));
    const m = verdicts.filter((v) => v.verdict === "match").length;
    this.log(`[${rollupId}] ${verdicts.length} batches: ${m} match, ${verdicts.filter((v) => v.verdict === "mismatch").length} mismatch, ${verdicts.filter((v) => v.verdict === "rejected-on-chain").length} rejected; inbox ${inbox.consumedSequence}/${inbox.headSequence}`);
    return feed;
  }

  /** Every batch-submitting transaction of a rollup, by batch index, oldest first, with its post-quantum provenance. */
  private async submissions(rollupId: string): Promise<Map<number, Provenance[]>> {
    const q = encodeURIComponent(`rdk_inbox_consumed.rollup_id='${rollupId}'`);
    const { body } = await restGet<any>(`/cosmos/tx/v1beta1/txs?query=${q}&pagination.limit=100&order_by=ORDER_BY_ASC`);
    const out = new Map<number, Provenance[]>();
    for (const t of body?.tx_responses ?? []) {
      if (t.code !== 0) continue;
      const idx = t.events.filter((e: any) => e.type === "rdk_inbox_consumed").flatMap((e: any) => e.attributes).find((a: any) => a.key === "batch_index")?.value;
      if (idx === undefined) continue;
      let prov = this.provenance.get(t.txhash);
      if (!prov) {
        const r: any = await PQ_STATUS.handler({ network: "testnet", target: t.txhash }, MCP_CTX).catch(() => null);
        const ts = r?.transaction_status;
        prov = { tx: t.txhash, height: Number(t.height), signer: ts?.signer ?? null, pqVerified: ts?.verification?.verified ?? null, tier: ts?.tier ?? null };
        if (prov.pqVerified !== null) this.provenance.set(t.txhash, prov);
      }
      const list = out.get(Number(idx)) ?? [];
      list.push(prov);
      out.set(Number(idx), list);
    }
    return out;
  }

  /** The pool's view of each batch, so readers of the feed need no contract calls. */
  private async poolState(rollupKey: Hex, n: number, verdictsStatus: Map<number, string> = new Map()) {
    const pool = this.cfg.pool!;
    const l = (await publicClient.readContract({ address: pool, abi: POOL, functionName: "lanes", args: [rollupKey] })) as any[];
    const lane = { windowSecs: Number(l[0]), graceSecs: Number(l[1]), feeBps: Number(l[2]), quorum: Number(l[3]), lockPerWatcherQor: Number(l[4]) / 1e18, enabled: Boolean(l[5]) };
    const batches: Record<number, unknown> = {};
    if (!lane.enabled) return { lane, batches };
    for (let i = 0; i < n; i++) {
      const bk = batchKeyOf(rollupKey, i);
      const hit = this.poolCache.get(bk);
      if (hit) { batches[i] = hit; continue; }
      const b = (await publicClient.readContract({ address: pool, abi: POOL, functionName: "getBatch", args: [bk] })) as any[];
      batches[i] = {
        batchKey: bk,
        confirmed: b[1] > 0n,
        confirmedAt: b[1] > 0n ? new Date(Number(b[1]) * 1000).toISOString() : null,
        contested: b[2],
        released: b[3],
        openAdvances: Number(b[4]),
        coverQor: Number(b[5]) / 1e18,
        advancedQor: Number(b[6]) / 1e18,
        watchers: b[7],
      };
      const final = (verdictsStatus.get(i) ?? "") === "finalized";
      if (b[3] || (final && b[1] === 0n)) this.poolCache.set(bk, batches[i]);
    }
    return { lane, batches };
  }

  private async attestAll(
    rollupId: string,
    rollupKey: Hex,
    todo: { index: number; facts: { stateRoot: Hex; withdrawalsRoot: Hex; exitRoot: Hex } }[],
    verdicts: BatchVerdict[],
    batchCount: number,
  ) {
    const me = this.cfg.me!, pool = this.cfg.pool!;
    const lane = (await publicClient.readContract({ address: pool, abi: POOL, functionName: "lanes", args: [rollupKey] })) as any[];
    if (!lane[5]) return; // no lane for this rollup
    // batches confirmed with my stake that can take no more advances: release the stake
    const now = BigInt(Math.floor(Date.now() / 1000));
    const toRelease: Hex[] = [];
    for (let i = 0; i < batchCount; i++) {
      const bk = batchKeyOf(rollupKey, i);
      if (this.poolCache.has(bk) || this.sent.has(`r:${bk}`)) continue; // released, or nothing to release
      const b = (await publicClient.readContract({ address: pool, abi: POOL, functionName: "getBatch", args: [bk] })) as any[];
      const confirmedAt = b[1] as bigint, released = b[3] as boolean, open = Number(b[4]);
      const mine = (b[7] as string[]).some((w) => w.toLowerCase() === me.evm.toLowerCase());
      if (mine && confirmedAt > 0n && !released && open === 0 && now > confirmedAt + BigInt(lane[0]) + BigInt(lane[1]) && !this.sent.has(`r:${bk}`)) {
        toRelease.push(bk);
      }
    }
    const pending: typeof todo = [];
    for (const t of todo) {
      const bk = batchKeyOf(rollupKey, t.index);
      const voted = (await publicClient.readContract({ address: pool, abi: POOL, functionName: "voteOf", args: [bk, me.evm] })) as Hex;
      const v = verdicts.find((x) => x.index === t.index)!;
      if (t.facts.exitRoot === ZERO_ROOT && voted === ZERO_ROOT) {
        // nothing in this batch can be exited instantly, so no stake needs to stand behind it;
        // the verdict is still published in the feed
        v.attestationTx = "not-needed: no withdrawals to exit";
        continue;
      }
      if (voted !== ZERO_ROOT) {
        v.attestationTx = voted === factsHash(t.facts) ? "already-attested" : "attested-different-facts";
        continue;
      }
      if (!this.sent.has(`a:${bk}`)) pending.push(t);
    }
    const txs = pending.length + toRelease.length;
    if (txs === 0) return;

    await openWindow(me, { blocks: 600, maxTxs: txs, maxValueUqor: await windowBudget(txs, 2_500_000n), allowedTargets: [pool] });
    try {
      const wallet = walletFor(me);
      for (const bk of toRelease) {
        this.sent.add(`r:${bk}`);
        // another watcher of the same batch may release it first; that is fine
        const again = (await publicClient.readContract({ address: pool, abi: POOL, functionName: "getBatch", args: [bk] })) as any[];
        if (again[3]) continue;
        try {
          const hash = await wallet.writeContract({ address: pool, abi: POOL, functionName: "release", args: [bk], gas: 400_000n } as any);
          const rc = await publicClient.waitForTransactionReceipt({ hash });
          this.log(`[${rollupId}] released stake on ${bk.slice(0, 10)}: ${rc.status} ${hash}`);
        } catch (e: any) {
          this.log(`[${rollupId}] release of ${bk.slice(0, 10)} skipped: ${e?.shortMessage ?? e?.message ?? e}`);
        }
      }
      for (const t of pending) {
        const msg = (await publicClient.readContract({
          address: pool, abi: POOL, functionName: "attestationMessage", args: [rollupKey, BigInt(t.index), t.facts],
        })) as Hex;
        const sig = pqSign(me, msg);
        // Fixed gas: an estimate made before another watcher's vote lands misses the costlier
        // confirming path that this vote may then trigger. The chain bills at least half the
        // limit, so the limit is kept close to need: on pool v2.1 a vote uses about 340,000 gas
        // and a confirming vote about 426,000 (measured 18 Nov); 560,000 leaves 31% headroom.
        const hash = await wallet.writeContract({ address: pool, abi: POOL, functionName: "attest", args: [rollupKey, BigInt(t.index), t.facts, sig], gas: 560_000n } as any);
        const rc = await publicClient.waitForTransactionReceipt({ hash });
        const v = verdicts.find((x) => x.index === t.index)!;
        v.attestationTx = rc.status === "success" ? hash : `reverted:${hash}`;
        if (rc.status === "success") {
          this.sent.add(`a:${keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint64" }], [rollupKey, BigInt(t.index)]))}`);
        }
        this.log(`[${rollupId}] attested batch ${t.index}: ${rc.status} ${hash} (gas ${rc.gasUsed})`);
      }
    } finally {
      await closeWindow(me);
    }
  }

  private async challenge(rollupId: string, index: number, parent: QledgerLedger, accFrom: Uint8Array | string, entries: QledgerEntry[], b: any) {
    const key = `c:${rollupId}:${index}`;
    if (this.sent.has(key)) return "sent";
    const env = { chainId: NET.chainId, rollupId };
    const { proof } = buildQledgerFraudProof(env, parent, accFrom, entries);
    const claim = {
      inboxStart: b.inboxStart, inboxEnd: b.inboxEnd, dataHash: b.dataHash,
      prevStateRoot: b.prevStateRoot, stateRoot: b.stateRoot, withdrawalsRoot: b.withdrawalsRoot ?? "",
    };
    if (!checkQledgerFraud(env, claim, proof)) {
      this.log(`[${rollupId}] batch ${index}: local fraud check says the batch is right; not challenging`);
      return null;
    }
    let r;
    try {
      r = await sendNative(this.cfg.me!, [challengeBatchMsg({ challenger: this.cfg.me!.cosmos, rollupId, batchIndex: index, proof })], { gas: 1_200_000 });
    } catch (e: any) {
      // another watcher got there first: the batch is already rejected
      if (/is rejected|already finalized|already rejected/i.test(String(e?.message))) {
        this.sent.add(key);
        this.log(`[${rollupId}] batch ${index} was already rejected by another challenger`);
        return "rejected-by-another-watcher";
      }
      throw e;
    }
    this.sent.add(key);
    this.log(`[${rollupId}] CHALLENGED batch ${index}: ${explorerTx(r.transactionHash)}`);
    return r.transactionHash;
  }
}
