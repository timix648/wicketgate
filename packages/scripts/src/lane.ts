// Opens (or changes) an ExitPool lane for a rollup, authorised by both admins' ML-DSA-87
// signatures. Usage: pnpm lane <rollup-id> [windowSecs] [graceSecs] [feeBps] [quorum] [lockQOR]
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { encodeAbiParameters, keccak256, toHex, type Address, type Hex } from "viem";
import { account, DEPLOYMENTS_FILE } from "@wicketgate/core/env";
import { artifact, closeWindow, openWindow, pqSign, publicClient, walletFor, windowBudget } from "@wicketgate/core/evm";

const LANE_TUPLE = [{ type: "bytes32" }, { type: "tuple", components: [
  { name: "windowSecs", type: "uint64" }, { name: "graceSecs", type: "uint64" }, { name: "feeBps", type: "uint16" },
  { name: "quorum", type: "uint8" }, { name: "lockPerWatcher", type: "uint128" }, { name: "enabled", type: "bool" },
] }] as const;

export async function setLane(rollupId: string, lane: { windowSecs: bigint; graceSecs: bigint; feeBps: number; quorum: number; lockPerWatcher: bigint; enabled: boolean }) {
  const A = await account("ADMIN_A");
  const B = await account("ADMIN_B");
  const dep = JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8"));
  const pool = dep.pool as Address;
  const { abi } = artifact("ExitPool");
  const rollupKey = keccak256(toHex(rollupId));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const payload = encodeAbiParameters(LANE_TUPLE as any, [rollupKey, lane]);
  const nonce = (await publicClient.readContract({ address: pool, abi, functionName: "adminNonce", args: [] })) as bigint;
  const msg = (await publicClient.readContract({ address: pool, abi, functionName: "adminMessage", args: [toHex("setLane", { size: 32 }), payload, nonce, deadline] })) as Hex;
  await openWindow(A, { blocks: 300, maxTxs: 1, maxValueUqor: await windowBudget(1, 2_000_000n), allowedTargets: [pool] });
  try {
    const hash = await walletFor(A).writeContract({ address: pool, abi, functionName: "setLane", args: [rollupKey, lane, deadline, pqSign(A, msg), pqSign(B, msg)] } as any);
    const rc = await publicClient.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error(`setLane reverted: ${hash}`);
    console.log(`lane for ${rollupId} set: ${hash}`);
  } finally {
    await closeWindow(A);
  }
  dep.lanes ??= {};
  dep.lanes[rollupId] = { rollupKey, windowSecs: Number(lane.windowSecs), graceSecs: Number(lane.graceSecs), feeBps: lane.feeBps, quorum: lane.quorum, lockPerWatcher: lane.lockPerWatcher.toString(), enabled: lane.enabled };
  writeFileSync(DEPLOYMENTS_FILE, JSON.stringify(dep, null, 2) + "\n");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [id, w = "3600", g = "1800", fee = "30", q = "2", lock = "4"] = process.argv.slice(2);
  if (!id) throw new Error("usage: pnpm lane <rollup-id> [windowSecs] [graceSecs] [feeBps] [quorum] [lockQOR]");
  setLane(id, { windowSecs: BigInt(w), graceSecs: BigInt(g), feeBps: Number(fee), quorum: Number(q), lockPerWatcher: BigInt(Math.round(Number(lock) * 1e6)) * 10n ** 12n, enabled: true })
    .catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exitCode = 1; });
}
