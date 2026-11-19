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
// MsgPostRollupData hidden inside a wrapper message is hoisted into the top-level message list.
// It only adds messages the chain already executed; it removes and changes nothing, so a normal
// direct post behaves exactly as before. Every RDK function that reads posts (fetchQledgerEntries,
// planQledgerBatch, ...) then works through the wrapper with no other change.
import type { RestClient } from "@qorechain/rdk";

const POST_TYPE = "/qorechain.rdk.v1.MsgPostRollupData";
// message fields that can carry nested messages the chain unwraps and runs
const NESTED_FIELDS = ["msgs", "messages"] as const;

/** Collect every MsgPostRollupData anywhere inside a message tree (wrappers included). */
function collectPosts(msg: any, out: any[], depth = 0) {
  if (!msg || typeof msg !== "object" || depth > 6) return;
  if (msg["@type"] === POST_TYPE) out.push(msg);
  for (const f of NESTED_FIELDS) {
    const nested = msg[f];
    if (Array.isArray(nested)) for (const m of nested) collectPosts(m, out, depth + 1);
  }
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
