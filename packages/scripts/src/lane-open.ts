// Permissionless lanes, live. Deploys the LaneHub once (from ADMIN_A; the hub has no owner and no
// admin), then acts as an OUTSIDE lane provider with its own two keys (LANE_A, LANE_B, not
// Wicketgate's admins): registers their ML-DSA-87 keys, opens an isolated lane for a rollup
// through the hub, binds and configures it with the provider's own post-quantum signatures, and
// funds it. Writes deployments/lanes/<rollup>.json in the same shape as deployments/diana.json,
// so the watcher, onboarding and exit tools work against it with WICKETGATE_DEPLOYMENTS=<file>.
// Usage: npx tsx src/lane-open.ts <rollup-id> [liquidity QOR, default 10]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { encodeAbiParameters, keccak256, parseEventLogs, toHex, type Address, type Hex } from "viem";
import { account, NET } from "@wicketgate/core/env";
import { balanceUqor, pqcStatus, registerPqc, sendNative, qor, explorerTx } from "@wicketgate/core/chain";
import { artifact, closeWindow, openWindow, pqSign, publicClient, walletFor, windowBudget } from "@wicketgate/core/evm";

const ROOT = new URL("../../../", import.meta.url);
const HUB_FILE = new URL("deployments/lanehub.json", ROOT);
const QOR = 10n ** 18n;
const rollupId = process.argv[2];
const liquidity = BigInt(process.argv[3] ?? "10");
const LANE_T = [{ type: "bytes32" }, { type: "tuple", components: [
  { name: "windowSecs", type: "uint64" }, { name: "graceSecs", type: "uint64" }, { name: "feeBps", type: "uint16" },
  { name: "quorum", type: "uint8" }, { name: "lockPerWatcher", type: "uint128" }, { name: "enabled", type: "bool" },
] }] as const;
const RISK_T = [{ type: "bytes32" }, { type: "tuple", components: [
  { name: "kinkBps", type: "uint16" }, { name: "maxFeeBps", type: "uint16" },
  { name: "maxExitWei", type: "uint128" }, { name: "maxOutstandingWei", type: "uint128" }, { name: "keeperTipWei", type: "uint128" },
] }] as const;

const rawCode = (name: string) => JSON.parse(readFileSync(new URL(`contracts/out/${name}.sol/${name}.json`, ROOT), "utf8")).bytecode.object as Hex;

async function tx(wallet: any, req: any, what: string) {
  const hash = await wallet.writeContract(req);
  const rc = await publicClient.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`${what} reverted: ${hash}`);
  console.log(`  ${what}: ${hash}`);
  return rc;
}

async function ensureFunded(role: string, wantQor: number) {
  const a = await account(role);
  const have = await balanceUqor(a.cosmos);
  const want = BigInt(wantQor) * 1_000_000n;
  if (have < want) {
    const W1 = await account("W1");
    const r = await sendNative(W1, [{ typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { fromAddress: W1.cosmos, toAddress: a.cosmos, amount: [{ denom: "uqor", amount: String(want - have) }] } }]);
    console.log(`funded ${role} with ${qor(want - have)}: ${explorerTx(r.transactionHash)}`);
  }
  if (!(await pqcStatus(a.cosmos)).registered) {
    const r = await registerPqc(a);
    console.log(`${role} ML-DSA-87 key registered with proof of possession: ${explorerTx(r.transactionHash)}`);
  }
  return a;
}

async function deployHub() {
  if (existsSync(HUB_FILE)) return JSON.parse(readFileSync(HUB_FILE, "utf8")).hub as Address;
  const A = await account("ADMIN_A");
  const hub = artifact("LaneHub");
  const poolHash = keccak256(rawCode("ExitPool")), regHash = keccak256(rawCode("WatcherRegistry"));
  await openWindow(A, { blocks: 300, maxTxs: 1, maxValueUqor: await windowBudget(1, 3_000_000n) });
  try {
    const hash = await walletFor(A).deployContract({ abi: hub.abi, bytecode: rawCode("LaneHub"), args: [poolHash, regHash] } as any);
    const rc = await publicClient.waitForTransactionReceipt({ hash });
    if (rc.status !== "success" || !rc.contractAddress) throw new Error(`LaneHub deploy failed: ${hash}`);
    writeFileSync(HUB_FILE, JSON.stringify({ network: NET.chainId, hub: rc.contractAddress, deployTx: hash, deployBlock: Number(rc.blockNumber), poolCodeHash: poolHash, registryCodeHash: regHash, deployedAt: new Date().toISOString() }, null, 2) + "\n");
    console.log(`LaneHub deployed: ${rc.contractAddress} (tx ${hash}); it has no owner or admin`);
    return rc.contractAddress as Address;
  } finally {
    await closeWindow(A);
  }
}

async function main() {
  if (!rollupId) throw new Error("usage: lane-open.ts <rollup-id> [liquidity QOR]");
  const out = new URL(`deployments/lanes/${rollupId}.json`, ROOT);
  if (existsSync(out)) throw new Error(`${out.pathname} exists: a lane for ${rollupId} is already open`);
  const hubAddr = await deployHub();
  const LA = await ensureFunded("LANE_A", Number(liquidity) + 5);
  const LB = await ensureFunded("LANE_B", 2);
  const hubAbi = artifact("LaneHub").abi, reg = artifact("WatcherRegistry"), ep = artifact("ExitPool");
  const wallet = walletFor(LA);
  const rollupKey = keccak256(toHex(rollupId));

  await openWindow(LA, { blocks: 900, maxTxs: 5, maxValueUqor: await windowBudget(5, 8_000_000n, liquidity * 1_000_000n) });
  try {
    console.log(`opening a lane for ${rollupId} as ${LA.evm} (co-admin ${LB.evm}), not Wicketgate's admins:`);
    const rc = await tx(wallet, {
      address: hubAddr, abi: hubAbi, functionName: "openLane", gas: 12_000_000n,
      args: [rollupId, { adminA: LA.evm, adminB: LB.evm, minStake: 5n * QOR, leaveDelay: 2n * 3600n }, rawCode("WatcherRegistry"), rawCode("ExitPool")],
    }, "LaneHub.openLane");
    const ev = parseEventLogs({ abi: hubAbi, logs: rc.logs, eventName: "LaneOpened" })[0] as any;
    const pool = ev.args.pool as Address, registry = ev.args.registry as Address;
    console.log(`  lane pool ${pool}, registry ${registry}`);

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const sigs = async (address: Address, abi: any, action: string, payload: Hex) => {
      const nonce = (await publicClient.readContract({ address, abi, functionName: "adminNonce", args: [] })) as bigint;
      const msg = (await publicClient.readContract({ address, abi, functionName: "adminMessage", args: [toHex(action, { size: 32 }), payload, nonce, deadline] })) as Hex;
      return [pqSign(LA, msg), pqSign(LB, msg)] as const;
    };
    let [sa, sb] = await sigs(registry, reg.abi, "setPool", encodeAbiParameters([{ type: "address" }], [pool]));
    await tx(wallet, { address: registry, abi: reg.abi, functionName: "setPool", args: [pool, deadline, sa, sb] }, "registry.setPool (both provider ML-DSA-87 signatures)");
    const lane = { windowSecs: 3600n, graceSecs: 1800n, feeBps: 30, quorum: 2, lockPerWatcher: 4n * QOR, enabled: true };
    [sa, sb] = await sigs(pool, ep.abi, "setLane", encodeAbiParameters(LANE_T, [rollupKey, lane]));
    await tx(wallet, { address: pool, abi: ep.abi, functionName: "setLane", args: [rollupKey, lane, deadline, sa, sb] }, "pool.setLane");
    const risk = { kinkBps: 5000, maxFeeBps: 300, maxExitWei: lane.lockPerWatcher, maxOutstandingWei: 8n * QOR, keeperTipWei: 0n };
    [sa, sb] = await sigs(pool, ep.abi, "setRisk", encodeAbiParameters(RISK_T, [rollupKey, risk]));
    await tx(wallet, { address: pool, abi: ep.abi, functionName: "setRisk", args: [rollupKey, risk, deadline, sa, sb] }, "pool.setRisk");
    await tx(wallet, { address: pool, abi: ep.abi, functionName: "deposit", args: [], value: liquidity * QOR }, `pool.deposit ${liquidity} QOR (the lane's own liquidity)`);

    mkdirSync(new URL("deployments/lanes/", ROOT), { recursive: true });
    writeFileSync(out, JSON.stringify({
      network: NET.chainId, evmChainId: NET.evmChainId, version: "3.1-lane", openedAt: new Date().toISOString(), deployBlock: Number(rc.blockNumber),
      hub: hubAddr, openTx: rc.transactionHash, provider: { adminA: LA.evm, adminB: LB.evm }, registry, pool,
      lanes: { [rollupId]: { windowSecs: 3600, graceSecs: 1800, feeBps: 30, quorum: 2, lockPerWatcher: lane.lockPerWatcher.toString(), enabled: true, risk: { ...risk, maxExitWei: risk.maxExitWei.toString(), maxOutstandingWei: risk.maxOutstandingWei.toString(), keeperTipWei: "0" } } },
    }, null, 2) + "\n");
    console.log(`Wrote ${out.pathname}. Watchers join with WICKETGATE_DEPLOYMENTS=${out.pathname}.`);
  } finally {
    await closeWindow(LA);
  }
}
main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exitCode = 1; });
