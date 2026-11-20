// Pool v3 helpers: quote an exit, pause new exits with ONE admin's ML-DSA-87 signature, and resume
// with BOTH admins' signatures. Point WICKETGATE_DEPLOYMENTS at a v3 deployment file.
// Usage: npx tsx src/v3-admin.ts quote <rollup-id> <batch> <amount-uqor>
//        npx tsx src/v3-admin.ts pause [A|B]
//        npx tsx src/v3-admin.ts unpause
import { readFileSync } from "node:fs";
import { keccak256, toHex, type Address, type Hex } from "viem";
import { account, DEPLOYMENTS_FILE } from "@wicketgate/core/env";
import { artifact, closeWindow, openWindow, pqSign, publicClient, walletFor, windowBudget } from "@wicketgate/core/evm";

const POOL = JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8")).pool as Address;
const P = artifact("ExitPool").abi;
const STATUS = ["OK", "PAUSED", "NOT_CONFIRMED", "CONTESTED", "TOO_LATE", "EXIT_TOO_LARGE", "LANE_FULL", "COVER", "LIQUIDITY", "TOO_SMALL"];

async function adminMsg(action: string, deadline: bigint) {
  const nonce = (await publicClient.readContract({ address: POOL, abi: P, functionName: "adminNonce", args: [] })) as bigint;
  return (await publicClient.readContract({ address: POOL, abi: P, functionName: "adminMessage", args: [toHex(action, { size: 32 }), "0x", nonce, deadline] })) as Hex;
}

async function send(fn: string, args: unknown[]) {
  const A = await account("ADMIN_A"); // pays the gas; authority comes only from the signatures
  await openWindow(A, { blocks: 300, maxTxs: 1, maxValueUqor: await windowBudget(1, 1_500_000n), allowedTargets: [POOL] });
  try {
    const hash = await walletFor(A).writeContract({ address: POOL, abi: P, functionName: fn, args, gas: 1_500_000n } as any);
    const rc = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`${fn}: ${rc.status} ${hash}; paused now ${await publicClient.readContract({ address: POOL, abi: P, functionName: "paused", args: [] })}`);
  } finally {
    await closeWindow(A);
  }
}

async function main() {
  const [cmd, a1, a2, a3] = process.argv.slice(2);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  if (cmd === "quote") {
    const [status, fee, payout, room] = (await publicClient.readContract({ address: POOL, abi: P, functionName: "quote", args: [keccak256(toHex(a1)), BigInt(a2), BigInt(a3)] })) as any[];
    console.log(`quote ${a1} batch ${a2}, ${Number(a3) / 1e6} QOR: status ${STATUS[status]} (${status}), fee ${Number(fee) / 1e18} QOR, payout ${Number(payout) / 1e18} QOR, cover room ${Number(room) / 1e18} QOR`);
  } else if (cmd === "pause") {
    const byA = (a1 ?? "B").toUpperCase() === "A";
    const signer = await account(byA ? "ADMIN_A" : "ADMIN_B");
    await send("pause", [deadline, byA, pqSign(signer, await adminMsg("pause", deadline))]);
  } else if (cmd === "unpause") {
    const m = await adminMsg("unpause", deadline);
    await send("unpause", [deadline, pqSign(await account("ADMIN_A"), m), pqSign(await account("ADMIN_B"), m)]);
  } else throw new Error("usage: v3-admin.ts quote <rollup> <batch> <uqor> | pause [A|B] | unpause");
}
main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exitCode = 1; });
