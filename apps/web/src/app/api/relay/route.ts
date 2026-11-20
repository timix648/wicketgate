// POST /api/relay { rollupId, tx }: queue a user's signed rollup transaction for the operator to post.
import { enqueueRelay, MAX_TX_BYTES } from "../../../lib/server/queues";
import { fail, guarded, json, readJson, ROLLUP_ID } from "../../../lib/server/http";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return guarded(async () => {
    const parsed = await readJson(req, MAX_TX_BYTES * 2 + 512);
    if ("error" in parsed) return parsed.error;
    const { rollupId, tx } = parsed.body;
    if (typeof rollupId !== "string" || !ROLLUP_ID.test(rollupId)) return fail(400, "rollupId is missing or malformed");
    if (typeof tx !== "string") return fail(400, "tx must be a hex string");
    const r = await enqueueRelay(rollupId, tx);
    if (!r.ok) return fail(r.status, r.error);
    return json({ queued: true, id: r.value.id, ...(r.value.duplicate ? { duplicate: true } : {}) }, r.value.duplicate ? 200 : 202);
  });
}
