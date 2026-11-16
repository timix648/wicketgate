// Deploys WatcherRegistry, ExitPool, Directory and MemoBoard from ADMIN_A, wires them
// with both admins' ML-DSA-87 signatures, opens a lane for a rollup and seeds the pool.
// Usage: pnpm deploy [rollup-id] [liquidity-qor]
import { mkdirSync, writeFileSync } from "node:fs";
import { encodeAbiParameters, keccak256, toHex, type Address, type Hex } from "viem";
import { account, DEPLOYMENTS_FILE, NET } from "@wicketgate/core/env";
import { artifact, closeWindow, openWindow, pqSign, publicClient, walletFor, windowBudget } from "@wicketgate/core/evm";

const ROLLUP = process.argv[2] ?? "rdk-v328-e2e-mwd5v89d";
const LIQUIDITY_QOR = BigInt(process.argv[3] ?? "20");
const QOR = 10n ** 18n;

async function main() {
  const A = await account("ADMIN_A");
  const B = await account("ADMIN_B");
  const wallet = walletFor(A);

  // contract creation needs an unscoped window; it is closed again at the end
  await openWindow(A, { blocks: 900, maxTxs: 8, maxValueUqor: await windowBudget(8, 6_000_000n, LIQUIDITY_QOR * 1_000_000n) });

  const deploy = async (name: string, args: unknown[]) => {
    const { abi, bytecode } = artifact(name);
    const hash = await wallet.deployContract({ abi, bytecode, args } as any);
    const rc = await publicClient.waitForTransactionReceipt({ hash });
    if (rc.status !== "success" || !rc.contractAddress) throw new Error(`${name} deploy failed: ${hash}`);
    console.log(`  ${name}: ${rc.contractAddress} (tx ${hash})`);
    return rc.contractAddress as Address;
  };

  try {
    const registry = await deploy("WatcherRegistry", [A.evm, B.evm, 5n * QOR, 2n * 3600n]);
    const pool = await deploy("ExitPool", [A.evm, B.evm, registry]);
    const directory = await deploy("Directory", []);
    const memoBoard = await deploy("MemoBoard", []);

    const reg = artifact("WatcherRegistry");
    const ep = artifact("ExitPool");
    const send = async (address: Address, abi: any, functionName: string, args: unknown[], value?: bigint) => {
      const hash = await wallet.writeContract({ address, abi, functionName, args, value } as any);
      const rc = await publicClient.waitForTransactionReceipt({ hash });
      if (rc.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
      console.log(`  ${functionName}: tx ${hash}`);
      return hash;
    };
    const adminSigs = async (address: Address, abi: any, action: string, payload: Hex, deadline: bigint) => {
      const nonce = (await publicClient.readContract({ address, abi, functionName: "adminNonce", args: [] })) as bigint;
      const msg = (await publicClient.readContract({
        address, abi, functionName: "adminMessage", args: [toHex(action, { size: 32 }), payload, nonce, deadline],
      })) as Hex;
      return [pqSign(A, msg), pqSign(B, msg)] as const;
    };
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

    // registry.setPool(pool)
    {
      const payload = encodeAbiParameters([{ type: "address" }], [pool]);
      const [sa, sb] = await adminSigs(registry, reg.abi, "setPool", payload, deadline);
      await send(registry, reg.abi, "setPool", [pool, deadline, sa, sb]);
    }
    // pool.setLane(rollupKey, lane)
    const rollupKey = keccak256(toHex(ROLLUP));
    const lane = { windowSecs: 3600n, graceSecs: 1800n, feeBps: 30, quorum: 2, lockPerWatcher: 8n * QOR, enabled: true };
    {
      const payload = encodeAbiParameters(
        [{ type: "bytes32" }, { type: "tuple", components: [
          { name: "windowSecs", type: "uint64" }, { name: "graceSecs", type: "uint64" }, { name: "feeBps", type: "uint16" },
          { name: "quorum", type: "uint8" }, { name: "lockPerWatcher", type: "uint128" }, { name: "enabled", type: "bool" },
        ] }],
        [rollupKey, lane],
      );
      const [sa, sb] = await adminSigs(pool, ep.abi, "setLane", payload, deadline);
      await send(pool, ep.abi, "setLane", [rollupKey, lane, deadline, sa, sb]);
    }
    if (LIQUIDITY_QOR > 0n) await send(pool, ep.abi, "deposit", [], LIQUIDITY_QOR * QOR);

    const out = {
      network: NET.chainId, evmChainId: NET.evmChainId, deployedAt: new Date().toISOString(),
      admins: [A.evm, B.evm], registry, pool, directory, memoBoard,
      lanes: { [ROLLUP]: { rollupKey, ...lane, lockPerWatcher: lane.lockPerWatcher.toString(), windowSecs: 3600, graceSecs: 1800 } },
    };
    mkdirSync(new URL(".", DEPLOYMENTS_FILE), { recursive: true });
    writeFileSync(DEPLOYMENTS_FILE, JSON.stringify(out, null, 2) + "\n");
    console.log(`Wrote ${DEPLOYMENTS_FILE.pathname}`);
  } finally {
    await closeWindow(A);
  }
}
main().catch((e) => {
  console.error(e.shortMessage ?? e.message ?? e);
  process.exitCode = 1;
});
