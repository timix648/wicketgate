// Every ExitPool and WatcherRegistry event since the pool was deployed, read in 10,000-block
// chunks (the RPC's limit) and then topped up incrementally. Read-only.
import { parseEventLogs, type Abi, type Address, type Hex, type Log } from "viem";
import poolAbiJson from "@wicketgate/core/abi/ExitPool.json";
import registryAbiJson from "@wicketgate/core/abi/WatcherRegistry.json";
import { client } from "./chain";
import { CONTRACTS, LOG_RANGE, NET, POOLS, poolOf } from "./config";

const abi = [...(poolAbiJson as Abi), ...(registryAbiJson as Abi)] as Abi;

export interface ChainEvent {
  name: string;
  address: Address;
  args: Record<string, any>;
  block: bigint;
  logIndex: number;
  tx: Hex;
}

export interface EventLog {
  events: ChainEvent[];
  /** Last block included in the scan. */
  toBlock: bigint;
  /** Unix seconds of blocks we have looked up, for timestamps. */
  blockTimes: Record<string, number>;
}

/** One 10,000-block (or smaller) query per chunk, for every pool deployment whose range covers it. */
async function getLogsRange(from: bigint, to: bigint): Promise<ChainEvent[]> {
  const chunks: [bigint, bigint, Address[]][] = [];
  for (const p of POOLS) {
    const start = p.fromBlock > from ? p.fromBlock : from;
    for (let f = start; f <= to; f += LOG_RANGE) chunks.push([f, f + LOG_RANGE - 1n < to ? f + LOG_RANGE - 1n : to, [p.pool, p.registry]]);
  }
  const out: ChainEvent[] = [];
  let next = 0;
  async function worker() {
    while (next < chunks.length) {
      const [f, t, address] = chunks[next++];
      const logs = (await client.request({
        method: "eth_getLogs",
        params: [{ address, fromBlock: `0x${f.toString(16)}`, toBlock: `0x${t.toString(16)}` }],
      })) as Log[];
      for (const l of parseEventLogs({ abi, logs, strict: false })) {
        out.push({
          name: l.eventName as string,
          address: l.address,
          args: (l.args ?? {}) as Record<string, any>,
          block: l.blockNumber!,
          logIndex: l.logIndex!,
          tx: l.transactionHash!,
        });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, chunks.length) }, worker));
  return out;
}

/** Block timestamps via JSON-RPC batches of 50 (one request each), far faster than one call per block. */
async function blockTimes(blocks: bigint[], known: Record<string, number>) {
  const missing = [...new Set(blocks.map(String))].filter((b) => known[b] === undefined);
  const out = { ...known };
  const batches: string[][] = [];
  for (let i = 0; i < missing.length; i += 50) batches.push(missing.slice(i, i + 50));
  await Promise.all(
    batches.map(async (group) => {
      const res = await fetch(NET.evmRpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(group.map((b, id) => ({ jsonrpc: "2.0", id, method: "eth_getBlockByNumber", params: [`0x${BigInt(b).toString(16)}`, false] }))),
      });
      if (!res.ok) throw new Error(`block lookup failed: HTTP ${res.status}`);
      const replies = (await res.json()) as { id: number; result?: { timestamp: string } }[];
      for (const r of replies) if (r.result) out[group[r.id]] = Number(BigInt(r.result.timestamp));
    }),
  );
  return out;
}

/** Full scan the first time, then only the blocks after `prev.toBlock`. */
export async function fetchEvents(prev?: EventLog): Promise<EventLog> {
  const head = await client.getBlockNumber();
  const from = prev ? prev.toBlock + 1n : POOLS.reduce((m, p) => (p.fromBlock < m ? p.fromBlock : m), POOLS[0].fromBlock);
  if (prev && from > head) return prev;
  const fresh = await getLogsRange(from, head);
  const events = [...(prev?.events ?? []), ...fresh].sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1));
  const times = await blockTimes(fresh.map((e) => e.block), prev?.blockTimes ?? {});
  return { events, toBlock: head, blockTimes: times };
}

export const eventTime = (log: EventLog, e: ChainEvent) => log.blockTimes[String(e.block)];

// ---------- derived views ----------

export type ExitStatus = "open" | "settled" | "recovered" | "defaulted";

export interface LiveExit {
  id: Hex;
  batchKey: Hex;
  beneficiary: Address;
  exitAddr: Address;
  amountWei: bigint;
  feeWei: bigint;
  dueBy: bigint;
  tx: Hex;
  block: bigint;
  time?: number;
  /** The pool deployment that paid it, e.g. "3.1". */
  pool: string;
  status: ExitStatus;
  closedTx?: Hex;
  closedTime?: number;
  receivedWei?: bigint;
}

export function deriveExits(log: EventLog): LiveExit[] {
  const exits = new Map<string, LiveExit>();
  for (const e of log.events) {
    // Advance ids are only unique within one pool, so key by pool too.
    const key = `${e.address.toLowerCase()}:${e.args.id}`;
    if (e.name === "InstantExit") {
      exits.set(key, {
        id: e.args.id,
        batchKey: e.args.batchKey,
        beneficiary: e.args.beneficiary,
        exitAddr: e.args.exitAddr,
        amountWei: e.args.amountWei,
        feeWei: e.args.feeWei,
        dueBy: BigInt(e.args.dueBy),
        tx: e.tx,
        block: e.block,
        time: eventTime(log, e),
        pool: poolOf(e.address)?.version ?? "?",
        status: "open",
      });
    } else if (e.name === "Settled" || e.name === "Recovered" || e.name === "Defaulted") {
      const x = exits.get(key);
      if (!x) continue;
      x.status = e.name === "Settled" ? "settled" : e.name === "Recovered" ? "recovered" : "defaulted";
      x.closedTx = e.tx;
      x.closedTime = eventTime(log, e);
      x.receivedWei = e.args.receivedWei ?? e.args.slashedWei;
    }
  }
  return [...exits.values()].reverse();
}

export interface Lane {
  rollupKey: Hex;
  windowSecs: number;
  graceSecs: number;
  feeBps: number;
  quorum: number;
  lockPerWatcher: bigint;
  enabled: boolean;
}

/** The live pool's lanes as its LaneSet events left them, keyed by lower-case rollupKey. */
export function deriveLanes(log: EventLog): Map<string, Lane> {
  const lanes = new Map<string, Lane>();
  for (const e of log.events) {
    if (e.name !== "LaneSet" || e.address.toLowerCase() !== CONTRACTS.pool.toLowerCase()) continue;
    const l = e.args.lane ?? {};
    lanes.set(String(e.args.rollupKey).toLowerCase(), {
      rollupKey: e.args.rollupKey,
      windowSecs: Number(l.windowSecs),
      graceSecs: Number(l.graceSecs),
      feeBps: Number(l.feeBps),
      quorum: Number(l.quorum),
      lockPerWatcher: BigInt(l.lockPerWatcher ?? 0),
      enabled: Boolean(l.enabled),
    });
  }
  return lanes;
}

/** Every address that ever joined the registry. */
export function deriveWatcherAddresses(log: EventLog): string[] {
  return [...new Set(log.events.filter((e) => e.name === "Joined").map((e) => (e.args.watcher as string).toLowerCase()))];
}
