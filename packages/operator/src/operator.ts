// The Wicketgate operator for a based qledger-v1 rollup. Each round it:
//  1. posts users' signed ledger transactions taken from the relay queue,
//  2. turns the inbox into the next batch (when it holds a submitter bond), anchoring it
//     with the creator's ML-DSA-87 key when it is the rollup's creator,
//  3. pays out finalised withdrawals that back an instant exit, then settles the advance.
import { readFileSync } from "node:fs";
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
import { keccak256, toHex, type Address, type Hex } from "viem";
import type { UnifiedAccount } from "@qorechain/sdk";
import { NET, DEPLOYMENTS_FILE } from "@wicketgate/core/env";
import { sendNative, explorerTx, restGet } from "@wicketgate/core/chain";
import { artifact, closeWindow, openWindow, publicClient, walletFor, windowBudget } from "@wicketgate/core/evm";
import { recipientAddress } from "@wicketgate/core/exit-tree";
import { politeFetch } from "@wicketgate/core/polite";

export interface OperatorConfig {
  rollupId: string;
  me: UnifiedAccount;
  /** Relay queue: GET {url}/pending -> [{id, rollupId, tx}], POST {url}/done {id, txHash?, error?}. */
  relayUrl?: string;
  relayToken?: string;
  log?: (m: string) => void;
}

const ZERO = `0x${"00".repeat(32)}` as Hex;
const POOL = artifact("ExitPool").abi;
const hex = (v: Uint8Array | string) => `0x${(typeof v === "string" ? v : bytesToHex(v)).replace(/^0x/, "").toLowerCase()}` as Hex;

export class Operator {
  private rest = new RestClient(NET.rest, { fetch: politeFetch as any });
  private entryCache = new Map<string, any[]>();
  private checkpoint?: { upto: number; ledger: QledgerLedger; acc: Uint8Array | string; finalized: { index: number; withdrawals: QledgerWithdrawal[] }[] };
  private log: (m: string) => void;
  private pool: Address;
  private settled = new Set<string>();

  constructor(private cfg: OperatorConfig) {
    this.log = cfg.log ?? ((m) => console.log(`${new Date().toISOString()} [${cfg.rollupId}] ${m}`));
    this.pool = JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8")).pool;
  }

  /** Bond as a submitter (amount in uqor). */
  async bond(amountUqor: bigint) {
    const r = await sendNative(this.cfg.me, [bondRollupSubmitterMsg({ submitter: this.cfg.me.cosmos, rollupId: this.cfg.rollupId, amount: amountUqor.toString() })], { gas: 500_000 });
    this.log(`bonded ${amountUqor} uqor: ${explorerTx(r.transactionHash)}`);
  }

  async round() {
    await this.relay().catch((e) => this.log(`relay: ${e?.message ?? e}`));
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
      const entries = this.entryCache.get(key) ?? await fetchQledgerEntries(this.rest, { chainId: NET.chainId, rollupId, from: b.inboxStart, to: b.inboxEnd, accFrom: acc });
      this.entryCache.set(key, entries);
      const result = executeQledger(env, ledger, entries);
      if (hex(result.stateRoot) !== hex(b.stateRoot)) throw new Error(`batch ${i} does not match re-execution; refusing to build on it`);
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
  }
}

export { keccak256, toHex };
