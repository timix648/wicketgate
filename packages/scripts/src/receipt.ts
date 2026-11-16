// Settlement receipt: build a portable receipt for an anchored batch of a rollup, then verify it
// by re-reading every field from the chain (a receipt is a claim, not evidence). Saves the
// receipt and the verification result under receipts/. Also shows that a tampered receipt fails.
// Usage: pnpm receipt [rollup-id] [batch-index]
import { mkdirSync, writeFileSync } from "node:fs";
import { createRdkClient, buildSettlementReceipt, verifySettlementReceipt, RestClient } from "@qorechain/rdk";
import { NET } from "@wicketgate/core/env";

const ROLLUP = process.argv[2] ?? "wicketgate-pay";

async function main() {
  const client = createRdkClient({ network: "testnet", endpoints: { rest: NET.rest, rpc: NET.rpc } as any });
  let index = process.argv[3] !== undefined ? Number(process.argv[3]) : undefined;
  if (index === undefined) {
    const latest = await new RestClient(NET.rest).getLatestBatch(ROLLUP);
    index = latest.batchIndex;
  }
  const receipt = await buildSettlementReceipt(client, ROLLUP, index);
  console.log(`receipt for ${ROLLUP} batch ${index}: layer ${receipt.layerId}, state root ${receipt.stateRoot.slice(0, 18)}…, signed by ${receipt.creator} (${receipt.algorithm}), anchored at main-chain height ${receipt.mainChainHeight}`);

  const v = await verifySettlementReceipt(receipt, { client });
  console.log(`verified against the chain: valid=${v.valid} mode=${v.mode}`);
  for (const [k, ok] of Object.entries(v.checks)) console.log(`  ${ok ? "PASS" : "FAIL"} ${k}`);
  if (v.reason) console.log(`  reason: ${v.reason}`);

  // a receipt with one changed field must not verify
  const forged = { ...receipt, stateRoot: receipt.stateRoot.replace(/.$/, (c) => (c === "0" ? "1" : "0")) };
  const fv = await verifySettlementReceipt(forged, { client });
  console.log(`tampered receipt (last nibble of the state root changed): valid=${fv.valid}${fv.reason ? ` (${fv.reason})` : ""}`);

  const dir = new URL("../../../receipts/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL(`${ROLLUP}-batch-${index}.json`, dir), JSON.stringify({ receipt, verification: { valid: v.valid, mode: v.mode, checks: v.checks, checkedAt: new Date().toISOString() } }, null, 2) + "\n");
  console.log(`saved receipts/${ROLLUP}-batch-${index}.json`);
  if (!v.valid) process.exitCode = 1;
}
main().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
