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

export type Mode = "observe" | "attest" | "challenge";

export interface WatcherConfig {
  rollups: string[];
  mode: Mode;
  me?: UnifiedAccount; // required for attest and challenge
  pool?: Address;
  feedDir: string;
  log?: (msg: string) => void;
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
/** The chain stores an empty withdrawals root; the contract needs 32 bytes. */
const root32 = (r: string) => (r && r !== "0x" ? hex(r) : ZERO_ROOT);

export class Watcher {
  private rest = new RestClient(NET.rest);
  private entryCache = new Map<string, QledgerEntry[]>();
  private sent = new Set<string>(); // attestations/challenges sent this process, to avoid repeats while txs land
  private log: (m: string) => void;

  constructor(private cfg: WatcherConfig) {
    this.log = cfg.log ?? ((m) => console.log(`${new Date().toISOString()} ${m}`));
    if (cfg.mode !== "observe" && (!cfg.me || !cfg.pool)) throw new Error(`mode ${cfg.mode} needs a watcher account and the pool address`);
    mkdirSync(cfg.feedDir, { recursive: true });
  }

  async round(): Promise<void> {
    const index: Record<string, unknown>[] = [];
    for (const rollupId of this.cfg.rollups) {
      try {
        const feed = await this.checkRollup(rollupId);
        index.push({ rollupId, updatedAt: feed.updatedAt, batches: feed.batches.length, file: `${rollupId}.json` });
      } catch (e: any) {
        this.log(`[${rollupId}] round failed: ${e?.shortMessage ?? e?.message ?? e}`);
      }
    }
    writeFileSync(join(this.cfg.feedDir, "index.json"), JSON.stringify({ version: 1, watcher: this.cfg.me?.evm ?? null, rollups: index }, null, 2));
  }

  private async entries(rollupId: string, from: number, to: number, accFrom: Uint8Array | string): Promise<QledgerEntry[]> {
    const key = `${rollupId}:${from}:${to}:${hex(accFrom)}`;
    const hit = this.entryCache.get(key);
    if (hit) return hit;
    const got = await fetchQledgerEntries(this.rest, { chainId: NET.chainId, rollupId, from, to, accFrom });
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
    let ledger = new QledgerLedger();
    let acc: Uint8Array | string = EMPTY_INBOX_ACC;
    const verdicts: BatchVerdict[] = [];
    const toAttest: { index: number; facts: { stateRoot: Hex; withdrawalsRoot: Hex; exitRoot: Hex } }[] = [];

    for (let i = 0; ; i++) {
      let b;
      try {
        b = await this.rest.getBatch(rollupId, i);
      } catch {
        break;
      }
      const base = {
        index: i, status: b.status, inboxStart: b.inboxStart, inboxEnd: b.inboxEnd, submittedTime: b.submittedTime,
        stateRoot: hex(b.stateRoot), withdrawalsRoot: b.withdrawalsRoot ? hex(b.withdrawalsRoot) : "0x",
      };
      if (b.status === "rejected") {
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
        toAttest.push({ index: i, facts: { stateRoot: hex(b.stateRoot), withdrawalsRoot: root32(b.withdrawalsRoot), exitRoot: tree.root } });
      } else {
        ledger = parent; // never build on a wrong batch
        const reason = !stateOk ? "state root differs from re-execution" : "withdrawals root differs from re-execution";
        const v: BatchVerdict = { ...base, verdict: "mismatch", reason, challengeTx: null };
        if (b.status === "submitted" && this.cfg.mode === "challenge") {
          v.challengeTx = await this.challenge(rollupId, i, parent, accFrom, entries, b);
        }
        verdicts.push(v);
        this.log(`[${rollupId}] batch ${i} MISMATCH (${reason})`);
      }
    }

    if (this.cfg.mode !== "observe") await this.attestAll(rollupId, rollupKey, toAttest, verdicts, verdicts.length);

    const oldestPending =
      inbox.headSequence > inbox.consumedSequence
        ? (await this.rest.getPostedData(rollupId, inbox.consumedSequence + 1).catch(() => undefined as any))?.height ?? null
        : null;
    const feed = {
      version: 1,
      rollupId,
      rollupKey,
      updatedAt: new Date().toISOString(),
      watcher: this.cfg.me?.evm ?? null,
      mode: this.cfg.mode,
      inbox: { head: inbox.headSequence, consumed: inbox.consumedSequence, oldestPendingHeight: oldestPending },
      batches: verdicts,
    };
    writeFileSync(join(this.cfg.feedDir, `${rollupId}.json`), JSON.stringify(feed, null, 2));
    const m = verdicts.filter((v) => v.verdict === "match").length;
    this.log(`[${rollupId}] ${verdicts.length} batches: ${m} match, ${verdicts.filter((v) => v.verdict === "mismatch").length} mismatch, ${verdicts.filter((v) => v.verdict === "rejected-on-chain").length} rejected; inbox ${inbox.consumedSequence}/${inbox.headSequence}`);
    return feed;
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
      const bk = (await publicClient.readContract({ address: pool, abi: POOL, functionName: "batchKey", args: [rollupKey, BigInt(i)] })) as Hex;
      const b = (await publicClient.readContract({ address: pool, abi: POOL, functionName: "getBatch", args: [bk] })) as any[];
      const confirmedAt = b[1] as bigint, released = b[3] as boolean, open = Number(b[4]);
      const mine = (b[7] as string[]).some((w) => w.toLowerCase() === me.evm.toLowerCase());
      if (mine && confirmedAt > 0n && !released && open === 0 && now > confirmedAt + BigInt(lane[0]) + BigInt(lane[1]) && !this.sent.has(`r:${bk}`)) {
        toRelease.push(bk);
      }
    }
    const pending: typeof todo = [];
    for (const t of todo) {
      const bk = (await publicClient.readContract({ address: pool, abi: POOL, functionName: "batchKey", args: [rollupKey, BigInt(t.index)] })) as Hex;
      const voted = (await publicClient.readContract({ address: pool, abi: POOL, functionName: "voteOf", args: [bk, me.evm] })) as Hex;
      const v = verdicts.find((x) => x.index === t.index)!;
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
        // confirm-and-lock path that this vote may then trigger.
        const hash = await wallet.writeContract({ address: pool, abi: POOL, functionName: "attest", args: [rollupKey, BigInt(t.index), t.facts, sig], gas: 1_200_000n } as any);
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
