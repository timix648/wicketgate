// The normal (slow) path for a saved exit withdrawal that was never advanced: once its batch has
// finalised, execute the chain's MsgExecuteWithdrawal to the exit address, then sweep the exit
// address to the beneficiary with ExitPool.sweepToBeneficiary. Usage: pnpm withdraw
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  RestClient, QledgerLedger, EMPTY_INBOX_ACC, executeQledger, fetchQledgerEntries, qledgerAccumulate,
  qledgerWithdrawalProof, executeWithdrawalMsg, type QledgerWithdrawal,
} from "@qorechain/rdk";
import type { Address, Hex } from "viem";
import { account, NET, STATE_DIR, DEPLOYMENTS_FILE } from "@wicketgate/core/env";
import { sendNative, explorerTx } from "@wicketgate/core/chain";
import { artifact, closeWindow, openWindow, publicClient, walletFor, windowBudget } from "@wicketgate/core/evm";

const EXITS = join(STATE_DIR, "exits.json");
const ZERO = `0x${"00".repeat(32)}`;

async function main() {
  const A = await account("ADMIN_A");
  const pool = JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8")).pool as Address;
  const { abi } = artifact("ExitPool");
  const rest = new RestClient(NET.rest);
  const exits = JSON.parse(readFileSync(EXITS, "utf8"));
  for (const ex of exits) {
    if (ex.sweptTx) continue;
    if ((await publicClient.readContract({ address: pool, abi, functionName: "advanceOfExit", args: [ex.exitAddr] })) !== ZERO) continue;
    // find the finalised batch that carries this withdrawal
    const env = { chainId: NET.chainId, rollupId: ex.rollupId };
    const ledger = new QledgerLedger();
    let acc: Uint8Array | string = EMPTY_INBOX_ACC;
    let found: { index: number; ws: QledgerWithdrawal[]; k: number } | undefined;
    for (let i = 0; ; i++) {
      let b; try { b = await rest.getBatch(ex.rollupId, i); } catch { break; }
      if (b.status === "rejected") continue;
      const e = await fetchQledgerEntries(rest, { ...env, from: b.inboxStart, to: b.inboxEnd, accFrom: acc });
      const r = executeQledger(env, ledger, e);
      acc = qledgerAccumulate({ ...env, from: b.inboxStart, accFrom: acc, entries: e });
      const k = r.withdrawals.findIndex((w) => w.recipient === ex.recipient);
      if (k >= 0) { found = b.status === "finalized" ? { index: i, ws: r.withdrawals, k } : undefined; if (!found) console.log(`${ex.exitAddr}: batch ${i} not finalised yet`); break; }
    }
    if (!found) continue;
    const w = found.ws[found.k];
    const bal = await publicClient.getBalance({ address: ex.exitAddr });
    if (bal < w.amount * 10n ** 12n) {
      const r = await sendNative(A, [executeWithdrawalMsg({
        submitter: A.cosmos, rollupId: ex.rollupId, batchIndex: found.index, withdrawalIndex: w.index.toString(),
        recipient: w.recipient, denom: "uqor", amount: w.amount.toString(),
        proof: qledgerWithdrawalProof(NET.chainId, ex.rollupId, found.ws, found.k),
      })], { gas: 600_000 });
      ex.withdrawalTx = r.transactionHash;
      console.log(`withdrawal ${w.index} of ${ex.rollupId} batch ${found.index} paid by the chain to ${ex.exitAddr}: ${explorerTx(r.transactionHash)}`);
    }
    await openWindow(A, { blocks: 300, maxTxs: 1, maxValueUqor: await windowBudget(1, 1_000_000n), allowedTargets: [pool] });
    try {
      const hash = await walletFor(A).writeContract({ address: pool, abi, functionName: "sweepToBeneficiary", args: [A.evm, ex.salt] } as any);
      const rc = await publicClient.waitForTransactionReceipt({ hash });
      console.log(`sweepToBeneficiary: ${rc.status} ${hash}; exit balance now ${await publicClient.getBalance({ address: ex.exitAddr as Address })}`);
      ex.sweptTx = hash as Hex;
    } finally {
      await closeWindow(A);
    }
  }
  writeFileSync(EXITS, JSON.stringify(exits, null, 2));
}
main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exitCode = 1; });
