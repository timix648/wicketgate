// Verify any settlement receipt file against the live chain: every field is re-read, nothing in the
// file is trusted. Works on receipts from any rollup, not only ours.
// Usage: npx tsx src/verify-receipt.ts <receipt.json> [more.json ...]
import { readFileSync } from "node:fs";
import { createRdkClient } from "@qorechain/rdk";
import { verifyReceiptPruneSafe } from "@wicketgate/core/pruned-receipts";
import { NET } from "@wicketgate/core/env";

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) throw new Error("usage: verify-receipt.ts <receipt.json> [more.json ...]");
  const client = createRdkClient({ network: "testnet", endpoints: { rest: NET.rest, rpc: NET.rpc } as any });
  let bad = 0;
  for (const f of files) {
    const j = JSON.parse(readFileSync(f, "utf8"));
    const receipt = j.receipt ?? j;
    const v = await verifyReceiptPruneSafe(receipt, client, NET.rest);
    const failed = Object.entries(v.checks).filter(([, ok]) => !ok).map(([k]) => k);
    console.log(`${v.valid ? "VALID  " : "INVALID"} ${f}: ${receipt.rollupId ?? ""} batch ${receipt.batchIndex ?? "?"}, ${Object.keys(v.checks).length - failed.length}/${Object.keys(v.checks).length} checks${failed.length ? `, failed: ${failed.join(", ")}` : ""}${v.reason ? ` (${v.reason})` : ""}${v.pruned ? ` [batch record pruned by the chain; checked against its permanent anchor]` : ""}`);
    if (!v.valid) bad++;
  }
  if (bad) process.exitCode = 1;
}
main().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
