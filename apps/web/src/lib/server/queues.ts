// The relay (users' signed rollup transactions) and the exit relay (instant exits taken for
// the user): validation and state changes shared by the app and operator routes.
import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { decodeQledgerTx, qledgerAccountId, verifyQledgerTx } from "@qorechain/rdk";
import { keccak256, toHex, type Address } from "viem";
import { client } from "../chain";
import { CONTRACTS, NET } from "../config";
import poolAbi from "@wicketgate/core/abi/ExitPool.json";
import hubAbi from "@wicketgate/core/abi/LaneHub.json";
import { LANE_HUB } from "../lanes";
import { getStore, type QueueItem } from "./store";
import { isSealedExitText } from "@wicketgate/core/sealed-exit";

/** Brief, section 9.1: reject a posted transaction over 6 KiB. */
export const MAX_TX_BYTES = 6 * 1024;
const RELAY_PER_MINUTE = 10;
const EXITS_PER_MINUTE = 10;
const DAY = 24 * 60 * 60;

type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string };
const bad = (status: number, error: string) => ({ ok: false as const, status, error });

// ---------------------------------------------------------------- relay

export interface RelayItem extends QueueItem {
  tx: string;
  accountId: string;
  kind: "transfer" | "withdrawal";
  nonce: string;
  amountUqor: string;
  recipient?: string;
  txHash?: string;
  error?: string;
}

export async function enqueueRelay(rollupId: string, txHex: string): Promise<Result<{ id: string; duplicate: boolean }>> {
  const hex = txHex.replace(/^0x/i, "");
  if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2 || !hex.length) return bad(400, "tx must be the hex of encodeQledgerTx");
  if (hex.length / 2 > MAX_TX_BYTES) return bad(413, `tx is over ${MAX_TX_BYTES} bytes`);
  const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
  const tx = decodeQledgerTx(bytes);
  if (!tx) return bad(400, "tx is not exactly one well-formed qledger-v1 transaction");
  if (!verifyQledgerTx(tx, NET.chainId, rollupId)) return bad(400, `tx signature does not verify for ${NET.chainId} / ${rollupId}`);

  const accountId = Buffer.from(qledgerAccountId(tx.publicKey, tx.scheme)).toString("hex");
  const store = getStore();
  if ((await store.hit(`relay:${rollupId}:${accountId}`, 60)) > RELAY_PER_MINUTE) return bad(429, `At most ${RELAY_PER_MINUTE} transactions a minute per rollup account`);

  const id = randomUUID();
  const digest = createHash("sha256").update(rollupId).update(bytes).digest("hex");
  const existing = await store.claim(`relay:${digest}`, id, 7 * DAY);
  if (existing) return { ok: true, value: { id: existing, duplicate: true } };

  const now = Date.now();
  const item: RelayItem = {
    id,
    rollupId,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    tx: hex.toLowerCase(),
    accountId,
    kind: tx.to ? "transfer" : "withdrawal",
    nonce: tx.nonce.toString(),
    amountUqor: tx.amount.toString(),
    ...(tx.recipient ? { recipient: tx.recipient } : {}),
  };
  await store.put(item, "relay");
  return { ok: true, value: { id, duplicate: false } };
}

export const publicRelay = (i: RelayItem) => ({
  status: i.status as "queued" | "posted" | "failed",
  ...(i.txHash ? { txHash: i.txHash } : {}),
  ...(i.error ? { error: i.error } : {}),
});

// ---------------------------------------------------------------- exit relay
// The wallet seals every exit request to the exit operator's ML-KEM-1024 key (QoreSeal, hybrid),
// so this queue and its hosts only ever see the rollup id and ciphertext: no beneficiary, salt or
// amount. The operator opens and validates the request; this side can only check its shape.

export interface ExitItem extends QueueItem {
  sealed: string;
  exitAddr?: Address;
  txHash?: string;
  error?: string;
}

/** Sealed requests carry no beneficiary to rate-limit on, so limit per sender address and per rollup. */
const EXITS_PER_MINUTE_PER_ROLLUP = 60;

/** Whether any pool serves `rollupId`: the main pool's lane, or a LaneHub lane (the sealed request names which). */
async function laneEnabled(rollupId: string): Promise<boolean> {
  const rollupKey = keccak256(toHex(rollupId));
  const lane = (await client.readContract({ address: CONTRACTS.pool, abi: poolAbi, functionName: "lanes", args: [rollupKey] })) as readonly [bigint, bigint, number, number, bigint, boolean];
  if (lane[5]) return true;
  const hubLanes = (await client.readContract({ address: LANE_HUB.address, abi: hubAbi, functionName: "lanesOf", args: [rollupKey] }).catch(() => [])) as any[];
  return hubLanes.length > 0;
}

export async function enqueueExit(input: Record<string, unknown>, sender = "unknown"): Promise<Result<{ id: string; duplicate: boolean }>> {
  const { rollupId, sealed } = input;
  if (typeof rollupId !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(rollupId)) return bad(400, "rollupId is missing or malformed");
  if ("beneficiary" in input || "salt" in input) return bad(400, "Exit requests must be sealed to the operator's ML-KEM-1024 key; send { rollupId, sealed }");
  if (!isSealedExitText(sealed)) return bad(400, "sealed must be one QoreSeal hybrid envelope (qoreseal:...) sealed to the exit operator");

  let enabled = false;
  try {
    enabled = await laneEnabled(rollupId);
  } catch {
    return bad(502, "Could not read the pool's lane from the chain; try again shortly");
  }
  if (!enabled) return bad(400, `The pool has no open lane for ${rollupId}`);

  const store = getStore();
  if ((await store.hit(`exit-ip:${sender}`, 60)) > EXITS_PER_MINUTE) return bad(429, `At most ${EXITS_PER_MINUTE} exit requests a minute`);
  if ((await store.hit(`exit-rollup:${rollupId}`, 60)) > EXITS_PER_MINUTE_PER_ROLLUP) return bad(429, "The exit relay is busy; try again in a minute");

  const id = randomUUID();
  // A resend of the same envelope is the same request.
  const digest = createHash("sha256").update(rollupId).update(sealed).digest("hex");
  const existing = await store.claim(`exit:${digest}`, id, 30 * DAY);
  if (existing) return { ok: true, value: { id: existing, duplicate: true } };

  const now = Date.now();
  const item: ExitItem = { id, rollupId, status: "queued", createdAt: now, updatedAt: now, sealed };
  await store.put(item, "exit");
  return { ok: true, value: { id, duplicate: false } };
}

export const publicExit = (i: ExitItem) => ({
  status: i.status as "queued" | "paid" | "failed",
  ...(i.txHash ? { txHash: i.txHash } : {}),
  ...(i.error ? { error: i.error } : {}),
  ...(i.exitAddr ? { exitAddr: i.exitAddr } : {}),
});

// ---------------------------------------------------------------- operator side

export async function completeItem(
  kind: "relay" | "exit",
  id: string,
  outcome: { status: string; txHash?: string; error?: string; exitAddr?: string },
): Promise<Result<QueueItem>> {
  const store = getStore();
  const item = await store.get(kind, id);
  if (!item) return bad(404, "No such item");
  if (item.status !== "queued") return bad(409, `Item is already ${item.status}`);
  const done: QueueItem = {
    ...item,
    status: outcome.status,
    updatedAt: Date.now(),
    ...(outcome.txHash ? { txHash: outcome.txHash } : {}),
    ...(outcome.exitAddr ? { exitAddr: outcome.exitAddr } : {}),
    ...(outcome.error ? { error: outcome.error.slice(0, 500) } : {}),
  };
  await store.put(done, kind);
  await store.unqueue(kind, done);
  return { ok: true, value: done };
}
