// GET /api/kem/{kem|account}/{address}: the chain's KEM-registry and PQC-account records for the
// exit operator, relayed because the chain's REST endpoint sends no CORS headers. Only the exit
// operator's two records pass. The relay cannot substitute a key: the wallet checks the key
// against the fingerprint pinned in the app and the operator's card signature (core/sealed-exit).
import { EXIT_OPERATOR } from "@wicketgate/core/sealed-exit";
import { NET } from "../../../../lib/config";
import { fail, guarded, json } from "../../../../lib/server/http";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return guarded(async () => {
    const { path } = await params;
    if (path.length !== 2 || !["kem", "account"].includes(path[0]) || path[1] !== EXIT_OPERATOR.address) return fail(404, "Only the exit operator's KEM and account records are relayed");
    const res = await fetch(`${NET.rest}/qorechain/pqc/v1/${path[0]}/${path[1]}`, { cache: "no-store" });
    if (!res.ok) return fail(502, `The chain answered ${res.status}`);
    return json(await res.json());
  });
}
