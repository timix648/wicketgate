// Operator: POST /api/operator/done { id, txHash?, error? }
import { completeItem } from "../../../../lib/server/queues";
import { fail, guarded, json, operatorAuth, readJson } from "../../../../lib/server/http";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const denied = operatorAuth(req);
  if (denied) return denied;
  return guarded(async () => {
    const parsed = await readJson(req, 4096);
    if ("error" in parsed) return parsed.error;
    const { id, txHash, error } = parsed.body;
    if (typeof id !== "string") return fail(400, "id is required");
    if (typeof txHash !== "string" && typeof error !== "string") return fail(400, "Send txHash when posted or error when refused");
    const r = await completeItem("relay", id, typeof txHash === "string" ? { status: "posted", txHash } : { status: "failed", error: String(error) });
    return r.ok ? json({ ok: true }) : fail(r.status, r.error);
  });
}
