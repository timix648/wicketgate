// LaneHub, read live: every permissionless instant-exit lane on QoreChain, whoever opened it.
// Nothing here is hard-coded but the hub's address; rollups and lanes come from the hub itself.
import { formatEther, keccak256, toHex, type Abi, type Address, type Hex } from "viem";
import hubAbiJson from "@wicketgate/core/abi/LaneHub.json";
import poolAbiJson from "@wicketgate/core/abi/ExitPool.json";
import hub from "../../../../deployments/lanehub.json";
import { client } from "./chain";
import { CONTRACTS } from "./config";

const hubAbi = hubAbiJson as Abi;
const poolAbi = poolAbiJson as Abi;
export const LANE_HUB = { address: hub.hub as Address, deployTx: hub.deployTx as Hex, deployBlock: BigInt(hub.deployBlock), poolCodeHash: hub.poolCodeHash, registryCodeHash: hub.registryCodeHash };

export interface LaneRow {
  rollupId: string;
  pool: Address;
  registry: Address;
  adminA: Address;
  adminB: Address;
  opener: Address;
  openedAt: number;
  openTx?: Hex;
  liquidityWei: bigint;
  feeBps: number;
  quorum: number;
  lockPerWatcherWei: bigint;
  windowSecs: number;
  enabled: boolean;
  confirmations: number;
  exits: number;
  isWicketgateAdmin: boolean;
}

export async function fetchLanes(): Promise<LaneRow[]> {
  const read = <T>(functionName: string, args: unknown[] = [], address: Address = LANE_HUB.address, abi: Abi = hubAbi) =>
    client.readContract({ address, abi, functionName, args }) as Promise<T>;
  // rollup ids are only in the LaneOpened events (the hub stores keys)
  const opened = await client.getContractEvents({ address: LANE_HUB.address, abi: hubAbi, eventName: "LaneOpened", fromBlock: LANE_HUB.deployBlock });
  const idOf = new Map<string, string>(), txOf = new Map<string, Hex>();
  for (const e of opened as any[]) {
    idOf.set(e.args.rollupKey, e.args.rollupId);
    txOf.set(String(e.args.pool).toLowerCase(), e.transactionHash);
  }
  const n = Number(await read<bigint>("rollupCount"));
  const keys = await Promise.all(Array.from({ length: n }, (_, i) => read<Hex>("rollups", [BigInt(i)])));
  const ours = (await Promise.all([
    client.readContract({ address: CONTRACTS.pool, abi: poolAbi, functionName: "adminA" }),
    client.readContract({ address: CONTRACTS.pool, abi: poolAbi, functionName: "adminB" }),
  ])).map((a) => String(a).toLowerCase());
  const rows: LaneRow[] = [];
  for (const key of keys) {
    const lanes = await read<any[]>("lanesOf", [key]);
    for (const l of lanes) {
      const rollupId = idOf.get(key) ?? key;
      const [liquidityWei, lane, confirmed, exits] = await Promise.all([
        client.getBalance({ address: l.pool }),
        read<any[]>("lanes", [keccak256(toHex(rollupId))], l.pool, poolAbi),
        client.getContractEvents({ address: l.pool, abi: poolAbi, eventName: "BatchConfirmed", fromBlock: LANE_HUB.deployBlock }),
        client.getContractEvents({ address: l.pool, abi: poolAbi, eventName: "InstantExit", fromBlock: LANE_HUB.deployBlock }),
      ]);
      rows.push({
        rollupId, pool: l.pool, registry: l.registry, adminA: l.adminA, adminB: l.adminB, opener: l.opener, openedAt: Number(l.openedAt),
        openTx: txOf.get(String(l.pool).toLowerCase()), liquidityWei,
        windowSecs: Number(lane[0]), feeBps: Number(lane[2]), quorum: Number(lane[3]), lockPerWatcherWei: BigInt(lane[4]), enabled: Boolean(lane[5]),
        confirmations: confirmed.length, exits: exits.length,
        isWicketgateAdmin: ours.includes(String(l.adminA).toLowerCase()) || ours.includes(String(l.adminB).toLowerCase()),
      });
    }
  }
  return rows.sort((a, b) => a.openedAt - b.openedAt);
}

export const qor = (wei: bigint) => Number(formatEther(wei)).toLocaleString(undefined, { maximumFractionDigits: 3 });
