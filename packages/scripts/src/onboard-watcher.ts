// Become a Wicketgate watcher with your own key. Reads WG_<NAME>_MNEMONIC from your key file
// (~/.wicketgate/keys.env, mode 600; a fresh testnet-only recovery phrase), registers the
// account's ML-DSA-87 key with proof of possession if it is not registered yet, and joins the
// live WatcherRegistry with the stake you choose, through an EVM window scoped to the registry
// that is closed straight after. Then run the watcher with --mode attest --as <NAME>.
// Usage: npx tsx src/onboard-watcher.ts <NAME> [stake QOR, default 5]
import { readFileSync } from "node:fs";
import type { Address } from "viem";
import { account, DEPLOYMENTS_FILE } from "@wicketgate/core/env";
import { balanceUqor, pqcStatus, registerPqc, explorerTx, qor } from "@wicketgate/core/chain";
import { artifact, closeWindow, openWindow, publicClient, walletFor, windowBudget } from "@wicketgate/core/evm";

async function main() {
  const name = process.argv[2];
  const stake = Number(process.argv[3] ?? "5");
  if (!name) throw new Error("usage: onboard-watcher.ts <NAME> [stake QOR]");
  const me = await account(name);
  const registry = JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8")).registry as Address;
  const R = artifact("WatcherRegistry").abi;
  const min = (await publicClient.readContract({ address: registry, abi: R, functionName: "minStake" })) as bigint;
  const stakeUqor = BigInt(Math.round(stake * 1e6));
  if (stakeUqor * 10n ** 12n < min) throw new Error(`the registry needs at least ${Number(min) / 1e18} QOR of stake`);
  console.log(`watcher ${name}: ${me.cosmos} ${me.evm}`);
  const bal = await balanceUqor(me.cosmos);
  if (bal < stakeUqor + 1_000_000n) throw new Error(`balance ${qor(bal)}; fund it with at least ${stake + 1} test QOR first (faucet)`);
  if (!(await pqcStatus(me.cosmos)).registered) {
    const r = await registerPqc(me);
    console.log(`ML-DSA-87 key registered with proof of possession: ${explorerTx(r.transactionHash)}`);
  } else console.log("ML-DSA-87 key already registered");
  if (await publicClient.readContract({ address: registry, abi: R, functionName: "isActive", args: [me.evm] })) return console.log(`already an active watcher in ${registry}`);
  await openWindow(me, { blocks: 300, maxTxs: 1, maxValueUqor: await windowBudget(1, 400_000n, stakeUqor), allowedTargets: [registry] });
  try {
    const hash = await walletFor(me).writeContract({ address: registry, abi: R, functionName: "join", args: [], value: stakeUqor * 10n ** 12n, gas: 300_000n } as any);
    const rc = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`joined ${registry} with ${stake} QOR: ${rc.status} ${hash}`);
  } finally {
    await closeWindow(me);
  }
  console.log(`\nNow run it:  cd ../watcher && npx tsx src/cli.ts --mode attest --as ${name} --rollup all --interval 30 --feed ./feed`);
}
main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exitCode = 1; });
