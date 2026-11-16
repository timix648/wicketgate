// Shows what the next batch of a qledger-v1 rollup would do, by executing the pending inbox
// entries on top of the rebuilt ledger. Read-only.
import { RestClient, QledgerLedger, EMPTY_INBOX_ACC, executeQledger, fetchQledgerEntries, qledgerAccumulate, bytesToHex, decodeQledgerTx, decodeQledgerDeposit } from "@qorechain/rdk";
import { NET } from "@wicketgate/core/env";
import { buildExitTree } from "@wicketgate/core/exit-tree";

const ROLLUP = process.argv[2] ?? "rdk-v328-e2e-mwd5v89d";
async function main() {
  const rest = new RestClient(NET.rest);
  const env = { chainId: NET.chainId, rollupId: ROLLUP };
  const ledger = new QledgerLedger();
  let acc: Uint8Array | string = EMPTY_INBOX_ACC;
  for (let i = 0; ; i++) {
    let b; try { b = await rest.getBatch(ROLLUP, i); } catch { break; }
    if (b.status === "rejected") continue;
    const e = await fetchQledgerEntries(rest, { ...env, from: b.inboxStart, to: b.inboxEnd, accFrom: acc });
    executeQledger(env, ledger, e);
    acc = qledgerAccumulate({ ...env, from: b.inboxStart, accFrom: acc, entries: e });
  }
  const inbox = await rest.getInbox(ROLLUP);
  const entries = await fetchQledgerEntries(rest, { ...env, from: inbox.consumedSequence, to: inbox.headSequence, accFrom: acc });
  entries.forEach((e, k) => {
    const tx = decodeQledgerTx(e.payload), d = decodeQledgerDeposit(e.payload);
    const what = tx ? `${tx.kind === 1 ? "transfer" : "withdraw"} ${tx.amount} uqor nonce ${tx.nonce}${tx.recipient ? " to " + tx.recipient : ""}` : d ? `deposit ${d.amount} uqor to ${bytesToHex(d.account).slice(0, 16)}…` : `${e.payload.length}-byte post (not a ledger tx)`;
    console.log(`  entry ${inbox.consumedSequence + k + 1} @${e.height} by ${e.poster.slice(0, 20)}…: ${what}`);
  });
  const before = new Map(ledger.accounts().map((a) => [bytesToHex(a.id), a.balance]));
  const result = executeQledger(env, ledger, entries);
  for (const a of ledger.accounts()) {
    const was = before.get(bytesToHex(a.id)) ?? 0n;
    if (was !== a.balance) console.log(`  account ${bytesToHex(a.id).slice(0, 16)}…: ${was} -> ${a.balance} uqor`);
  }
  const tree = buildExitTree(result.withdrawals.map((w) => ({ index: w.index, recipient: w.recipient, amount: w.amount })));
  console.log(`next batch: ${entries.length} entries, ${result.withdrawals.length} withdrawals, state root ${bytesToHex(result.stateRoot).slice(0, 18)}…, exit root ${tree.root.slice(0, 18)}…`);
  for (const w of result.withdrawals) console.log(`  withdrawal #${w.index}: ${w.amount} uqor to ${w.recipient}`);
}
main().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
