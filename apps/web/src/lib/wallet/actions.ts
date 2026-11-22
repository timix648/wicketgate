// What the wallet does (frontend brief, section 8.6):
// - the deposit is the only transaction the user's QoreX wallet signs (window.qorex.native.signAndBroadcast);
// - transfers and withdrawals are signed with the app's own rollup key and posted through /api/relay;
// - the instant exit is taken by the backend's exit relay (/api/exit), so the user signs nothing on EVM;
//   the request is sealed to the operator's ML-KEM-1024 key first, so the relay only stores ciphertext.
import { createRdkRegistry, depositToRollupMsg, encodeQledgerTx, hexToBech32, signQledgerTx } from "@qorechain/rdk";
import { getQorexNative, hasCapability, QOREX_DOWNLOAD_URLS, type QorexSignAndBroadcastResult } from "@qorechain/qorex-types";
import { hexToBytes, keccak256, toHex, type Abi, type Address, type Hex } from "viem";
import poolAbiJson from "@wicketgate/core/abi/ExitPool.json";
import { client } from "../chain";
import { CONTRACTS, NET } from "../config";
import { toHexStr, type Unlocked } from "./vault";
import { sealExitRequest } from "@wicketgate/core/sealed-exit";
import type { RecipientCard } from "@qorechain/qoreseal";
import operatorCard from "../../../../../cards/security.json";

const poolAbi = poolAbiJson as Abi;
const readPool = <T>(functionName: string, args: unknown[] = []) =>
  client.readContract({ address: CONTRACTS.pool, abi: poolAbi, functionName, args }) as Promise<T>;

/** The chain's minimum deposit into a rollup. */
export const MIN_DEPOSIT_UQOR = 1_000_000n;
export const UQOR_PER_QOR = 1_000_000n;
const WEI_PER_UQOR = 1_000_000_000_000n;

export const qorexDownloadUrls = QOREX_DOWNLOAD_URLS;

/** Parses "1.5" QOR into uqor; undefined for anything else. */
export function parseQor(input: string): bigint | undefined {
  const m = input.trim().match(/^(\d{1,12})(?:\.(\d{0,6}))?$/);
  if (!m) return undefined;
  return BigInt(m[1]) * UQOR_PER_QOR + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
}

// ------------------------------------------------------------- QoreX native lane

export class WalletError extends Error {}

function native() {
  const n = getQorexNative();
  if (!n) throw new WalletError("QoreX is not installed in this browser");
  return n;
}

/** The user's qor1 address on the native lane (connects the site if needed). */
export async function connectNative(): Promise<string> {
  const key = await native().getKey(NET.chainId);
  return key.bech32Address;
}

/** MsgDepositToRollup crediting the app's rollup account, signed and broadcast by QoreX. */
export async function deposit(input: { depositor: string; rollupId: string; accountId: string; amountUqor: bigint }): Promise<QorexSignAndBroadcastResult> {
  const n = native();
  if (!hasCapability(n, "signAndBroadcast")) throw new WalletError("This QoreX version cannot sign QoreChain transactions for sites yet; update QoreX");
  if (input.amountUqor < MIN_DEPOSIT_UQOR) throw new WalletError("The chain's minimum deposit is 1 QOR");
  const msg = depositToRollupMsg({
    depositor: input.depositor,
    rollupId: input.rollupId,
    account: hexToBytes(`0x${input.accountId}`),
    amount: input.amountUqor.toString(),
  });
  const any = createRdkRegistry().encodeAsAny(msg);
  const res = await n.signAndBroadcast({ chainId: NET.chainId, messages: [{ typeUrl: any.typeUrl, value: any.value }], gasLimit: 500_000 });
  if (res.code !== 0) throw new WalletError(`The chain refused the deposit (code ${res.code}, transaction ${res.txHash})`);
  return res;
}

// ------------------------------------------------------------- rollup transactions through the relay

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new WalletError(body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

export function relay(rollupId: string, txHex: string) {
  return api<{ queued: true; id: string }>("/api/relay", { method: "POST", body: JSON.stringify({ rollupId, tx: txHex }) });
}
export const relayStatus = (id: string) => api<{ status: "queued" | "posted" | "failed"; txHash?: string; error?: string }>(`/api/relay/${id}`);

/**
 * Queue an instant exit. The request is sealed here, in the browser, with QoreSeal
 * (ML-KEM-1024 + X25519, AES-256-GCM) to the exit operator's key from the chain's KEM registry,
 * checked against the fingerprint pinned in the app and the operator's signed card. The app's
 * server and queue only ever see the rollup id and ciphertext.
 */
export async function requestExit(input: { rollupId: string; beneficiary: Address; salt: Hex; amountUqor: bigint }) {
  const sealed = await sealExitRequest({
    rest: `${window.location.origin}/api/kem-rest`,
    fetch: kemFetch,
    chainId: NET.chainId,
    pool: CONTRACTS.pool,
    card: operatorCard as RecipientCard,
    request: { rollupId: input.rollupId, beneficiary: input.beneficiary, salt: input.salt, amountUqor: input.amountUqor.toString() },
  });
  return api<{ queued: true; id: string; sealed: true }>("/api/exit", { method: "POST", body: JSON.stringify({ rollupId: input.rollupId, sealed }) });
}

/** Maps the chain REST paths QoreSeal reads (/qorechain/pqc/v1/{kem|account}/{addr}) to the app's relay of them. */
const kemFetch = ((url: string | URL, init?: RequestInit) => {
  const m = String(url).match(/\/qorechain\/pqc\/v1\/(kem|account)\/([a-z0-9]+)$/);
  if (!m) return Promise.reject(new WalletError(`unexpected chain lookup: ${String(url)}`));
  return fetch(`/api/kem/${m[1]}/${m[2]}`, init);
}) as typeof fetch;

export const exitStatus = (id: string) => api<{ status: "queued" | "paid" | "failed"; txHash?: string; error?: string; exitAddr?: Address }>(`/api/exit/${id}`);

/** A transfer to another rollup account (64 hex characters). */
export function signTransfer(keys: Unlocked, rollupId: string, nonce: bigint, amountUqor: bigint, toAccountId: string): string {
  const tx = signQledgerTx({
    chainId: NET.chainId,
    rollupId,
    secretKey: keys.secretKey,
    publicKey: keys.publicKey,
    nonce,
    amount: amountUqor,
    to: hexToBytes(`0x${toAccountId}`),
  });
  return toHexStr(encodeQledgerTx(tx));
}

/** A fresh salt and the exit address the pool will pay against for (beneficiary, salt). */
export async function newExitAddress(beneficiary: Address): Promise<{ salt: Hex; exitAddr: Address }> {
  const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const exitAddr = await readPool<Address>("exitAddressFor", [beneficiary, salt]);
  return { salt, exitAddr };
}

/** A withdrawal from the rollup to the exit address, in its canonical qor1 form. */
export function signWithdrawal(keys: Unlocked, rollupId: string, nonce: bigint, amountUqor: bigint, exitAddr: Address): string {
  const tx = signQledgerTx({
    chainId: NET.chainId,
    rollupId,
    secretKey: keys.secretKey,
    publicKey: keys.publicKey,
    nonce,
    amount: amountUqor,
    recipient: hexToBech32(exitAddr, "qor"),
  });
  return toHexStr(encodeQledgerTx(tx));
}

// ------------------------------------------------------------- what an exit will get

export const QUOTE_STATUS: Record<number, { ok: boolean; text: string }> = {
  0: { ok: true, text: "Ready: the pool will pay this exit" },
  1: { ok: false, text: "The pool is paused: no instant exits right now" },
  2: { ok: false, text: "Not verified by the watchers yet" },
  3: { ok: false, text: "Watchers disagree on this batch: payouts frozen" },
  4: { ok: false, text: "The window for instant exits on this batch has closed: collect the normal way" },
  5: { ok: false, text: "This exit is larger than the pool allows in one exit" },
  6: { ok: false, text: "The pool's limit for this rollup is reached: try a smaller amount or wait" },
  7: { ok: false, text: "The watchers' stake behind this batch is used up: take the normal path" },
  8: { ok: false, text: "The pool does not have enough idle liquidity right now" },
  9: { ok: false, text: "The amount is too small to cover the fee" },
};

export interface ExitEstimate {
  feeWei: bigint;
  payoutWei: bigint;
  feeBps: bigint;
  tipWei: bigint;
  /** A reason the exit cannot be paid whatever batch carries it, if any. */
  blocker?: string;
  paused: boolean;
}

/** Before the withdrawal is batched: the fee and the checks that do not depend on the batch. */
export async function estimateExit(rollupId: string, amountUqor: bigint): Promise<ExitEstimate> {
  const rollupKey = keccak256(toHex(rollupId));
  const amountWei = amountUqor * WEI_PER_UQOR;
  const [feeBps, risk, paused, idle] = await Promise.all([
    readPool<bigint>("feeBpsFor", [rollupKey, amountWei]),
    readPool<readonly [number, number, bigint, bigint, bigint]>("risk", [rollupKey]),
    readPool<boolean>("paused"),
    readPool<bigint>("idleLiquidity"),
  ]);
  const tipWei = risk[4];
  const feeWei = (amountWei * feeBps) / 10_000n + tipWei;
  const payoutWei = feeWei < amountWei ? amountWei - feeWei : 0n;
  let blocker: string | undefined;
  if (paused) blocker = QUOTE_STATUS[1].text;
  else if (feeWei >= amountWei) blocker = QUOTE_STATUS[9].text;
  else if (risk[2] !== 0n && amountWei > risk[2]) blocker = QUOTE_STATUS[5].text;
  else if (payoutWei > idle) blocker = QUOTE_STATUS[8].text;
  return { feeWei, payoutWei, feeBps, tipWei, blocker, paused };
}

/** After batching: exactly what the pool would pay now against that batch (pool v3.1 `quote`). */
export async function quoteExit(rollupId: string, batchIndex: number, amountUqor: bigint) {
  const [status, feeWei, payoutWei, coverRoomWei] = await readPool<readonly [number, bigint, bigint, bigint]>("quote", [
    keccak256(toHex(rollupId)),
    BigInt(batchIndex),
    amountUqor,
  ]);
  return { status: Number(status), ...QUOTE_STATUS[Number(status)], feeWei, payoutWei, coverRoomWei };
}
