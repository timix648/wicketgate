// Deploys an AgentVault on diana: owner VAULT_OWNER, agent AGENT (its ML-DSA-87 key registered with
// proof of possession), recognised pools = Wicketgate's main pool + every LaneHub lane, cap 50% per
// pool; funds it with 20 QOR. Writes deployments/agentvault.json.  Usage: npx tsx src/vault-deploy.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import { account, NET } from "@wicketgate/core/env";
import { balanceUqor, pqcStatus, registerPqc, sendNative, qor, explorerTx } from "@wicketgate/core/chain";
import { artifact, closeWindow, openWindow, publicClient, walletFor, windowBudget, withAccountLock } from "@wicketgate/core/evm";

const ROOT = new URL("../../../", import.meta.url);
const OUT = new URL("deployments/agentvault.json", ROOT);
const QOR = 10n ** 18n;

async function ready(role: string, wantQor: number) {
  const a = await account(role);
  const have = await balanceUqor(a.cosmos), want = BigInt(wantQor) * 1_000_000n;
  if (have < want) {
    const W1 = await account("W1");
    const r = await sendNative(W1, [{ typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { fromAddress: W1.cosmos, toAddress: a.cosmos, amount: [{ denom: "uqor", amount: String(want - have) }] } }]);
    console.log(`funded ${role} with ${qor(want - have)}: ${explorerTx(r.transactionHash)}`);
  }
  if (!(await pqcStatus(a.cosmos)).registered) console.log(`${role} ML-DSA-87 key registered: ${explorerTx((await registerPqc(a)).transactionHash)}`);
  return a;
}

async function main() {
  if (existsSync(OUT)) throw new Error("deployments/agentvault.json exists");
  const owner = await ready("VAULT_OWNER", 25);
  const agent = await ready("AGENT", 3);
  const main = JSON.parse(readFileSync(new URL("deployments/diana.json", ROOT), "utf8")).pool as Address;
  const hub = JSON.parse(readFileSync(new URL("deployments/lanehub.json", ROOT), "utf8")).hub as Address;
  const v = artifact("AgentVault");
  const bytecode = JSON.parse(readFileSync(new URL("contracts/out/AgentVault.sol/AgentVault.json", ROOT), "utf8")).bytecode.object as Hex;
  await withAccountLock(owner, async () => {
    await openWindow(owner, { blocks: 600, maxTxs: 2, maxValueUqor: await windowBudget(2, 3_000_000n, 20_000_000n) });
    try {
      const w = walletFor(owner);
      const hash = await w.deployContract({ abi: v.abi, bytecode, args: [owner.evm, agent.evm, main, hub, 5000] } as any);
      const rc = await publicClient.waitForTransactionReceipt({ hash });
      if (rc.status !== "success" || !rc.contractAddress) throw new Error(`deploy failed ${hash}`);
      console.log(`AgentVault ${rc.contractAddress} (tx ${hash})`);
      const f = await w.writeContract({ address: rc.contractAddress, abi: v.abi, functionName: "fund", args: [], value: 20n * QOR } as any);
      await publicClient.waitForTransactionReceipt({ hash: f });
      console.log(`funded 20 QOR: ${f}`);
      writeFileSync(OUT, JSON.stringify({ network: NET.chainId, vault: rc.contractAddress, deployTx: hash, deployBlock: Number(rc.blockNumber), owner: owner.evm, agent: agent.evm, mainPool: main, hub, maxPerPoolBps: 5000, deployedAt: new Date().toISOString() }, null, 2) + "\n");
    } finally {
      await closeWindow(owner);
    }
  });
}
main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exitCode = 1; });
