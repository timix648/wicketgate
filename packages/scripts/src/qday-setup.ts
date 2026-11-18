// Q-Day simulation, step 1: the victim and the attacker.
//  - W4 is a watcher whose secp256k1 private key is a 40-bit number: weak on purpose, so that an
//    ordinary computer can do to it what Shor's algorithm will do to every secp256k1 key. Its
//    ML-DSA-87 key comes from a separate 256-bit secret, as the SDK's unifiedAccountFromSeed allows.
//  - MALLORY is the attacker, an ordinary account.
// Creates both in the key file if missing (secrets are never printed), funds them from W1, registers
// their ML-DSA-87 keys (W4's registration also puts its classical public key on chain, which is all
// the attacker gets), and makes W4 a watcher in the live registry and in the classical twin pool.
// Usage: npx tsx src/qday-setup.ts
import { appendFileSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { generateMnemonic } from "@qorechain/sdk";
import { account, qdayAccount, KEYS_FILE, DEPLOYMENTS_FILE } from "@wicketgate/core/env";
import { balanceUqor, pqcStatus, registerPqc, sendNative, explorerTx, qor } from "@wicketgate/core/chain";
import { artifact, closeWindow, openWindow, publicClient, walletFor, windowBudget } from "@wicketgate/core/evm";
import type { Address } from "viem";

const WEAK_BITS = 40n;

function ensureKeys() {
  const text = readFileSync(KEYS_FILE, "utf8");
  const add: string[] = [];
  if (!/WG_W4_WEAK_KEY=/.test(text)) {
    // a uniformly random scalar in [2^39, 2^40)
    let k = 0n;
    for (const b of randomBytes(5)) k = (k << 8n) | BigInt(b);
    k = (k % (1n << (WEAK_BITS - 1n))) + (1n << (WEAK_BITS - 1n));
    add.push(`WG_W4_WEAK_KEY="${k.toString(16)}"`, `WG_W4_PQC_SECRET="${randomBytes(32).toString("hex")}"`);
  }
  if (!/WG_MALLORY_MNEMONIC=/.test(text)) add.push(`WG_MALLORY_MNEMONIC="${generateMnemonic()}"`);
  if (add.length) appendFileSync(KEYS_FILE, `\n# Q-Day simulation (qday-setup.ts)\n${add.join("\n")}\n`);
  return add.length > 0;
}

async function fund(to: string, want: bigint) {
  const have = await balanceUqor(to);
  if (have >= want) return;
  const w1 = await account("W1");
  const r = await sendNative(w1, [{ typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { fromAddress: w1.cosmos, toAddress: to, amount: [{ denom: "uqor", amount: String(want - have) }] } }]);
  console.log(`funded ${to} with ${qor(want - have)} QOR: ${explorerTx(r.transactionHash)}`);
}

async function join(acc: any, registry: Address, abi: any, stakeUqor: bigint, label: string) {
  if (await publicClient.readContract({ address: registry, abi, functionName: "isActive", args: [acc.evm] })) return console.log(`W4 already a watcher in ${label}`);
  await openWindow(acc, { blocks: 300, maxTxs: 1, maxValueUqor: await windowBudget(1, 400_000n, stakeUqor), allowedTargets: [registry] });
  try {
    const hash = await walletFor(acc).writeContract({ address: registry, abi, functionName: "join", args: [], value: stakeUqor * 10n ** 12n, gas: 300_000n } as any);
    const rc = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`W4 joined ${label} (${registry}) with ${qor(stakeUqor)} QOR: ${rc.status} ${hash}`);
  } finally {
    await closeWindow(acc);
  }
}

async function main() {
  if (ensureKeys()) console.log(`new Q-Day keys written to ${KEYS_FILE} (not printed)`);
  const w4 = await qdayAccount("W4"), mal = await qdayAccount("MALLORY");
  console.log(`W4 (victim watcher, 40-bit classical key): ${w4.cosmos} ${w4.evm}`);
  console.log(`MALLORY (attacker):                       ${mal.cosmos} ${mal.evm}`);
  await fund(w4.cosmos, 12_000_000n);
  await fund(mal.cosmos, 8_000_000n);
  for (const [n, a] of [["W4", w4], ["MALLORY", mal]] as const) {
    if (!(await pqcStatus(a.cosmos)).registered) {
      const r = await registerPqc(a);
      console.log(`${n} ML-DSA-87 key registered: ${explorerTx(r.transactionHash)}`);
    }
  }
  const dep = JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8"));
  await join(w4, dep.registry, artifact("WatcherRegistry").abi, 5_000_000n, "Wicketgate's live registry");
}
main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exitCode = 1; });
