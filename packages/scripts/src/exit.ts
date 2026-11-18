// Instant exit: for each saved withdrawal to an exit address (from pnpm seed), find the batch
// that carries it in the watcher's feed, check the pool has confirmed that batch with the same
// facts, and call ExitPool.instantExit. Usage: pnpm exit [feed-dir]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { encodeAbiParameters, keccak256, toHex, type Address, type Hex } from "viem";
import { account, STATE_DIR, DEPLOYMENTS_FILE } from "@wicketgate/core/env";
import { artifact, closeWindow, openWindow, publicClient, walletFor, windowBudget } from "@wicketgate/core/evm";
import { verifyExitProof, exitLeaf } from "@wicketgate/core/exit-tree";

const FEED_DIR = process.argv[2] ?? join(STATE_DIR, "feed-w1");
const EXITS = join(STATE_DIR, "exits.json");
const ZERO = `0x${"00".repeat(32)}` as Hex;

async function main() {
  const A = await account("ADMIN_A");
  const pool = JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8")).pool as Address;
  const { abi } = artifact("ExitPool");
  const exits = existsSync(EXITS) ? JSON.parse(readFileSync(EXITS, "utf8")) : [];
  let changed = false;
  for (const ex of exits) {
    if (ex.advanceTx || ex.sweptTx) continue; // already exited, or collected the normal way
    if ((await publicClient.readContract({ address: pool, abi, functionName: "advanceOfExit", args: [ex.exitAddr] })) !== ZERO) {
      ex.advanceTx = "already-advanced";
      changed = true;
      continue;
    }
    const feed = JSON.parse(readFileSync(join(FEED_DIR, `${ex.rollupId}.json`), "utf8"));
    const batch = feed.batches.find((b: any) => b.verdict === "match" && b.withdrawals?.some((w: any) => w.recipient === ex.recipient));
    if (!batch) {
      console.log(`${ex.exitAddr}: not in any verified batch yet (waiting for a submitter to batch it)`);
      continue;
    }
    const w = batch.withdrawals.find((x: any) => x.recipient === ex.recipient);
    const facts = { stateRoot: batch.stateRoot as Hex, withdrawalsRoot: (batch.withdrawalsRoot === "0x" ? ZERO : batch.withdrawalsRoot) as Hex, exitRoot: batch.exitRoot as Hex };
    const rollupKey = keccak256(toHex(ex.rollupId));
    const bk = (await publicClient.readContract({ address: pool, abi, functionName: "batchKey", args: [rollupKey, BigInt(batch.index)] })) as Hex;
    const b = (await publicClient.readContract({ address: pool, abi, functionName: "getBatch", args: [bk] })) as any[];
    const fh = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }], [facts.stateRoot, facts.withdrawalsRoot, facts.exitRoot]));
    if (b[1] === 0n) { console.log(`batch ${batch.index}: not confirmed by the watchers yet`); continue; }
    if (b[2]) { console.log(`batch ${batch.index}: CONTESTED, the pool will not advance against it`); continue; }
    if (b[0] !== fh) { console.log(`batch ${batch.index}: the pool confirmed different facts than this feed; refusing`); continue; }
    // never trust the feed for the proof: re-check it locally against the confirmed root
    if (!verifyExitProof(w.exitProof, facts.exitRoot, exitLeaf(BigInt(w.index), ex.exitAddr, BigInt(w.amountUqor)))) {
      console.log(`batch ${batch.index}: exit proof does not verify; refusing`);
      continue;
    }
    // Dry-run the exit against the pool first: it reverts if the watchers cannot lock enough
    // stake (v2 locks at the advance), if the batch is contested, or if liquidity is short.
    const exitArgs = [rollupKey, BigInt(batch.index), facts, BigInt(w.index), A.evm, ex.salt, BigInt(w.amountUqor), w.exitProof];
    try {
      await publicClient.simulateContract({ address: pool, abi, functionName: "instantExit", args: exitArgs, account: A.evm as Address } as any);
    } catch (e: any) {
      console.log(`batch ${batch.index}: the pool would refuse this exit (${e?.shortMessage ?? e?.message}); not sending`);
      continue;
    }
    console.log(`batch ${batch.index} confirmed by ${b[7].length} watchers with ${Number(b[5]) / 1e18} QOR at stake; exiting ${Number(w.amountUqor) / 1e6} QOR`);
    await openWindow(A, { blocks: 300, maxTxs: 1, maxValueUqor: await windowBudget(1, 800_000n), allowedTargets: [pool] });
    try {
      const before = await publicClient.getBalance({ address: A.evm as Address });
      const hash = await walletFor(A).writeContract({
        address: pool, abi, functionName: "instantExit",
        args: exitArgs, gas: 600_000n,
      } as any);
      const rc = await publicClient.waitForTransactionReceipt({ hash });
      const got = (await publicClient.getBalance({ address: A.evm as Address })) - before;
      console.log(`instantExit: ${rc.status} ${hash}; received ${Number(got) / 1e18} QOR net of gas, before the batch has finalised`);
      ex.advanceTx = hash;
      ex.batchIndex = batch.index;
      changed = true;
    } finally {
      await closeWindow(A);
    }
  }
  if (changed) writeFileSync(EXITS, JSON.stringify(exits, null, 2));
}
main().catch((e) => {
  console.error(e.shortMessage ?? e.message ?? e);
  process.exitCode = 1;
});
