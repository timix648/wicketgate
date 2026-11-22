// Operator: GET /api/operator/exits/pending?rollupId=<id> -> [{ id, rollupId, sealed }]
import { getStore } from "../../../../../lib/server/store";
import type { ExitItem } from "../../../../../lib/server/queues";
import { fail, guarded, json, operatorAuth, ROLLUP_ID } from "../../../../../lib/server/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = operatorAuth(req);
  if (denied) return denied;
  return guarded(async () => {
    const rollupId = new URL(req.url).searchParams.get("rollupId") ?? "";
    if (!ROLLUP_ID.test(rollupId)) return fail(400, "rollupId is required");
    const items = (await getStore().pending("exit", rollupId, 100)) as ExitItem[];
    return json(items.map(({ id, rollupId, sealed }) => ({ id, rollupId, sealed })));
  });
}
