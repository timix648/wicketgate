// A based rollup's inbox is permissionless: anyone may post data, by any message path the chain
// allows. The RDK's own entry fetcher only matches a posted-data event to a **top-level**
// MsgPostRollupData in the same transaction, so a post made through a wrapper -- an authz
// `MsgExec`, or a smart-account `MsgExecuteCosmos` -- cannot be matched, and the fetch throws
// ("post N ... payload could not be matched"). One such post then wedges every operator and
// watcher that reads the rollup, because the inbox must be consumed in order.
//
// This happened on `wicketgate-pay` on 19 Nov 2026: inbox post 43 was a valid MsgPostRollupData
// wrapped in an authz MsgExec (a griefing vector, whether or not it was meant as one).
//
// robustRest patches a RestClient's `searchTxs` so that, for every transaction it returns, any
// MsgPostRollupData hidden inside a wrapper message (under any field, at any depth) is hoisted into
// the top-level message list. A wrapper the node cannot decode to JSON still defeats this path;
// independent-entries.ts covers that case by matching the committed data hash instead.
// It only adds messages the chain already executed; it removes and changes nothing, so a normal
// direct post behaves exactly as before. Every RDK function that reads posts (fetchQledgerEntries,
// planQledgerBatch, ...) then works through the wrapper with no other change.
import { fetchQledgerEntries, type RestClient } from "@qorechain/rdk";

const POST_TYPE = "/qorechain.rdk.v1.MsgPostRollupData";

/**
 * Collect every MsgPostRollupData anywhere inside a message tree, under any field name and at any
 * depth (authz MsgExec `msgs`, group proposals' `messages`, smart-account wrappers, nested
 * wrappers...). Walking every field means a new wrapper type needs no code change here.
 */
function collectPosts(node: any, out: any[], depth = 0) {
  if (!node || typeof node !== "object" || depth > 32) return;
  if (Array.isArray(node)) { for (const x of node) collectPosts(x, out, depth + 1); return; }
  if (node["@type"] === POST_TYPE) out.push(node);
  for (const v of Object.values(node)) if (v && typeof v === "object") collectPosts(v, out, depth + 1);
}

/** Mutate one transaction record in place so wrapped posts sit at the top level too. */
export function hoistWrappedPosts(tx: any): void {
  const body = tx?.tx?.body;
  const messages = body?.messages;
  if (!Array.isArray(messages)) return;
  const top = new Set(messages);
  const found: any[] = [];
  for (const m of messages) if (m?.["@type"] !== POST_TYPE) collectPosts(m, found);
  for (const p of found) if (!top.has(p)) messages.push(p);
}

interface QueryCache { txs: any[]; seen: Set<string>; next: number; at: number }
const FRESH_MS = 2_000;

/**
 * Event searches are append-only: a transaction, once indexed, never changes. The RDK re-runs the
 * same search (every post of a rollup, from genesis) for every batch it reads, and stops at 5,000
 * results. On a busy rollup that is tens of megabytes per batch (sealed-scouts-1: 34 MB, 1,756
 * transactions on 22 Nov 2026), so a watcher's cold start downloaded gigabytes and the node cut the
 * connection. Here each query is fetched in full once, then only from the last height seen
 * (inclusive, deduplicated by hash), and pages past the 5,000 cap are followed.
 */
async function incrementalSearch(cache: Map<string, QueryCache>, search: (q: string, o?: any) => Promise<any[]>, query: string, opts?: any): Promise<any[]> {
  let c = cache.get(query);
  if (!c) { c = { txs: [], seen: new Set(), next: 0, at: 0 }; cache.set(query, c); }
  if (Date.now() - c.at < FRESH_MS) return c.txs.slice();
  const cap = (opts?.pageLimit ?? 100) * (opts?.maxPages ?? 50);
  for (;;) {
    const fresh = await search(c.next > 0 ? `${query} AND tx.height>=${c.next}` : query, opts);
    let added = 0;
    for (const tx of Array.isArray(fresh) ? fresh : []) {
      const k = String(tx?.txhash ?? "");
      if (!k || c.seen.has(k)) continue;
      hoistWrappedPosts(tx);
      c.seen.add(k);
      c.txs.push(tx);
      added++;
      const h = Number(tx?.height ?? 0);
      if (h > c.next) c.next = h;
    }
    if (!Array.isArray(fresh) || fresh.length < cap || added === 0) break;
  }
  c.at = Date.now();
  return c.txs.slice();
}

/**
 * Return `rest` with `searchTxs` patched to hoist wrapped posts and to fetch each search
 * incrementally. The same instance is returned (its method is replaced once); pass a RestClient
 * built however you like (e.g. with politeFetch).
 */
export function robustRest<T extends RestClient>(rest: T): T {
  const anyRest = rest as any;
  if (anyRest.__robust) return rest;
  const orig = anyRest.searchTxs.bind(rest);
  const cache = new Map<string, QueryCache>();
  anyRest.searchTxs = (query: string, opts?: unknown) => incrementalSearch(cache, orig, query, opts);
  anyRest.__robust = true;
  return rest;
}

/**
 * fetchQledgerEntries that survives the node pruning old posted-data records. The RDK checks a
 * range against the accumulator recorded at its last sequence and gives up once the node no longer
 * serves that record, so a watcher started fresh cannot check old batches. When that happens, read
 * on to the inbox head and check against the head's accumulator, which (being a hash chain)
 * authenticates every entry before it, then return only the range asked for.
 */
export async function fetchQledgerEntriesPruneSafe(rest: RestClient, input: Parameters<typeof fetchQledgerEntries>[1]) {
  try {
    return await fetchQledgerEntries(rest, input);
  } catch (err) {
    if (!/no longer holds the accumulator|posted_data\/[^ ]+ failed: 404/.test(String((err as any)?.message ?? err))) throw err;
    const head = BigInt((await rest.getInbox(input.rollupId)).headSequence);
    const to = BigInt(input.to as any);
    if (head <= to) throw err;
    const all = await fetchQledgerEntries(rest, { ...input, to: head as any });
    return all.slice(0, Number(to - BigInt(input.from as any)));
  }
}
