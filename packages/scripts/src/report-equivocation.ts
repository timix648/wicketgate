// Report a watcher that signed two different results for the same batch (pool v3). Each piece of
// evidence is either the hash of the watcher's on-chain `attest` transaction (its signature is in
// the calldata) or a JSON file { "facts": { stateRoot, withdrawalsRoot, exitRoot }, "signature": "0x…" }
// holding a signature the watcher gave out. The pool checks both ML-DSA-87 signatures on chain,
// freezes the batch, takes the watcher's free stake and credits the reporter half.
// The report is dry-run first and sent only if it would succeed.
// Usage: npx tsx src/report-equivocation.ts --as <NAME> --rollup <id> --batch <n> --watcher <0x…> --a <tx|file> --b <tx|file>
import { existsSync, readFileSync } from "node:fs";
import { decodeFunctionData, keccak256, toHex, type Address, type Hex } from "viem";
import { account, DEPLOYMENTS_FILE } from "@wicketgate/core/env";
import { artifact, closeWindow, openWindow, publicClient, walletFor, windowBudget } from "@wicketgate/core/evm";

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const POOL = JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8")).pool as Address;
const P = artifact("ExitPool").abi;

async function evidence(src: string, watcher: Address, rollupKey: Hex, batch: bigint) {
  if (existsSync(src)) {
    const j = JSON.parse(readFileSync(src, "utf8"));
    return { facts: j.facts, sig: j.signature as Hex, from: `file ${src}` };
  }
  const tx = await publicClient.getTransaction({ hash: src as Hex });
  if (tx.from.toLowerCase() !== watcher.toLowerCase()) throw new Error(`${src} was sent by ${tx.from}, not the watcher`);
  const d = decodeFunctionData({ abi: P, data: tx.input });
  if (d.functionName !== "attest") throw new Error(`${src} is not an attest call`);
  const [rk, idx, facts, sig] = d.args as any[];
  if (rk !== rollupKey || idx !== batch) throw new Error(`${src} attests another batch`);
  return { facts, sig: sig as Hex, from: `attest tx ${src}` };
}

async function main() {
  const name = arg("as"), rollup = arg("rollup"), batch = arg("batch"), watcher = arg("watcher") as Address, a = arg("a"), b = arg("b");
  if (!name || !rollup || batch === undefined || !watcher || !a || !b) throw new Error("usage: report-equivocation.ts --as <NAME> --rollup <id> --batch <n> --watcher <0x…> --a <tx|file> --b <tx|file>");
  const me = await account(name);
  const rollupKey = keccak256(toHex(rollup));
  const idx = BigInt(batch);
  const e1 = await evidence(a, watcher, rollupKey, idx), e2 = await evidence(b, watcher, rollupKey, idx);
  console.log(`evidence 1: ${e1.from}\nevidence 2: ${e2.from}`);
  const callArgs = [rollupKey, idx, watcher, e1.facts, e1.sig, e2.facts, e2.sig];
  try {
    const { result } = await publicClient.simulateContract({ address: POOL, abi: P, functionName: "reportEquivocation", args: callArgs, account: me.evm as Address } as any);
    console.log(`the pool accepts the evidence: penalty ${Number(result) / 1e18} QOR, half credited to you`);
  } catch (err: any) {
    let c = err; while (c && !c.data?.errorName) c = c.cause;
    throw new Error(`the pool refuses this report: ${c?.data?.errorName ?? err.shortMessage ?? err.message}`);
  }
  await openWindow(me, { blocks: 300, maxTxs: 1, maxValueUqor: await windowBudget(1, 1_500_000n), allowedTargets: [POOL] });
  try {
    const hash = await walletFor(me).writeContract({ address: POOL, abi: P, functionName: "reportEquivocation", args: callArgs, gas: 1_500_000n } as any);
    const rc = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`reportEquivocation: ${rc.status} ${hash}`);
  } finally {
    await closeWindow(me);
  }
}
main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exitCode = 1; });
