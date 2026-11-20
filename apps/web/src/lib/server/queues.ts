// The relay (users' signed rollup transactions) and the exit relay (instant exits taken for
// the user): validation and state changes shared by the app and operator routes.
import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { decodeQledgerTx, qledgerAccountId, verifyQledgerTx } from "@qorechain/rdk";
import { getAddress, isAddress, keccak256, toHex, type Address } from "viem";
import { client } from "../chain";
import { CONTRACTS, NET } from "../config";
import poolAbi from "@wicketgate/core/abi/ExitPool.json";
import { getStore, type QueueItem } from "./store";

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

export interface ExitItem extends QueueItem {
  beneficiary: Address;
  salt: string;
  amountUqor: string;
  exitAddr?: Address;
  txHash?: string;
  error?: string;
}

const SALT = /^0x[0-9a-fA-F]{64}$/;
const UQOR = /^[1-9][0-9]{0,20}$/;

async function laneEnabled(rollupId: string): Promise<boolean> {
  const lane = (await client.readContract({
    address: CONTRACTS.pool,
    abi: poolAbi,
    functionName: "lanes",
    args: [keccak256(toHex(rollupId))],
  })) as readonly [bigint, bigint, number, number, bigint, boolean];
  return Boolean(lane[5]);
}

export async function enqueueExit(input: Record<string, unknown>): Promise<Result<{ id: string; exitAddr?: Address; duplicate: boolean }>> {
  const { rollupId, beneficiary, salt, amountUqor } = input;
  if (typeof rollupId !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(rollupId)) return bad(400, "rollupId is missing or malformed");
  if (typeof beneficiary !== "string" || !isAddress(beneficiary, { strict: false })) return bad(400, "beneficiary must be a 0x address");
  if (typeof salt !== "string" || !SALT.test(salt)) return bad(400, "salt must be 0x followed by 64 hex characters");
  if (typeof amountUqor !== "string" || !UQOR.test(amountUqor)) return bad(400, "amountUqor must be a positive decimal string");

  let enabled = false;
  try {
    enabled = await laneEnabled(rollupId);
  } catch {
    return bad(502, "Could not read the pool's lane from the chain; try again shortly");
  }
  if (!enabled) return bad(400, `The pool has no open lane for ${rollupId}`);

  const ben = getAddress(beneficiary);
  const store = getStore();
  if ((await store.hit(`exit:${ben.toLowerCase()}`, 60)) > EXITS_PER_MINUTE) return bad(429, `At most ${EXITS_PER_MINUTE} exit requests a minute per beneficiary`);

  const id = randomUUID();
  // One request per (beneficiary, salt): the salt fixes the exit address, so a repeat is the same exit.
  const existing = await store.claim(`exit:${ben.toLowerCase()}:${salt.toLowerCase()}`, id, 30 * DAY);
  if (existing) return { ok: true, value: { id: existing, duplicate: true } };

  let exitAddr: Address | undefined;
  try {
    exitAddr = (await client.readContract({ address: CONTRACTS.pool, abi: poolAbi, functionName: "exitAddressFor", args: [ben, salt] })) as Address;
  } catch {
    // Only for display; the operator recomputes it.
  }
  const now = Date.now();
  const item: ExitItem = { id, rollupId, status: "queued", createdAt: now, updatedAt: now, beneficiary: ben, salt: salt.toLowerCase(), amountUqor, ...(exitAddr ? { exitAddr } : {}) };
  await store.put(item, "exit");
  return { ok: true, value: { id, exitAddr, duplicate: false } };
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
  outcome: { status: string; txHash?: string; error?: string },
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
    ...(outcome.error ? { error: outcome.error.slice(0, 500) } : {}),
  };
  await store.put(done, kind);
  await store.unqueue(kind, done);
  return { ok: true, value: done };
}
