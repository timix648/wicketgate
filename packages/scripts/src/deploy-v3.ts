// Deploys pool v3 (a new WatcherRegistry and ExitPool) from ADMIN_A, wires them with both admins'
// ML-DSA-87 signatures, opens the same lanes as the live pool and sets each lane's v3 risk settings.
// It writes deployments/diana-v3.json and touches nothing live: no liquidity or stake is moved, and
// deployments/diana.json is left alone until the migration. Directory and MemoBoard are reused.
// Usage: npx tsx src/deploy-v3.ts [out-file, default deployments/diana-v3.json]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { encodeAbiParameters, keccak256, toHex, type Address, type Hex } from "viem";
import { account, NET } from "@wicketgate/core/env";
import { artifact, closeWindow, openWindow, pqSign, publicClient, walletFor, windowBudget } from "@wicketgate/core/evm";

const ROOT = new URL("../../../", import.meta.url);
const OUT = new URL(process.argv[2] ?? "deployments/diana-v3.json", ROOT);
const LIVE = JSON.parse(readFileSync(new URL("deployments/diana.json", ROOT), "utf8"));
const QOR = 10n ** 18n;
const LANE_T = [{ type: "bytes32" }, { type: "tuple", components: [
  { name: "windowSecs", type: "uint64" }, { name: "graceSecs", type: "uint64" }, { name: "feeBps", type: "uint16" },
  { name: "quorum", type: "uint8" }, { name: "lockPerWatcher", type: "uint128" }, { name: "enabled", type: "bool" },
] }] as const;
const RISK_T = [{ type: "bytes32" }, { type: "tuple", components: [
  { name: "kinkBps", type: "uint16" }, { name: "maxFeeBps", type: "uint16" },
  { name: "maxExitWei", type: "uint128" }, { name: "maxOutstandingWei", type: "uint128" }, { name: "keeperTipWei", type: "uint128" },
] }] as const;

async function main() {
  if (existsSync(OUT)) throw new Error(`${OUT.pathname} exists: v3 is already deployed there`);
  const A = await account("ADMIN_A");
  const B = await account("ADMIN_B");
  const reg = artifact("WatcherRegistry"), ep = artifact("ExitPool");
  if (!(ep.abi as any[]).some((x) => x.name === "reportEquivocation")) throw new Error("the ABIs are not v3: run `pnpm abi` in this checkout first");
  const wallet = walletFor(A);
  const lanes = Object.entries(LIVE.lanes) as [string, any][];
  const txs = 2 + 2 * lanes.length + 1;
  await openWindow(A, { blocks: 900, maxTxs: txs, maxValueUqor: await windowBudget(txs, 6_000_000n) });
  try {
    const deploy = async (name: string, args: unknown[]) => {
      const { abi, bytecode } = artifact(name);
      const hash = await wallet.deployContract({ abi, bytecode, args } as any);
      const rc = await publicClient.waitForTransactionReceipt({ hash });
      if (rc.status !== "success" || !rc.contractAddress) throw new Error(`${name} deploy failed: ${hash}`);
      console.log(`  ${name}: ${rc.contractAddress} (tx ${hash}, block ${rc.blockNumber})`);
      return { address: rc.contractAddress as Address, block: rc.blockNumber };
    };
    const send = async (address: Address, abi: any, functionName: string, args: unknown[]) => {
      const hash = await wallet.writeContract({ address, abi, functionName, args } as any);
      const rc = await publicClient.waitForTransactionReceipt({ hash });
      if (rc.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
      console.log(`  ${functionName}: tx ${hash}`);
    };
    const sigs = async (address: Address, abi: any, action: string, payload: Hex, deadline: bigint) => {
      const nonce = (await publicClient.readContract({ address, abi, functionName: "adminNonce", args: [] })) as bigint;
      const msg = (await publicClient.readContract({ address, abi, functionName: "adminMessage", args: [toHex(action, { size: 32 }), payload, nonce, deadline] })) as Hex;
      return [pqSign(A, msg), pqSign(B, msg)] as const;
    };
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

    const r = await deploy("WatcherRegistry", [A.evm, B.evm, 5n * QOR, 2n * 3600n]);
    const p = await deploy("ExitPool", [A.evm, B.evm, r.address]);
    {
      const payload = encodeAbiParameters([{ type: "address" }], [p.address]);
      const [sa, sb] = await sigs(r.address, reg.abi, "setPool", payload, deadline);
      await send(r.address, reg.abi, "setPool", [p.address, deadline, sa, sb]);
    }
    const outLanes: Record<string, any> = {};
    for (const [rollupId, l] of lanes) {
      const rollupKey = keccak256(toHex(rollupId));
      const lane = { windowSecs: BigInt(l.windowSecs), graceSecs: BigInt(l.graceSecs), feeBps: l.feeBps, quorum: l.quorum, lockPerWatcher: BigInt(l.lockPerWatcher), enabled: l.enabled };
      {
        const payload = encodeAbiParameters(LANE_T, [rollupKey, lane]);
        const [sa, sb] = await sigs(p.address, ep.abi, "setLane", payload, deadline);
        await send(p.address, ep.abi, "setLane", [rollupKey, lane, deadline, sa, sb]);
      }
      // v3 risk: the base fee up to 50% utilisation, rising to 3% at 100%; one exit at most one
      // watcher's lock (so a batch serves at least `quorum` exits); a rollup at most 40% of 400 QOR;
      // v3.1: a 0.08 QOR execution fee per exit, held for the keeper who settles it (covers its gas)
      const risk = { kinkBps: 5000, maxFeeBps: 300, maxExitWei: lane.lockPerWatcher, maxOutstandingWei: 160n * QOR, keeperTipWei: 80_000_000_000_000_000n };
      {
        const payload = encodeAbiParameters(RISK_T, [rollupKey, risk]);
        const [sa, sb] = await sigs(p.address, ep.abi, "setRisk", payload, deadline);
        await send(p.address, ep.abi, "setRisk", [rollupKey, risk, deadline, sa, sb]);
      }
      outLanes[rollupId] = { ...l, risk: { ...risk, maxExitWei: risk.maxExitWei.toString(), maxOutstandingWei: risk.maxOutstandingWei.toString(), keeperTipWei: risk.keeperTipWei.toString() } };
    }
    const out = {
      network: NET.chainId, evmChainId: NET.evmChainId, deployedAt: new Date().toISOString(), version: "3.1",
      deployBlock: Number(r.block), previous: { registry: LIVE.registry, pool: LIVE.pool, file: "deployments/diana.json" },
      admins: [A.evm, B.evm], registry: r.address, pool: p.address, directory: LIVE.directory, memoBoard: LIVE.memoBoard, lanes: outLanes,
    };
    writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
    console.log(`Wrote ${OUT.pathname}. Nothing live was changed. Next: watchers join with WICKETGATE_DEPLOYMENTS=${OUT.pathname}.`);
  } finally {
    await closeWindow(A);
  }
}
main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exitCode = 1; });
