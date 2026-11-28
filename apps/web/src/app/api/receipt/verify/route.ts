// POST /api/receipt/verify { receipt }: verify a settlement receipt against the live chain with
// @qorechain/rdk's verifySettlementReceipt. Every field is re-read from QoreChain; nothing in the
// receipt is trusted. This runs on the server because QoreChain's REST and RPC endpoints send no
// CORS headers, so a browser page cannot query them directly.
import { createHash } from "node:crypto";
import { createRdkClient, receiptSchemaError, type SettlementReceipt } from "@qorechain/rdk";
import { NET } from "../../../../lib/config";
import { verifyReceiptPruneSafe } from "@wicketgate/core/pruned-receipts";
import { fail, guarded, json, readJson } from "../../../../lib/server/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RPC = "https://rpc-testnet.qore.host";
const PER_MINUTE = 20;
const CACHE_MS = 5 * 60_000;
const NODE_BUSY = /\b(429|5\d\d)\b|Too Many Requests|timed? ?out|aborted|fetch failed|ECONNRESET|ENOTFOUND/i;

type Result = Awaited<ReturnType<typeof verifyReceiptPruneSafe>>;
const cache = new Map<string, { at: number; body: unknown }>();
// Per-instance limit: verification needs no queue storage, so it keeps working without Redis.
const hits = new Map<string, { n: number; until: number }>();
function limited(ip: string): boolean {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || h.until < now) {
    hits.set(ip, { n: 1, until: now + 60_000 });
    if (hits.size > 5000) hits.clear();
    return false;
  }
  return ++h.n > PER_MINUTE;
}

export async function POST(req: Request) {
  return guarded(async () => {
    const parsed = await readJson(req, 64 * 1024);
    if ("error" in parsed) return parsed.error;
    const raw = (parsed.body.receipt ?? parsed.body) as Record<string, unknown>;
    const receipt = ((raw as any).receipt ?? raw) as SettlementReceipt;
    const schema = receiptSchemaError(receipt);
    if (schema) return json({ valid: false, mode: "chain", checks: null, reason: `Not a receipt this checker understands: ${schema}` });

    const key = createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return json(hit.body);

    const ip = (req.headers.get("x-forwarded-for") ?? "local").split(",")[0].trim();
    if (limited(ip)) return fail(429, `At most ${PER_MINUTE} checks a minute`);

    const client = createRdkClient({ network: "testnet", endpoints: { rest: NET.rest, rpc: RPC } as any });
    // A throttled or failing node (429, 5xx, timeout) is not a verdict: the rdk folds those errors into
    // "not valid", which would brand a good receipt as forged. Retry, and if the node stays busy say so
    // (uncached) instead of answering.
    let v: Result | undefined;
    for (let i = 0; i < 3; i++) {
      try {
        v = await verifyReceiptPruneSafe(receipt, client, NET.rest);
      } catch (e) {
        if (i === 2) return fail(502, `Could not read the chain: ${e instanceof Error ? e.message : String(e)}`);
        v = undefined;
      }
      if (v && (v.valid || !NODE_BUSY.test(v.reason ?? ""))) break;
      if (i === 2) return fail(503, "The QoreChain node is rate-limiting or unavailable right now, so this receipt could not be checked. Try again in a minute.");
      await new Promise((r) => setTimeout(r, [3_000, 8_000][i]));
    }
    if (!v) return fail(503, "The QoreChain node did not answer; try again in a minute.");
    const body = {
      valid: v.valid,
      mode: v.mode,
      checks: v.checks,
      signBytesVersion: v.signBytesVersion ?? null,
      reason: v.reason ?? null,
      pruned: v.pruned,
      prunedReason: v.prunedReason ?? null,
      anchor: v.anchor ? { mainChainHeight: (v.anchor as any).mainChainHeight ?? null, layerHeight: (v.anchor as any).layerHeight ?? null } : null,
      checkedAt: new Date().toISOString(),
      chainId: NET.chainId,
    };
    cache.set(key, { at: Date.now(), body });
    if (cache.size > 500) cache.delete(cache.keys().next().value!);
    return json(body);
  });
}
