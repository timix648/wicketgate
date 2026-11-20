// POST /api/exit { rollupId, beneficiary, salt, amountUqor }: queue an instant exit for the operator to take.
import { enqueueExit } from "../../../lib/server/queues";
import { fail, guarded, json, readJson } from "../../../lib/server/http";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return guarded(async () => {
    const parsed = await readJson(req, 2048);
    if ("error" in parsed) return parsed.error;
    const r = await enqueueExit(parsed.body);
    if (!r.ok) return fail(r.status, r.error);
    const { id, exitAddr, duplicate } = r.value;
    return json({ queued: true, id, ...(exitAddr ? { exitAddr } : {}), ...(duplicate ? { duplicate: true } : {}) }, duplicate ? 200 : 202);
  });
}
