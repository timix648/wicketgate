// EVM-lane helpers: forge artifacts, viem clients for a unified account, EVM windows,
// and ML-DSA-87 admin signatures.
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, type Abi, type Hex, defineChain } from "viem";
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

export function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const url = new URL(`../../../../contracts/out/${name}.sol/${name}.json`, import.meta.url);
  const j = JSON.parse(readFileSync(url, "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object as Hex };
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
