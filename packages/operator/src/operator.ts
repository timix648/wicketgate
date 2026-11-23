// The Wicketgate operator for a based qledger-v1 rollup. Each round it:
//  1. posts users' signed ledger transactions taken from the relay queue,
//  2. turns the inbox into the next batch (when it holds a submitter bond), anchoring it
//     with the creator's ML-DSA-87 key when it is the rollup's creator,
//  3. pays out finalised withdrawals that back an instant exit, then settles the advance.
import { readFileSync, existsSync } from "node:fs";
import {
  RestClient,
  isRestNotFound,
  QledgerLedger,
  EMPTY_INBOX_ACC,
  executeQledger,
  fetchQledgerEntries,
  qledgerAccumulate,
  qledgerWithdrawalProof,
  planQledgerBatch,
  submitBatchMsg,
  postRollupDataMsg,
  executeWithdrawalMsg,
  bondRollupSubmitterMsg,
  anchorSignBytesForBatch,
  decodeQledgerTx,
  verifyQledgerTx,
  hexToBytes,
  bytesToHex,
  type QledgerWithdrawal,
} from "@qorechain/rdk";
import { mldsa87 } from "@qorechain/pqc";
import { keccak256, toHex, isAddress, encodeAbiParameters, type Address, type Hex } from "viem";
import type { UnifiedAccount } from "@qorechain/sdk";
import { NET, DEPLOYMENTS_FILE } from "@wicketgate/core/env";
import { sendNative, explorerTx, restGet } from "@wicketgate/core/chain";
import { artifact, closeWindow, openWindow, publicClient, walletFor, windowBudget, withAccountLock } from "@wicketgate/core/evm";
import { recipientAddress, exitLeaf, verifyExitProof } from "@wicketgate/core/exit-tree";
import { politeFetch } from "@wicketgate/core/polite";
import { robustRest, fetchQledgerEntriesPruneSafe } from "@wicketgate/core/robust-rest";
import { alert } from "@wicketgate/core/alert";
import { deriveSealKeys, type SealKeyPair } from "@qorechain/qoreseal";
import { EXIT_OPERATOR, mlkemFingerprint, openExitRequest } from "@wicketgate/core/sealed-exit";
import { join } from "node:path";
import { STATE_DIR } from "@wicketgate/core/env";

export interface OperatorConfig {
  rollupId: string;
  me: UnifiedAccount;
  /** Relay queue: GET {url}/pending -> [{id, rollupId, tx}], POST {url}/done {id, txHash?, error?}. */
  relayUrl?: string;
  relayToken?: string;
  log?: (m: string) => void;
}

const ZERO = `0x${"00".repeat(32)}` as Hex;
const QUEUE_POLL_MS = Number(process.env.WICKETGATE_QUEUE_POLL_S ?? 60) * 1000;
/** Plain reasons for the app when the pool refuses an exit. */
const EXIT_REFUSALS: Record<string, string> = {
  TooLate: "the batch's window closed before the exit could be taken; collect with sweepToBeneficiary after the batch finalises",
  CoverExceeded: "the watchers' stake behind this batch is used up; collect with sweepToBeneficiary after the batch finalises",
  NoLiquidity: "the pool is short of liquidity right now; collect with sweepToBeneficiary after the batch finalises",
  BatchContested: "watchers disagree on this batch, so payouts against it are frozen",
  ExitUsed: "this exit was already taken",
  AlreadyAdvanced: "this exit was already taken",
  AlreadyPaid: "the chain already paid this withdrawal; collect it with sweepToBeneficiary",
  BadProof: "the withdrawal does not match the batch",
  ZeroAmount: "nothing to exit",
};
const POOL = artifact("ExitPool").abi;
/** A withdrawals root as comparable hex; an empty root (no withdrawals) is "". */
const wroot = (r: Uint8Array | string | undefined) => {
  const h = (typeof r === "string" ? r : r ? bytesToHex(r) : "").replace(/^0x/, "").toLowerCase();
  return /^0*$/.test(h) ? "" : h;
};
const hex = (v: Uint8Array | string) => `0x${(typeof v === "string" ? v : bytesToHex(v)).replace(/^0x/, "").toLowerCase()}` as Hex;

export class Operator {
  private rest = robustRest(new RestClient(NET.rest, { fetch: politeFetch as any }));
  private entryCache = new Map<string, any[]>();
  private checkpoint?: { upto: number; ledger: QledgerLedger; acc: Uint8Array | string; finalized: { index: number; withdrawals: QledgerWithdrawal[] }[] };
  private log: (m: string) => void;
  private pool: Address;
  private settled = new Set<string>();
  private lastQueuePoll = 0;
  /** The exit operator's QoreSeal keys (ADMIN_A, index 1: the key in the chain's KEM registry). */
  private sealKeys?: SealKeyPair;

  constructor(private cfg: OperatorConfig) {
    this.log = cfg.log ?? ((m) => console.log(`${new Date().toISOString()} [${cfg.rollupId}] ${m}`));
    this.pool = JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8")).pool;
    if (cfg.relayUrl && cfg.me.cosmos === EXIT_OPERATOR.address && cfg.me.mnemonic) {
      const keys = deriveSealKeys({ mnemonic: cfg.me.mnemonic, index: 1 });
      if (mlkemFingerprint(keys.mlkemPublicKey) === EXIT_OPERATOR.mlkemKeySha3) this.sealKeys = keys;
      else this.log("exit relay: this key is not the pinned exit-operator key; sealed exit requests will stay queued");
    }
  }

  /** Bond as a submitter (amount in uqor). */
  async bond(amountUqor: bigint) {
    const r = await sendNative(this.cfg.me, [bondRollupSubmitterMsg({ submitter: this.cfg.me.cosmos, rollupId: this.cfg.rollupId, amount: amountUqor.toString() })], { gas: 500_000 });
    this.log(`bonded ${amountUqor} uqor: ${explorerTx(r.transactionHash)}`);
  }

  async round() {
    // the app's queues live on a free-tier store: read them once a minute, not every round
    if (Date.now() - this.lastQueuePoll >= QUEUE_POLL_MS) {
      this.lastQueuePoll = Date.now();
      await this.relay().catch((e) => this.log(`relay: ${e?.message ?? e}`));
      await this.exitRelay().catch((e) => this.log(`exit relay: ${e?.shortMessage ?? e?.message ?? e}`));
    }
    const state = await this.rebuild();
    await this.batch(state.ledger).catch((e) => this.log(`batch: ${e?.message ?? e}`));
    await this.keeper(state.finalized).catch((e) => this.log(`keeper: ${e?.shortMessage ?? e?.message ?? e}`));
  }

  /** The ledger after the last settled-or-pending batch, and the withdrawals of finalised batches. */
  private async rebuild() {
    const { rollupId } = this.cfg;
    const env = { chainId: NET.chainId, rollupId };
    const cp = this.checkpoint;
    const ledger = cp ? cp.ledger.clone() : new QledgerLedger();
    let acc: Uint8Array | string = cp ? cp.acc : EMPTY_INBOX_ACC;
    const finalized: { index: number; withdrawals: QledgerWithdrawal[] }[] = cp ? [...cp.finalized] : [];
    let prefixFinal = true;
    for (let i = cp ? cp.upto : 0; ; i++) {
      let b;
      try {
        b = await this.rest.getBatch(rollupId, i);
      } catch (e) {
        if (isRestNotFound(e)) break;
        throw e;
      }
      if (b.status === "rejected") { prefixFinal = false; continue; }
      const key = `${b.inboxStart}:${b.inboxEnd}:${typeof acc === "string" ? acc : bytesToHex(acc)}`;
      const entries = this.entryCache.get(key) ?? await fetchQledgerEntriesPruneSafe(this.rest, { chainId: NET.chainId, rollupId, from: b.inboxStart, to: b.inboxEnd, accFrom: acc });
      this.entryCache.set(key, entries);
      const result = executeQledger(env, ledger, entries);
      if (hex(result.stateRoot) !== hex(b.stateRoot)) throw new Error(`batch ${i} does not match re-execution; refusing to build on it`);
      // the withdrawals root too: a batch can keep an honest state root and still list a withdrawal
      // that never happened (19 Nov 2026, wicketgate-pay batch 12). Never build on one that can
      // still be challenged; if the chain already finalised it, say so loudly and carry on.
      if (wroot(result.withdrawalsRoot) !== wroot(b.withdrawalsRoot)) {
        const msg = `${rollupId} batch ${i} lists withdrawals that re-execution does not produce (status ${b.status})`;
        await alert(`wroot:${rollupId}:${i}:${b.status}`, `${msg}${b.status === "submitted" ? ": refusing to build on it; challenge it now" : ": already final"}.`, join(STATE_DIR, `alerts-${rollupId}.json`));
        if (b.status === "submitted") throw new Error(`${msg}; refusing to build on it`);
      }
      acc = qledgerAccumulate({ chainId: NET.chainId, rollupId, from: b.inboxStart, accFrom: acc, entries });
      if (b.status === "finalized") finalized.push({ index: i, withdrawals: result.withdrawals });
      if (prefixFinal && b.status === "finalized") {
        this.checkpoint = { upto: i + 1, ledger: ledger.clone(), acc, finalized: [...finalized] };
      } else {
        prefixFinal = false;
      }
    }
    return { ledger, finalized };
  }

  private async batch(ledger: QledgerLedger) {
    const { rollupId, me } = this.cfg;
    const bond = await this.rest.getSubmitterBond(rollupId, me.cosmos).catch(() => undefined as any);
    if (!bond || BigInt(bond.amount ?? 0) === 0n) return; // not a submitter on this rollup
    let plan;
    try {
      plan = await planQledgerBatch(this.rest, { chainId: NET.chainId, rollupId, submitter: me.cosmos, ledger });
    } catch (e: any) {
      if (/nothing|no entries|consume/i.test(String(e?.message))) return;
      throw e;
    }
    const rollup: any = await this.rest.getRollup(rollupId);
    let anchorSignature: Uint8Array | undefined;
    if (rollup.creator === me.cosmos) {
      const bytes = anchorSignBytesForBatch({
        chainId: NET.chainId, layerId: rollup.layerId ?? rollupId, batchIndex: plan.input.batchIndex,
        stateRoot: plan.input.stateRoot, txCount: plan.input.txCount,
      } as any);
      anchorSignature = mldsa87.sign(me.pqc.secretKey, bytes);
    }
    const msg = submitBatchMsg({ ...plan.input, sequencer: me.cosmos, ...(anchorSignature ? { anchorSignature } : {}) } as any);
    const r = await sendNative(me, [msg], { gas: 2_000_000 });
    this.log(`submitted batch ${plan.input.batchIndex} (inbox to ${plan.input.inboxEnd}, ${plan.result.withdrawals.length} withdrawals${anchorSignature ? ", anchored" : ""}): ${explorerTx(r.transactionHash)}`);
  }

  private async relay() {
    const { relayUrl, relayToken, rollupId, me } = this.cfg;
    if (!relayUrl) return;
    const headers = { "content-type": "application/json", ...(relayToken ? { authorization: `Bearer ${relayToken}` } : {}) };
    const res = await fetch(`${relayUrl}/pending?rollupId=${encodeURIComponent(rollupId)}`, { headers });
    if (!res.ok) throw new Error(`queue answered ${res.status}`);
    const items = (await res.json()) as { id: string; rollupId: string; tx: string }[];
    for (const it of items) {
      let done: Record<string, unknown> = { id: it.id };
      try {
        const bytes = hexToBytes(it.tx);
        const tx = decodeQledgerTx(bytes);
        if (!tx || !verifyQledgerTx(tx, NET.chainId, rollupId) || bytes.length > 6144) throw new Error("not a valid signed ledger transaction for this rollup");
        const r = await sendNative(me, [postRollupDataMsg({ poster: me.cosmos, rollupId, data: bytes })], { gas: 700_000 });
        done = { ...done, txHash: r.transactionHash };
        this.log(`relayed ${it.id}: ${explorerTx(r.transactionHash)}`);
      } catch (e: any) {
        done = { ...done, error: String(e?.message ?? e) };
      }
      await fetch(`${relayUrl}/done`, { method: "POST", headers, body: JSON.stringify(done) });
    }
  }

  /** Pools that can pay `rollupId`: Wicketgate's own, then every LaneHub lane for it. */
  private async candidatePools(rollupId: string): Promise<Address[]> {
    const out: Address[] = [this.pool];
    try {
      const hub = JSON.parse(readFileSync(new URL("lanehub.json", DEPLOYMENTS_FILE), "utf8")).hub as Address;
      const lanes = (await publicClient.readContract({ address: hub, abi: artifact("LaneHub").abi, functionName: "lanesOf", args: [keccak256(toHex(rollupId))] })) as any[];
      for (const l of lanes) out.push(l.pool as Address);
    } catch {
      // no hub deployed here: our pool only
    }
    return out;
  }

  /**
   * Exit relay: users ask, through the app's queue, for their instant exit to be taken for them.
   * Anyone may call instantExit (the exit proof locks the payout to the beneficiary), so once the
   * watchers have confirmed the batch that carries the withdrawal, the operator takes it and
   * reports back. Items stay queued until then.
   *   GET  {url}/exits/pending?rollupId=<id> -> [{ id, rollupId, sealed }]   (sealed: QoreSeal text)
   *   POST {url}/exits/done   { id, status: "paid" | "failed", txHash?, error?, exitAddr? }
   */
  private async exitRelay() {
    const { relayUrl, relayToken, rollupId, me } = this.cfg;
    if (!relayUrl) return;
    const headers = { "content-type": "application/json", ...(relayToken ? { authorization: `Bearer ${relayToken}` } : {}) };
    const res = await fetch(`${relayUrl}/exits/pending?rollupId=${encodeURIComponent(rollupId)}`, { headers });
    if (!res.ok) throw new Error(`exit queue answered ${res.status}`);
    const raw = (await res.json()) as { id: string; rollupId: string; sealed?: string; beneficiary?: string; salt?: string; amountUqor?: string }[];
    if (!raw.length) return;
    const done = (id: string, body: Record<string, unknown>) =>
      fetch(`${relayUrl}/exits/done`, { method: "POST", headers, body: JSON.stringify({ id, ...body }) }).catch(() => undefined);
    // Sealed requests (QoreSeal, to our ML-KEM-1024 key) are opened here and only here: the app's
    // queue never sees the beneficiary, salt or amount. Plain items are from before the cutover.
    const items: { id: string; beneficiary: string; salt: string; amountUqor: string; sealed: boolean; pool: Address }[] = [];
    // the pools that can pay this rollup: ours and every LaneHub lane; a sealed request is bound to
    // exactly one of them (QoreSeal associated data), and only that one opens it
    const pools = await this.candidatePools(rollupId);
    for (const it of raw) {
      if (typeof it.sealed !== "string") { items.push({ id: it.id, beneficiary: String(it.beneficiary), salt: String(it.salt), amountUqor: String(it.amountUqor), sealed: false, pool: this.pool }); continue; }
      if (!this.sealKeys) continue; // not the exit operator: leave it for the one that is
      let opened = false;
      for (const pool of pools) {
        try {
          const r = openExitRequest({ text: it.sealed, keys: this.sealKeys, chainId: NET.chainId, rollupId, pool });
          items.push({ id: it.id, beneficiary: r.beneficiary, salt: r.salt, amountUqor: r.amountUqor, sealed: true, pool });
          opened = true;
          break;
        } catch {}
      }
      if (!opened) {
        await done(it.id, { status: "failed", error: "the sealed request does not open for this operator, rollup and any pool serving it" });
        this.log(`exit relay: ${it.id} sealed request refused (no candidate pool opens it)`);
      }
    }
    const feed = await this.rollupFeed();
    const rollupKey = keccak256(toHex(rollupId));
    const ready: { id: string; args: unknown[]; exitAddr: string; pool: Address }[] = [];
    for (const it of items) {
      if (!isAddress(it.beneficiary) || !/^0x[0-9a-fA-F]{64}$/.test(it.salt) || !/^[1-9][0-9]*$/.test(String(it.amountUqor))) {
        await done(it.id, { status: "failed", error: "malformed request: beneficiary, salt or amountUqor" });
        continue;
      }
      const exitAddr = ((await publicClient.readContract({ address: it.pool, abi: POOL, functionName: "exitAddressFor", args: [it.beneficiary, it.salt] })) as string).toLowerCase();
      // the batch that carries this withdrawal, re-executed and matching
      let found: { b: any; w: any } | undefined;
      for (const b of feed?.batches ?? []) {
        if (b.verdict !== "match") continue;
        const w = (b.withdrawals ?? []).find((x: any) => String(x.recipientEvm ?? "").toLowerCase() === exitAddr && String(x.amountUqor) === String(it.amountUqor));
        if (w) { found = { b, w }; break; }
      }
      if (!found) continue; // not batched (or not re-executed) yet: keep it queued
      const facts = { stateRoot: found.b.stateRoot as Hex, withdrawalsRoot: (found.b.withdrawalsRoot === "0x" ? ZERO : found.b.withdrawalsRoot) as Hex, exitRoot: found.b.exitRoot as Hex };
      if (!verifyExitProof(found.w.exitProof, facts.exitRoot, exitLeaf(BigInt(found.w.index), exitAddr as Address, BigInt(found.w.amountUqor)))) continue;
      const bk = (await publicClient.readContract({ address: it.pool, abi: POOL, functionName: "batchKey", args: [rollupKey, BigInt(found.b.index)] })) as Hex;
      const rec = (await publicClient.readContract({ address: it.pool, abi: POOL, functionName: "getBatch", args: [bk] })) as any[];
      const fh = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }], [facts.stateRoot, facts.withdrawalsRoot, facts.exitRoot]));
      if (rec[1] === 0n || rec[0] !== fh) continue; // not confirmed by the watchers yet
      const args = [rollupKey, BigInt(found.b.index), facts, BigInt(found.w.index), it.beneficiary, it.salt, BigInt(it.amountUqor), found.w.exitProof];
      try {
        await publicClient.simulateContract({ address: it.pool, abi: POOL, functionName: "instantExit", args, account: me.evm as Address } as any);
        ready.push({ id: it.id, args, exitAddr, pool: it.pool });
      } catch (e: any) {
        let c = e; while (c && !c.data?.errorName) c = c.cause;
        const why = c?.data?.errorName as string | undefined;
        if (why === "NotConfirmed") continue;
        await done(it.id, { status: "failed", error: EXIT_REFUSALS[why ?? ""] ?? `the pool refuses this exit (${why ?? e?.shortMessage ?? "unknown"})` });
      }
    }
    if (!ready.length) return;
    await withAccountLock(me, async () => {
      await openWindow(me, { blocks: 300, maxTxs: ready.length, maxValueUqor: await windowBudget(ready.length, 600_000n), allowedTargets: [...new Set(ready.map((r) => r.pool))] });
      try {
        for (const r of ready) {
          try {
            const hash = await walletFor(me).writeContract({ address: r.pool, abi: POOL, functionName: "instantExit", args: r.args, gas: 600_000n } as any);
            const rc = await publicClient.waitForTransactionReceipt({ hash });
            await done(r.id, rc.status === "success" ? { status: "paid", txHash: hash, exitAddr: r.exitAddr } : { status: "failed", txHash: hash, error: "the exit transaction reverted" });
            this.log(`exit relay: ${r.id} ${rc.status} ${hash}`);
          } catch (e: any) {
            await done(r.id, { status: "failed", error: String(e?.shortMessage ?? e?.message ?? e).slice(0, 200) });
          }
        }
      } finally {
        await closeWindow(me);
      }
    });
  }

  /** This rollup's watcher feed: the local one when this machine runs a watcher, else the public one. */
  private async rollupFeed(): Promise<any> {
    const src = process.env.WICKETGATE_FEED ?? (existsSync(join(STATE_DIR, "feed-w1")) ? join(STATE_DIR, "feed-w1") : "https://raw.githubusercontent.com/timix648/wicketgate-feed/main");
    const file = `${this.cfg.rollupId}.json`;
    if (/^https?:/.test(src)) return JSON.parse(await (await politeFetch(`${src}/${file}`)).text());
    const p = join(src, file);
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : undefined;
  }

  /** Pay finalised withdrawals that go to an exit address with an open advance, then settle it. */
  private async keeper(finalized: { index: number; withdrawals: QledgerWithdrawal[] }[]) {
    const { rollupId, me } = this.cfg;
    const toSettle: Hex[] = [];
    for (const b of finalized) {
      for (let k = 0; k < b.withdrawals.length; k++) {
        const w = b.withdrawals[k];
        const exitAddr = recipientAddress(w.recipient);
        if (!exitAddr) continue;
        const id = (await publicClient.readContract({ address: this.pool, abi: POOL, functionName: "advanceOfExit", args: [exitAddr] })) as Hex;
        if (id === ZERO || this.settled.has(id)) continue;
        const adv = (await publicClient.readContract({ address: this.pool, abi: POOL, functionName: "advances", args: [id] })) as any[];
        if (Number(adv[8]) !== 1 && Number(adv[8]) !== 3) continue; // only open or defaulted
        const balance = await publicClient.getBalance({ address: exitAddr });
        if (balance < (adv[2] as bigint)) {
          const proof = qledgerWithdrawalProof(NET.chainId, rollupId, b.withdrawals, k);
          const r = await sendNative(me, [executeWithdrawalMsg({
            submitter: me.cosmos, rollupId, batchIndex: b.index, withdrawalIndex: w.index.toString(),
            recipient: w.recipient, denom: "uqor", amount: w.amount.toString(), proof,
          })], { gas: 600_000 });
          this.log(`paid withdrawal ${w.index} of batch ${b.index} to exit address ${exitAddr}: ${explorerTx(r.transactionHash)}`);
        }
        toSettle.push(id);
      }
    }
    if (toSettle.length === 0) return;
    await withAccountLock(me, async () => {
      await openWindow(me, { blocks: 300, maxTxs: toSettle.length, maxValueUqor: await windowBudget(toSettle.length, 1_000_000n), allowedTargets: [this.pool] });
      try {
        for (const id of toSettle) {
          const hash = await walletFor(me).writeContract({ address: this.pool, abi: POOL, functionName: "settle", args: [id] } as any);
          const rc = await publicClient.waitForTransactionReceipt({ hash });
          this.settled.add(id);
          this.log(`settled advance ${id.slice(0, 10)}: ${rc.status} ${hash}`);
        }
      } finally {
        await closeWindow(me);
      }
    });
  }
}

export { keccak256, toHex };
