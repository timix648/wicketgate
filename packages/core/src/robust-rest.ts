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
import type { RestClient } from "@qorechain/rdk";

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

/**
 * Return `rest` with `searchTxs` patched to hoist wrapped posts. The same instance is returned
 * (its method is replaced once); pass a RestClient built however you like (e.g. with politeFetch).
 */
export function robustRest<T extends RestClient>(rest: T): T {
  const anyRest = rest as any;
  if (anyRest.__robust) return rest;
  const orig = anyRest.searchTxs.bind(rest);
  anyRest.searchTxs = async (query: string, opts?: unknown) => {
    const txs = await orig(query, opts);
    if (Array.isArray(txs)) for (const tx of txs) hoistWrappedPosts(tx);
    return txs;
  };
  anyRest.__robust = true;
  return rest;
}
