// Launches Wicketgate's own rollup: a based, optimistic qledger-v1 rollup created by ADMIN_A
// (so its batches are anchored with ADMIN_A's ML-DSA-87 key), bonds ADMIN_A as submitter,
// and opens an ExitPool lane for it. Needs about 12,100 test QOR on ADMIN_A.
// Usage: pnpm launch [rollup-id]
import { createRollupMsg, bondRollupSubmitterMsg, RestClient, isValidRollupId } from "@qorechain/rdk";
import { account, NET } from "@wicketgate/core/env";
import { balanceUqor, sendNative, explorerTx, qor } from "@wicketgate/core/chain";
import { setLane } from "./lane.js";

const ID = process.argv[2] ?? "wicketgate-pay";
const STAKE = 10_000_000_000n; // 10,000 QOR (1% burned at creation)
const LAYER = 1_000_000_000n; // 1,000 QOR locked for the layer registration
const BOND = 1_000_000_000n; // 1,000 QOR submitter bond

async function main() {
  if (!isValidRollupId(ID)) throw new Error(`invalid rollup id ${ID}`);
  const A = await account("ADMIN_A");
  const rest = new RestClient(NET.rest);
  const have = await balanceUqor(A.cosmos);
  const need = STAKE + LAYER + BOND + 20_000_000n;
  if (have < need) throw new Error(`ADMIN_A holds ${qor(have)}; launching needs about ${qor(need)}`);

  const exists = await rest.getRollup(ID).then(() => true, () => false);
  if (!exists) {
    const r = await sendNative(A, [createRollupMsg({
      creator: A.cosmos, rollupId: ID, profile: "nft", vmType: "cosmwasm", stakeAmount: STAKE.toString(),
      sequencing: "based", executionVm: "qledger-v1",
    } as any)], { gas: 1_500_000 });
    console.log(`rollup ${ID} created: ${explorerTx(r.transactionHash)}`);
  }
  const rollup: any = await rest.getRollup(ID);
  console.log(`  status ${rollup.status}, layer ${rollup.layerId || "(none)"}, challenge window ${rollup.challengeWindowSec ?? "?"} s`);
  const bond = await rest.getSubmitterBond(ID, A.cosmos).catch(() => undefined as any);
  if (!bond || BigInt(bond.amount ?? 0) === 0n) {
    const r = await sendNative(A, [bondRollupSubmitterMsg({ submitter: A.cosmos, rollupId: ID, amount: BOND.toString() })], { gas: 500_000 });
    console.log(`ADMIN_A bonded as submitter: ${explorerTx(r.transactionHash)}`);
  }
  const window = BigInt(Number(rollup.challengeWindowSec ?? 3600));
  await setLane(ID, { windowSecs: window, graceSecs: 1800n, feeBps: 30, quorum: 2, lockPerWatcher: 4n * 10n ** 18n, enabled: true });
  console.log(`Done. Start the operator: cd packages/operator && npx tsx src/cli.ts --rollup ${ID}`);
}
main().catch((e) => {
  console.error(e.shortMessage ?? e.message ?? e);
  process.exitCode = 1;
});
