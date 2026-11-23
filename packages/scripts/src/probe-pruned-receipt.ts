// Shows a receipt still verifies once the chain prunes its batch record, against the real chain:
// only two answers are simulated (batch 0 -> 404, and the chain height moved past the retention
// window); the anchor, the creator's key and the ML-DSA-87 signature check are all real. A
// receipt with a forged state root must still fail.   npx tsx src/probe-pruned-receipt.ts
import { readFileSync } from "node:fs";
import { createRdkClient } from "@qorechain/rdk";
import { NET } from "@wicketgate/core/env";
import { verifyReceiptPruneSafe } from "@wicketgate/core/pruned-receipts";

const receipt = JSON.parse(readFileSync(new URL("../../../receipts/wicketgate-pay/batch-0.json", import.meta.url), "utf8")).receipt;
const real = globalThis.fetch;
globalThis.fetch = (async (u: any, i?: any) => {
  const url = String(u);
  if (url.endsWith(`/qorechain/rdk/v1/batch/${receipt.rollupId}/0`)) return new Response('{"code":5,"message":"not found"}', { status: 404 });
  if (url.includes("/blocks/latest")) {
    const j: any = await (await real(u, i)).json();
    j.block.header.height = String(Number(j.block.header.height) + 432000);
    return new Response(JSON.stringify(j), { status: 200 });
  }
  return real(u, i);
}) as typeof fetch;

const client = createRdkClient({ network: "testnet", endpoints: { rest: NET.rest, rpc: NET.rpc } as any });
const gone = (c: any) => new Proxy(c.rest, { get(t, p, r) {
  if (p === "getBatch") return async (id: string, n: any) => { if (Number(n) === 0) throw Object.assign(new Error("REST GET batch 0 failed: 404 Not Found"), { status: 404 }); return t.getBatch(id, n); };
  const v = Reflect.get(t, p, r); return typeof v === "function" ? v.bind(t) : v; } });
const c2 = { ...client, rest: gone(client) } as any;

const ok = await verifyReceiptPruneSafe(receipt, c2, NET.rest);
console.log(`genuine receipt, batch record pruned: ${ok.valid ? "VALID" : "INVALID"} pruned=${ok.pruned} ${Object.values(ok.checks).filter(Boolean).length}/${Object.keys(ok.checks).length} checks${ok.reason ? ` (${ok.reason})` : ""}`);
const forged = { ...receipt, stateRoot: "ff" + receipt.stateRoot.slice(2), batchStateRoot: "ff" + receipt.batchStateRoot.slice(2) };
const bad = await verifyReceiptPruneSafe(forged, c2, NET.rest);
console.log(`forged state root, batch record pruned:  ${bad.valid ? "VALID (BAD)" : "INVALID"}${bad.reason ? ` (${bad.reason})` : ""}`);
if (!ok.valid || bad.valid) process.exitCode = 1;
