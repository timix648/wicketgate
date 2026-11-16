// Probe 2: rebuild a qledger-v1 rollup's state from the chain alone and compare
// with what each batch published. Read-only: needs no key and no funds.
import {
  RestClient,
  QledgerLedger,
  EMPTY_INBOX_ACC,
  executeQledger,
  fetchQledgerEntries,
  qledgerAccumulate,
  bytesToHex,
} from "@qorechain/rdk";

const REST = process.env.QORE_REST ?? "https://api-testnet.qore.host";
const CHAIN_ID = process.env.QORE_CHAIN_ID ?? "qorechain-diana";
const ROLLUP = process.argv[2] ?? "rdk-v328-e2e-mwd5v89d";

const hex = (v: Uint8Array | string) =>
  (typeof v === "string" ? v : bytesToHex(v)).replace(/^0x/, "").toLowerCase();

async function main() {
  const rest = new RestClient(REST);
  const rollup = await rest.getRollup(ROLLUP);
  const inbox = await rest.getInbox(ROLLUP);
  console.log(`rollup ${ROLLUP}: status=${rollup.status} inbox head=${inbox.headSequence} consumed=${inbox.consumedSequence}`);

  const ledger = new QledgerLedger();
  let acc: Uint8Array | string = EMPTY_INBOX_ACC;
  let position = 0;
  let allMatch = true;

  for (let index = 0; ; index++) {
    let batch;
    try {
      batch = await rest.getBatch(ROLLUP, index);
    } catch {
      break; // no more batches
    }
    if (batch.status === "rejected") {
      console.log(`batch ${index}: rejected on chain, skipped`);
      continue;
    }
    const entries = await fetchQledgerEntries(rest, {
      chainId: CHAIN_ID,
      rollupId: ROLLUP,
      from: batch.inboxStart,
      to: batch.inboxEnd,
      accFrom: acc,
    });
    const result = executeQledger({ chainId: CHAIN_ID, rollupId: ROLLUP }, ledger, entries);
    const stateOk = hex(result.stateRoot) === hex(batch.stateRoot);
    const wdOk = hex(result.withdrawalsRoot) === hex(batch.withdrawalsRoot);
    allMatch &&= stateOk && wdOk;
    console.log(
      `batch ${index} [${batch.status}] entries ${batch.inboxStart + 1}..${batch.inboxEnd}: ` +
        `stateRoot ${stateOk ? "MATCH" : "MISMATCH"} withdrawalsRoot ${wdOk ? "MATCH" : "MISMATCH"} ` +
        `withdrawals=${result.withdrawals.length}`,
    );
    for (const w of result.withdrawals) console.log(`   withdrawal #${w.index} -> ${w.recipient} ${w.amount} uqor`);
    acc = qledgerAccumulate({ chainId: CHAIN_ID, rollupId: ROLLUP, from: batch.inboxStart, accFrom: acc, entries });
    position = batch.inboxEnd;
  }

  if (inbox.headSequence > position) {
    const pending = await fetchQledgerEntries(rest, {
      chainId: CHAIN_ID, rollupId: ROLLUP, from: position, to: inbox.headSequence, accFrom: acc,
    });
    console.log(`${pending.length} posts waiting unbatched (sequences ${position + 1}..${inbox.headSequence}), oldest at height ${pending[0]?.height}`);
  }
  console.log(`accounts in ledger: ${ledger.accounts().length}`);
  console.log(allMatch ? "RESULT: every batch reproduced from chain data" : "RESULT: mismatch found");
  if (!allMatch) process.exitCode = 1;
}

main().catch((e) => {
  console.error("probe failed:", e?.message ?? e);
  process.exitCode = 2;
});
