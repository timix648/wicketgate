// Live reads from ExitPool and WatcherRegistry over the public EVM RPC. Read-only.
import { createPublicClient, defineChain, http, keccak256, toHex, type Abi, type Address, type Hex } from "viem";
import poolAbiJson from "@wicketgate/core/abi/ExitPool.json";
import registryAbiJson from "@wicketgate/core/abi/WatcherRegistry.json";
import { CONTRACTS, NET, POOLS } from "./config";

const poolAbi = poolAbiJson as Abi;
const registryAbi = registryAbiJson as Abi;

export const diana = defineChain({
  id: NET.evmChainId,
  name: NET.name,
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: [NET.evmRpc] } },
});

export const client = createPublicClient({ chain: diana, transport: http(NET.evmRpc, { retryCount: 2 }) });

const readPool = <T>(functionName: string, args: unknown[] = []) =>
  client.readContract({ address: CONTRACTS.pool, abi: poolAbi, functionName, args }) as Promise<T>;
const readRegistry = <T>(functionName: string, args: unknown[] = []) =>
  client.readContract({ address: CONTRACTS.registry, abi: registryAbi, functionName, args }) as Promise<T>;

export interface PoolState {
  totalAssets: bigint;
  idleLiquidity: bigint;
  outstanding: bigint;
  totalShares: bigint;
  watcherCredits: bigint;
  minStake: bigint;
  leaveDelay: bigint;
  block: bigint;
}

export async function fetchPool(): Promise<PoolState> {
  const [totalAssets, idleLiquidity, outstanding, totalShares, watcherCredits, minStake, leaveDelay, block] = await Promise.all([
    readPool<bigint>("totalAssets"),
    readPool<bigint>("idleLiquidity"),
    readPool<bigint>("outstandingWei"),
    readPool<bigint>("totalShares"),
    readPool<bigint>("watcherCreditsTotal"),
    readRegistry<bigint>("minStake"),
    readRegistry<bigint>("leaveDelay"),
    client.getBlockNumber(),
  ]);
  return { totalAssets, idleLiquidity, outstanding, totalShares, watcherCredits, minStake, leaveDelay, block };
}

export interface WatcherState {
  address: Address;
  stake: bigint;
  locked: bigint;
  leaveAfter: bigint;
  active: boolean;
  credit: bigint;
  /** Stake still held by the registry of the pool this one replaced, if any. */
  previous?: { version: string; stake: bigint; active: boolean };
}

export async function fetchWatcher(address: Address): Promise<WatcherState> {
  const prev = POOLS.find((p) => !p.live);
  const [w, credit, old] = await Promise.all([
    readRegistry<readonly [bigint, bigint, bigint, boolean]>("watchers", [address]),
    readPool<bigint>("watcherCredit", [address]),
    prev
      ? (client.readContract({ address: prev.registry, abi: registryAbi, functionName: "watchers", args: [address] }) as Promise<readonly [bigint, bigint, bigint, boolean]>)
      : Promise.resolve(undefined),
  ]);
  return {
    address,
    stake: w[0],
    locked: w[1],
    leaveAfter: w[2],
    active: w[3],
    credit,
    ...(prev && old && old[0] > 0n ? { previous: { version: prev.version, stake: old[0], active: old[3] } } : {}),
  };
}

export interface OnChainBatch {
  batchKey: Hex;
  factsHash: Hex;
  confirmedAt: bigint;
  contested: boolean;
  released: boolean;
  openAdvances: number;
  coverWei: bigint;
  advancedWei: bigint;
  watchers: Address[];
  lockedAmt: bigint[];
}

export async function fetchBatch(rollupId: string, index: number): Promise<OnChainBatch> {
  const rollupKey = keccak256(toHex(rollupId));
  const batchKey = await readPool<Hex>("batchKey", [rollupKey, BigInt(index)]);
  const b = await readPool<readonly [Hex, bigint, boolean, boolean, number, bigint, bigint, Address[], bigint[]]>("getBatch", [batchKey]);
  return {
    batchKey,
    factsHash: b[0],
    confirmedAt: b[1],
    contested: b[2],
    released: b[3],
    openAdvances: Number(b[4]),
    coverWei: b[5],
    advancedWei: b[6],
    watchers: [...b[7]],
    lockedAmt: [...b[8]],
  };
}
