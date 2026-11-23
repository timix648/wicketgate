// A second, independent implementation of "read a qledger-v1 rollup's inbox entries from the
// chain", written so that no wrapper can hide a post from it.
//
// For every inbox post the chain emits an `rdk_data_posted` event with the post's sequence, its
// poster and `data_hash` = sha256(payload). The chain does not serve the payload by sequence (the
// posted-data query returns only the hash), so a reader has to recover the bytes from the
// transaction that posted them. The RDK's fetcher looks only at top-level MsgPostRollupData
// messages, so a post wrapped in an authz MsgExec (or any other wrapper) defeats it. That is how
// `wicketgate-pay` batch 12 was finalised unchallenged on 19 November 2026.
//
// This reader never asks *where* the payload sits. It decodes every string anywhere in the
// transaction record as base64, walks any protobuf inside those bytes (a wrapper that could not be
// decoded to JSON still carries the post as a length-delimited field), and keeps the byte string
// whose sha256 equals the event's data_hash. The chain committed to that hash, so the match is the
// payload whatever the wrapper, field name, encoding or nesting depth, and nothing that is not the
// payload can match. The poster is taken from the chain's own event, not from a message field.
// Deposits are rebuilt from `rdk_rollup_deposit` events exactly as the RDK does. The whole range is
// then checked against the chain's inbox accumulator, so a wrong, missing or reordered entry is an
// error, never a silent difference.
//
// Wicketgate runs this reader in one watcher and the RDK reader (with wrapped posts hoisted, see
// robust-rest.ts) in the others, so a bug in either implementation cannot blind every watcher.
import {
  encodeQledgerDeposit,
  hexToBytes,
  isRestNotFound,
  postedDataHash,
  qledgerAccumulate,
  QLEDGER_DEPOSIT_POSTER_PREFIX,
  type QledgerEntry,
  type RestClient,
} from "@qorechain/rdk";

const POSTED = "rdk_data_posted";
const DEPOSIT = "rdk_rollup_deposit";
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_DEPTH = 32;
const MAX_CANDIDATES = 20_000;

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const norm = (h: string) => h.replace(/^0x/i, "").toLowerCase();

function attrs(ev: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of Array.isArray(ev?.attributes) ? ev.attributes : []) out[String(a.key)] = String(a.value ?? "");
  return out;
}

/** Read a protobuf varint at `i`; returns [value, next index] or undefined if malformed. */
function varint(b: Uint8Array, i: number): [number, number] | undefined {
  let v = 0, shift = 0;
  while (i < b.length && shift < 35) {
    const c = b[i++];
    v += (c & 0x7f) * 2 ** shift;
    if ((c & 0x80) === 0) return [v, i];
    shift += 7;
  }
  return undefined;
}

/** Add `bytes` and, if it parses as protobuf, every length-delimited field inside it (recursively). */
function addBytes(bytes: Uint8Array, out: Map<string, Uint8Array>, depth: number) {
  if (out.size >= MAX_CANDIDATES || bytes.length === 0) return;
  out.set(toHex(postedDataHash(bytes)), bytes);
  if (depth > MAX_DEPTH) return;
  let i = 0;
  const found: Uint8Array[] = [];
  while (i < bytes.length) {
    const k = varint(bytes, i);
    if (!k || k[0] === 0) return; // not protobuf: keep only the whole blob
    i = k[1];
    const wire = k[0] & 7;
    if (wire === 0) { const v = varint(bytes, i); if (!v) return; i = v[1]; }
    else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else if (wire === 2) {
      const len = varint(bytes, i);
      if (!len || len[1] + len[0] > bytes.length) return;
      found.push(bytes.subarray(len[1], len[1] + len[0]));
      i = len[1] + len[0];
    } else return;
    if (i > bytes.length) return;
  }
  for (const f of found) addBytes(f, out, depth + 1);
}

/**
 * Every byte string a transaction record could be carrying a post in, keyed by its sha256 (hex):
 * each string anywhere in the record that is valid base64, and every protobuf length-delimited
 * field inside those bytes.
 */
export function payloadCandidates(node: unknown, out = new Map<string, Uint8Array>(), depth = 0): Map<string, Uint8Array> {
  if (node == null || depth > MAX_DEPTH || out.size >= MAX_CANDIDATES) return out;
  if (typeof node === "string") {
    if (node.length >= 4 && node.length % 4 === 0 && B64.test(node)) addBytes(new Uint8Array(Buffer.from(node, "base64")), out, depth);
  } else if (Array.isArray(node)) {
    for (const x of node) payloadCandidates(x, out, depth + 1);
  } else if (typeof node === "object") {
    for (const v of Object.values(node as Record<string, unknown>)) payloadCandidates(v, out, depth + 1);
  }
  return out;
}

/**
 * This reader's own incremental search, deliberately separate from robust-rest.ts so the two
 * readers share no code above the HTTP client: each query is fetched in full once, then only from
 * the last height seen (inclusive, deduplicated by hash), following pages past the RDK's 5,000 cap.
 */
const searches = new WeakMap<object, Map<string, { txs: any[]; seen: Set<string>; next: number; at: number }>>();
async function search(rest: RestClient, query: string): Promise<any[]> {
  let m = searches.get(rest);
  if (!m) { m = new Map(); searches.set(rest, m); }
  let c = m.get(query);
  if (!c) { c = { txs: [], seen: new Set(), next: 0, at: 0 }; m.set(query, c); }
  if (Date.now() - c.at < 2_000) return c.txs;
  for (;;) {
    const fresh = (await rest.searchTxs(c.next > 0 ? `${query} AND tx.height>=${c.next}` : query)) as any[];
    let added = 0;
    for (const tx of fresh ?? []) {
      const k = String(tx?.txhash ?? "");
      if (!k || c.seen.has(k)) continue;
      c.seen.add(k);
      c.txs.push(tx);
      added++;
      c.next = Math.max(c.next, Number(tx?.height ?? 0));
    }
    if (!fresh || fresh.length < 5_000 || added === 0) break;
  }
  c.at = Date.now();
  return c.txs;
}

export interface EntriesInput {
  chainId: string;
  rollupId: string;
  /** last sequence already consumed (exclusive) */
  from: number | bigint;
  /** last sequence to read (inclusive) */
  to: number | bigint;
  /** the chain's inbox accumulator after `from` */
  accFrom: Uint8Array | string;
}

/**
 * Read inbox entries (from, to] of a qledger-v1 rollup, recovering each post's payload by its
 * committed hash wherever it sits in the posting transaction, and verify the range against the
 * chain's inbox accumulator. Same contract as the RDK's fetchQledgerEntries.
 */
export async function fetchEntriesIndependent(rest: RestClient, input: EntriesInput): Promise<QledgerEntry[]> {
  const from = BigInt(input.from);
  const to = BigInt(input.to);
  const q = (t: string) => `${t}.rollup_id='${input.rollupId}'`;
  // The chain's accumulator to check against. The node prunes old posted-data records, so when
  // the one at `to` is gone, read on to the inbox head and check the head's accumulator instead:
  // the accumulator is a hash chain, so a match at the head authenticates every entry before it.
  let want: string | undefined;
  let upto = to;
  try {
    want = (await rest.getPostedData(input.rollupId, to as any)).inboxAcc;
  } catch (err) {
    if (!isRestNotFound(err) && !/\b404\b/.test(String((err as any)?.message ?? err))) throw err;
    const inbox = await rest.getInbox(input.rollupId);
    if (BigInt(inbox.headSequence) >= to) { upto = BigInt(inbox.headSequence); want = inbox.headAcc; }
  }
  if (!want) throw new Error(`independent reader: the chain no longer holds the inbox accumulator at ${to}`);
  const bySeq = new Map<bigint, QledgerEntry>();
  const put = (seq: bigint, e: QledgerEntry) => {
    const prev = bySeq.get(seq);
    if (prev && toHex(postedDataHash(prev.payload)) !== toHex(postedDataHash(e.payload))) {
      throw new Error(`independent reader: two different payloads for inbox entry ${seq} of ${input.rollupId}`);
    }
    bySeq.set(seq, e);
  };

  for (const tx of await search(rest, q(POSTED))) {
    const height = BigInt(String(tx?.height ?? "0"));
    let candidates: Map<string, Uint8Array> | undefined;
    for (const ev of tx?.events ?? []) {
      if (ev?.type !== POSTED) continue;
      const a = attrs(ev);
      if (a.rollup_id !== input.rollupId) continue;
      const seq = BigInt(a.sequence ?? "0");
      if (seq <= from || seq > upto) continue;
      candidates ??= payloadCandidates(tx);
      const payload = candidates.get(norm(a.data_hash ?? ""));
      if (!payload) {
        throw new Error(`independent reader: the payload of inbox entry ${seq} (data hash ${a.data_hash}) is not anywhere in transaction ${tx?.txhash}`);
      }
      put(seq, { height, poster: a.poster, payload: Uint8Array.from(payload) } as QledgerEntry);
    }
  }

  for (const tx of await search(rest, q(DEPOSIT))) {
    const height = BigInt(String(tx?.height ?? "0"));
    for (const ev of tx?.events ?? []) {
      if (ev?.type !== DEPOSIT) continue;
      const a = attrs(ev);
      if (a.rollup_id !== input.rollupId) continue;
      const seq = BigInt(a.sequence ?? "0");
      if (seq <= from || seq > upto) continue;
      const amount = BigInt((a.amount ?? "0").replace(/uqor$/, ""));
      put(seq, { height, poster: QLEDGER_DEPOSIT_POSTER_PREFIX + a.depositor, payload: encodeQledgerDeposit(hexToBytes(a.account), amount) } as QledgerEntry);
    }
  }

  const entries: QledgerEntry[] = [];
  for (let s = from + 1n; s <= upto; s++) {
    const e = bySeq.get(s);
    if (!e) throw new Error(`independent reader: inbox entry ${s} of ${input.rollupId} was not found in the node's transaction index`);
    entries.push(e);
  }

  const accTo = toHex(qledgerAccumulate({ chainId: input.chainId, rollupId: input.rollupId, from, accFrom: input.accFrom, entries } as any));
  if (norm(want) !== accTo) throw new Error(`independent reader: entries read back for ${input.rollupId} do not match the chain's inbox accumulator at ${upto}`);
  return entries.slice(0, Number(to - from));
}
