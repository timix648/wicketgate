// GET /api/exit/{id} -> { status: "queued" | "paid" | "failed", txHash?, error?, exitAddr? }
import { getStore } from "../../../../lib/server/store";
import { publicExit, type ExitItem } from "../../../../lib/server/queues";
import { fail, guarded, json } from "../../../../lib/server/http";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return guarded(async () => {
    const { id } = await params;
    const item = await getStore().get("exit", id);
    return item ? json(publicExit(item as ExitItem)) : fail(404, "No such exit request");
  });
}
