// EVM-lane helpers: forge artifacts, viem clients for a unified account, EVM windows,
// and ML-DSA-87 admin signatures.
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, type Abi, type Address, type Hex, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mldsa87 } from "@qorechain/pqc";
import { openEvmWindowMsg, closeEvmWindowMsg, fetchEvmWindow, type UnifiedAccount } from "@qorechain/sdk";
import { NET } from "./env.js";
import { sendNative, explorerTx } from "./chain.js";

export const diana = defineChain({
  id: NET.evmChainId,
  name: "QoreChain testnet (diana)",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: [NET.evm] } },
});

export const publicClient = createPublicClient({ chain: diana, transport: http(NET.evm) });

export function walletFor(acc: UnifiedAccount) {
  return createWalletClient({ chain: diana, transport: http(NET.evm), account: privateKeyToAccount(acc.privateKey as Hex) });
}

/** ABI from packages/core/abi (always present); bytecode from contracts/out (after forge build). */
export function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const abi = JSON.parse(readFileSync(new URL(`../abi/${name}.json`, import.meta.url), "utf8")) as Abi;
  let bytecode = "0x" as Hex;
  try {
    const j = JSON.parse(readFileSync(new URL(`../../../contracts/out/${name}.sol/${name}.json`, import.meta.url), "utf8"));
    bytecode = j.bytecode.object as Hex;
  } catch {}
  return { abi, bytecode };
}

/** Sign raw bytes with the account's ML-DSA-87 key (deterministic, as the chain verifies). */
export function pqSign(acc: UnifiedAccount, message: Hex): Hex {
  const sig = mldsa87.sign(acc.pqc.secretKey, Buffer.from(message.slice(2), "hex"));
  return `0x${Buffer.from(sig).toString("hex")}`;
}

/** Open an EVM authorisation window with a hybrid-signed native message. */
export async function openWindow(
  acc: UnifiedAccount,
  w: { blocks: number; maxTxs: number; maxValueUqor: bigint; allowedTargets?: string[] },
) {
  const r = await sendNative(acc, [
    openEvmWindowMsg({
      sender: acc.cosmos,
      blocks: w.blocks,
      maxTxs: w.maxTxs,
      maxValue: w.maxValueUqor.toString(),
      ...(w.allowedTargets ? { allowedTargets: w.allowedTargets } : {}),
    }),
  ]);
  console.log(`  window opened (${w.blocks} blocks, ${w.maxTxs} txs, ${w.allowedTargets ? "scoped" : "unscoped"}): ${explorerTx(r.transactionHash)}`);
  return r;
}

export async function closeWindow(acc: UnifiedAccount) {
  const st = await fetchEvmWindow({ rest: NET.rest, address: acc.cosmos });
  if (!st.found) return;
  const r = await sendNative(acc, [closeEvmWindowMsg(acc.cosmos)]);
  console.log(`  window closed: ${explorerTx(r.transactionHash)}`);
}

/** Worst-case uqor cost of `txs` transactions of `gas` each at the current gas price plus a margin. */
export async function windowBudget(txs: number, gas: bigint, valueUqor = 0n): Promise<bigint> {
  const price = await publicClient.getGasPrice();
  const feeWei = (price * 3n * gas * BigInt(txs)) / 2n;
  return valueUqor + feeWei / 1_000_000_000_000n + 1n;
}

/**
 * Run `fn` holding an exclusive, cross-process lock for `acc`. One key can serve several pools
 * (Wicketgate's own pool and LaneHub lanes), each from its own process; an EVM window belongs to
 * the account, so two processes opening, using and closing windows at once would replace or close
 * each other's window and clash on nonces. The lock is a file per account; a lock older than
 * `staleMs` is taken over (its holder died).
 */
export async function withAccountLock<T>(acc: UnifiedAccount, fn: () => Promise<T>, staleMs = 15 * 60_000): Promise<T> {
  const { mkdirSync, openSync, closeSync, statSync, unlinkSync, writeSync } = await import("node:fs");
  const dir = "/tmp/wicketgate-locks";
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/${acc.evm.toLowerCase()}.lock`;
  for (;;) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      closeSync(fd);
      break;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(path).mtimeMs > staleMs) unlinkSync(path);
      } catch {}
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(path);
    } catch {}
  }
}

/**
 * getContractEvents over any block range. The public EVM RPC refuses a log query spanning more
 * than 10,000 blocks, so a query from a contract's deploy block works on deploy day and fails once
 * the chain has moved on. Always read events through this.
 */
export async function getEventsChunked(params: { address: Address; abi: Abi; eventName: string; fromBlock: bigint; toBlock?: bigint }, step = 10_000n): Promise<any[]> {
  const to = params.toBlock ?? (await publicClient.getBlockNumber());
  const out: any[] = [];
  for (let f = params.fromBlock; f <= to; f += step) {
    const t = f + step - 1n < to ? f + step - 1n : to;
    out.push(...(await publicClient.getContractEvents({ ...params, fromBlock: f, toBlock: t } as any)));
  }
  return out;
}
