// POST /api/exit { rollupId, sealed }: queue an instant exit for the operator to take. `sealed` is
// the request { rollupId, beneficiary, salt, amountUqor } sealed in the browser with QoreSeal
// (ML-KEM-1024 + X25519) to the exit operator's key from the chain's KEM registry; this server
// cannot read it.
import { enqueueExit } from "../../../lib/server/queues";
import { fail, guarded, json, readJson } from "../../../lib/server/http";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return guarded(async () => {
    const parsed = await readJson(req, 10 * 1024);
    if ("error" in parsed) return parsed.error;
    const sender = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
    const r = await enqueueExit(parsed.body, sender);
    if (!r.ok) return fail(r.status, r.error);
    const { id, duplicate } = r.value;
    return json({ queued: true, id, sealed: true, ...(duplicate ? { duplicate: true } : {}) }, duplicate ? 200 : 202);
  });
}
