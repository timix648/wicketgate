// Operator: POST /api/operator/exits/done { id, status: "paid" | "failed", txHash?, error?, exitAddr? }
import { completeItem } from "../../../../../lib/server/queues";
import { fail, guarded, json, operatorAuth, readJson } from "../../../../../lib/server/http";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const denied = operatorAuth(req);
  if (denied) return denied;
  return guarded(async () => {
    const parsed = await readJson(req, 4096);
    if ("error" in parsed) return parsed.error;
    const { id, status, txHash, error, exitAddr } = parsed.body;
    if (typeof id !== "string") return fail(400, "id is required");
    if (status === "paid" && typeof txHash !== "string") return fail(400, "A paid exit needs its txHash");
    if (status === "failed" && typeof error !== "string") return fail(400, "A failed exit needs a plain error");
    if (status !== "paid" && status !== "failed") return fail(400, "status must be paid or failed");
    const r = await completeItem("exit", id, { status, ...(typeof txHash === "string" ? { txHash } : {}), ...(typeof error === "string" ? { error } : {}), ...(typeof exitAddr === "string" && /^0x[0-9a-fA-F]{40}$/.test(exitAddr) ? { exitAddr } : {}) });
    return r.ok ? json({ ok: true }) : fail(r.status, r.error);
  });
}
