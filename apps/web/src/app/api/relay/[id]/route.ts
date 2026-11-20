// GET /api/relay/{id} -> { status: "queued" | "posted" | "failed", txHash?, error? }
import { getStore } from "../../../../lib/server/store";
import { publicRelay, type RelayItem } from "../../../../lib/server/queues";
import { fail, guarded, json } from "../../../../lib/server/http";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return guarded(async () => {
    const { id } = await params;
    const item = await getStore().get("relay", id);
    return item ? json(publicRelay(item as RelayItem)) : fail(404, "No such relay request");
  });
}
