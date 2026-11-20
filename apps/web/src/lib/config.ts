// Where the board reads from. Everything here is public: no keys, no accounts.
import deployments from "../../../../deployments/diana.json";
import type { Address } from "viem";

export const NET = {
  name: "QoreChain testnet (diana)",
  chainId: "qorechain-diana",
  evmChainId: 9800,
  evmRpc: "https://evm-testnet.qore.host",
  rest: "https://api-testnet.qore.host",
  explorer: "https://explore.qore.network",
};

/** The watcher feed, published every 5 minutes by the team's watcher. */
export const FEED_BASE = "https://raw.githubusercontent.com/timix648/wicketgate-feed/main";
/** Headline figures recomputed from chain data by `pnpm metrics`. */
export const METRICS_URL = "https://raw.githubusercontent.com/timix648/wicketgate/main/docs/metrics.json";
export const REPO_URL = "https://github.com/timix648/wicketgate";

export const CONTRACTS = {
  pool: deployments.pool as Address,
  registry: deployments.registry as Address,
  version: deployments.version,
  /** First EVM block with pool v2.1 code; event scans start here. Update on redeploy. */
  deployBlock: 10_213_400n,
};

/** The public RPC refuses eth_getLogs over more than 10,000 blocks. */
export const LOG_RANGE = 10_000n;

/** Lanes the pool has open, keyed by rollup id (from deployments/diana.json). */
export const LANES = deployments.lanes as Record<string, { rollupKey: string; enabled: boolean }>;

/** The team's own accounts, so the board can name them. Anyone else shows as an address. */
export const KNOWN_WATCHERS: Record<string, { name: string; note: string }> = {
  "0xe754dfbe7c4c4061d089b8e262f6f4c36e563bc0": { name: "W1", note: "Team watcher; publishes the public feed" },
  "0x65261e42c226e4a34256f5f144ae2ea63db5bae4": { name: "W2", note: "Team watcher" },
  "0xac82ffe5610f14d09ef451e5c71254be9164cc88": { name: "W3", note: "Q-Day Drill account" },
  "0x718ed43cba438b9d7095e56787b315ab433903cc": { name: "W4", note: "Q-Day simulation: deliberately weak classical key" },
};

export function watcherName(addr: string): string | undefined {
  return KNOWN_WATCHERS[addr.toLowerCase()]?.name;
}
