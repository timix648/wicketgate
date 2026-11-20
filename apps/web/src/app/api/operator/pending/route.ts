// Operator: GET /api/operator/pending?rollupId=<id> -> [{ id, rollupId, tx }]
import { getStore } from "../../../../lib/server/store";
import type { RelayItem } from "../../../../lib/server/queues";
import { fail, guarded, json, operatorAuth, ROLLUP_ID } from "../../../../lib/server/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = operatorAuth(req);
  if (denied) return denied;
  return guarded(async () => {
    const rollupId = new URL(req.url).searchParams.get("rollupId") ?? "";
    if (!ROLLUP_ID.test(rollupId)) return fail(400, "rollupId is required");
    const items = (await getStore().pending("relay", rollupId, 100)) as RelayItem[];
    return json(items.map(({ id, rollupId, tx }) => ({ id, rollupId, tx })));
  });
}
