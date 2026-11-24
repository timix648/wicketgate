// What the wallet does (frontend brief, section 8.6):
// - the deposit is the only transaction the user's QoreX wallet signs (window.qorex.native.signAndBroadcast);
// - transfers and withdrawals are signed with the app's own rollup key and posted through /api/relay;
// - the instant exit is taken by the backend's exit relay (/api/exit), so the user signs nothing on EVM;
//   the request is sealed to the operator's ML-KEM-1024 key first, so the relay only stores ciphertext.
import { createRdkRegistry, depositToRollupMsg, encodeQledgerTx, hexToBech32, signQledgerTx } from "@qorechain/rdk";
import { getQorexNative, hasCapability, QOREX_DOWNLOAD_URLS, type QorexSignAndBroadcastResult } from "@qorechain/qorex-types";
import { hexToBytes, keccak256, toHex, type Abi, type Address, type Hex } from "viem";
import poolAbiJson from "@wicketgate/core/abi/ExitPool.json";
import hubAbiJson from "@wicketgate/core/abi/LaneHub.json";
import { LANE_HUB } from "../lanes";
import { client } from "../chain";
import { CONTRACTS, NET } from "../config";
import { toHexStr, type Unlocked } from "./vault";
import { EXIT_OPERATOR, sealExitRequest } from "@wicketgate/core/sealed-exit";
import type { RecipientCard } from "@qorechain/qoreseal";
import operatorCard from "../../../../../cards/security.json";

const poolAbi = poolAbiJson as Abi;
const hubAbi = hubAbiJson as Abi;
const readPool = <T>(functionName: string, args: unknown[] = [], pool: Address = CONTRACTS.pool) =>
  client.readContract({ address: pool, abi: poolAbi, functionName, args }) as Promise<T>;

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
export async function requestExit(input: {
  rollupId: string;
  beneficiary: Address;
  salt: Hex;
  amountUqor: bigint;
  pool?: Address;
  /** Called as the request is sealed and then sent, so the page can show each step. */
  onStage?: (stage: "sealing" | "sending") => void;
}) {
  input.onStage?.("sealing");
  const sealed = await sealExitRequest({
    rest: `${window.location.origin}/api/kem-rest`,
    fetch: kemFetch,
    chainId: NET.chainId,
    pool: input.pool ?? CONTRACTS.pool,
    card: operatorCard as RecipientCard,
    request: { rollupId: input.rollupId, beneficiary: input.beneficiary, salt: input.salt, amountUqor: input.amountUqor.toString() },
  });
  input.onStage?.("sending");
  const res = await api<{ queued: true; id: string; sealed: true }>("/api/exit", { method: "POST", body: JSON.stringify({ rollupId: input.rollupId, sealed }) });
  // `sealedText` is exactly what left the browser: the page shows it as "what the server saw".
  return { ...res, sealedText: sealed };
}

/** The exit operator's ML-KEM-1024 key as the chain's KEM registry serves it, and its pinned fingerprint. */
export const EXIT_OPERATOR_KEY = {
  address: EXIT_OPERATOR.address,
  fingerprint: EXIT_OPERATOR.mlkemKeySha3,
  chainUrl: `${NET.rest}/qorechain/pqc/v1/kem/${EXIT_OPERATOR.address}`,
};

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
export async function newExitAddress(beneficiary: Address, pool: Address = CONTRACTS.pool): Promise<{ salt: Hex; exitAddr: Address }> {
  const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const exitAddr = await readPool<Address>("exitAddressFor", [beneficiary, salt], pool);
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
export async function estimateExit(rollupId: string, amountUqor: bigint, pool: Address = CONTRACTS.pool): Promise<ExitEstimate> {
  const rollupKey = keccak256(toHex(rollupId));
  const amountWei = amountUqor * WEI_PER_UQOR;
  const [feeBps, risk, paused, idle] = await Promise.all([
    readPool<bigint>("feeBpsFor", [rollupKey, amountWei], pool),
    readPool<readonly [number, number, bigint, bigint, bigint]>("risk", [rollupKey], pool),
    readPool<boolean>("paused", [], pool),
    readPool<bigint>("idleLiquidity", [], pool),
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
export async function quoteExit(rollupId: string, batchIndex: number, amountUqor: bigint, pool: Address = CONTRACTS.pool) {
  const [status, feeWei, payoutWei, coverRoomWei] = await readPool<readonly [number, bigint, bigint, bigint]>("quote", [
    keccak256(toHex(rollupId)),
    BigInt(batchIndex),
    amountUqor,
  ], pool);
  return { status: Number(status), ...QUOTE_STATUS[Number(status)], feeWei, payoutWei, coverRoomWei };
}

// ------------------------------------------------------------- lane routing

export interface RouteOption {
  pool: Address;
  label: string;
  estimate: ExitEstimate;
}

/**
 * Every pool that can pay an instant exit on `rollupId` (Wicketgate's main pool and any LaneHub
 * lane), each with its estimate, cheapest payable first. The withdrawal is signed to an exit
 * address of the chosen pool, so the choice is made before signing.
 */
export async function routeExit(rollupId: string, amountUqor: bigint): Promise<{ best?: RouteOption; options: RouteOption[] }> {
  const rollupKey = keccak256(toHex(rollupId));
  const candidates: { pool: Address; label: string }[] = [];
  const mainLane = await readPool<readonly unknown[]>("lanes", [rollupKey]);
  if (mainLane[5]) candidates.push({ pool: CONTRACTS.pool, label: "Wicketgate main pool" });
  try {
    const lanes = (await client.readContract({ address: LANE_HUB.address, abi: hubAbi, functionName: "lanesOf", args: [rollupKey] })) as any[];
    lanes.forEach((l, i) => candidates.push({ pool: l.pool as Address, label: `LaneHub lane ${i + 1} (${String(l.pool).slice(0, 8)}…)` }));
  } catch {
    // no hub reachable: the main pool alone
  }
  const options = await Promise.all(candidates.map(async (c) => ({ ...c, estimate: await estimateExit(rollupId, amountUqor, c.pool) })));
  options.sort((a, b) => Number(!!a.estimate.blocker) - Number(!!b.estimate.blocker) || (a.estimate.feeWei < b.estimate.feeWei ? -1 : a.estimate.feeWei > b.estimate.feeWei ? 1 : 0));
  return { best: options.find((o) => !o.estimate.blocker), options };
}

// ------------------------------------------------------------- exit straight to another chain (IBC)

/** QoreChain testnet's open ICS-20 channels (checked live 23 Nov 2026: all STATE_OPEN). */
export const IBC_DESTINATIONS = {
  osmosis: { name: "Osmosis testnet", channel: "channel-1", prefix: "osmo", keyKind: "cosmos" as const, explorer: (a: string) => `https://lcd.osmotest5.osmosis.zone/cosmos/bank/v1beta1/balances/${a}` },
  injective: { name: "Injective testnet", channel: "channel-2", prefix: "inj", keyKind: "eth" as const, explorer: (a: string) => `https://testnet.sentry.lcd.injective.network/cosmos/bank/v1beta1/balances/${a}` },
  cosmoshub: { name: "Cosmos Hub testnet", channel: "channel-0", prefix: "cosmos", keyKind: "cosmos" as const, explorer: (a: string) => `https://rest.provider-sentry-01.ics-testnet.polypore.xyz/cosmos/bank/v1beta1/balances/${a}` },
};
export type IbcDestination = keyof typeof IBC_DESTINATIONS;

/**
 * Forward a paid exit to the user's own address on another chain, in one QoreX signature. The
 * receiver is derived from the user's own key (Cosmos chains: RIPEMD160(SHA256(pubkey)); Injective,
 * which uses Ethereum keys: the user's EVM address), so only the user controls it. If the relayer
 * never delivers, the transfer times out after 15 minutes and the chain refunds it here.
 */
export async function forwardOverIbc(input: { dest: IbcDestination; amountUqor: bigint; evm: Address }) {
  const n = native();
  if (!hasCapability(n, "signAndBroadcast")) throw new WalletError("This QoreX version cannot sign QoreChain transactions for sites yet; update QoreX");
  const d = IBC_DESTINATIONS[input.dest];
  const key = await n.getKey(NET.chainId);
  const receiver = d.keyKind === "eth" ? hexToBech32(input.evm, d.prefix) : hexToBech32(toHex(Uint8Array.from(key.address)), d.prefix);
  const { MsgTransfer } = await import("cosmjs-types/ibc/applications/transfer/v1/tx");
  const value = MsgTransfer.encode(MsgTransfer.fromPartial({
    sourcePort: "transfer", sourceChannel: d.channel, token: { denom: "uqor", amount: input.amountUqor.toString() },
    sender: key.bech32Address, receiver, timeoutHeight: { revisionNumber: 0n, revisionHeight: 0n },
    timeoutTimestamp: BigInt(Date.now() + 15 * 60_000) * 1_000_000n, memo: "wicketgate instant exit",
  })).finish();
  const res = await n.signAndBroadcast({ chainId: NET.chainId, messages: [{ typeUrl: "/ibc.applications.transfer.v1.MsgTransfer", value }], gasLimit: 400_000 });
  if (res.code !== 0) throw new WalletError(`The chain refused the transfer (code ${res.code}, transaction ${res.txHash})`);
  return { ...res, receiver, destination: d };
}
