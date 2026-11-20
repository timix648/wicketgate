import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { keccak256, toHex } from "viem";
import { deriveLanes, fetchEvents, type EventLog } from "./events";
import type { Address } from "viem";
import { fetchIndex, fetchMetrics, fetchRollup, type RollupFeed } from "./feed";
import { fetchBatch, fetchPool, fetchWatcher } from "./chain";

const MIN = 60_000;

export const useIndex = () => useQuery({ queryKey: ["index"], queryFn: fetchIndex, refetchInterval: 2 * MIN });

export const useMetrics = () => useQuery({ queryKey: ["metrics"], queryFn: fetchMetrics, staleTime: 10 * MIN });

export function useRollup(rollupId: string | undefined) {
  return useQuery({
    queryKey: ["rollup", rollupId],
    queryFn: () => fetchRollup(`${rollupId}.json`),
    enabled: !!rollupId,
    refetchInterval: 2 * MIN,
  });
}

/** Every rollup in the feed index, loaded in parallel. */
export function useAllRollups() {
  const index = useIndex();
  const files = index.data?.rollups ?? [];
  const results = useQueries({
    queries: files.map((r) => ({
      queryKey: ["rollup", r.rollupId],
      queryFn: () => fetchRollup(r.file),
      refetchInterval: 2 * MIN,
    })),
  });
  const rollups = results.map((q) => q.data).filter((d): d is RollupFeed => !!d);
  return {
    index,
    rollups,
    isLoading: index.isLoading || results.some((q) => q.isLoading),
    error: index.error ?? results.find((q) => q.error)?.error ?? null,
  };
}

/** Pool and registry events; the first load scans from deployment, later refreshes only new blocks. */
export function useEvents() {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ["events"],
    queryFn: () => fetchEvents(qc.getQueryData<EventLog>(["events"])),
    refetchInterval: 30_000,
    staleTime: 20_000,
  });
}

/** Whether the pool has an enabled lane for a rollup, from LaneSet events (undefined while loading). */
export function useLanes() {
  const events = useEvents();
  const lanes = events.data ? deriveLanes(events.data) : undefined;
  return {
    lanes,
    laneOf: (rollupId: string) => lanes?.get(keccak256(toHex(rollupId)).toLowerCase()),
    isLoading: !events.data,
  };
}

/** Map a pool batchKey (lower-case) to its rollup and batch, from the feed. */
export function useBatchKeyMap() {
  const { rollups } = useAllRollups();
  const map = new Map<string, { rollupId: string; index: number; submittedTime: number }>();
  for (const r of rollups) for (const b of r.batches) if (b.pool?.batchKey) map.set(b.pool.batchKey.toLowerCase(), { rollupId: r.rollupId, index: b.index, submittedTime: b.submittedTime });
  return map;
}

export const usePool = () => useQuery({ queryKey: ["pool"], queryFn: fetchPool, refetchInterval: 30_000 });

export function useWatchers(addresses: string[]) {
  return useQueries({
    queries: addresses.map((a) => ({
      queryKey: ["watcher", a.toLowerCase()],
      queryFn: () => fetchWatcher(a as Address),
      refetchInterval: MIN,
    })),
  });
}

export function useOnChainBatch(rollupId: string | undefined, index: number | undefined) {
  return useQuery({
    queryKey: ["batch", rollupId, index],
    queryFn: () => fetchBatch(rollupId!, index!),
    enabled: !!rollupId && index !== undefined,
    refetchInterval: 30_000,
  });
}
