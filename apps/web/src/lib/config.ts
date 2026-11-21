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

/** First block to scan for a pool whose deployment file does not record one (pool v2.1, brief section 6). */
const FALLBACK_DEPLOY_BLOCK = 10_212_000;

type Deployment = { pool: string; registry: string; version?: string; deployBlock?: number; file?: string };
const dep = deployments as Deployment & { previous?: Deployment };

export const CONTRACTS = {
  pool: dep.pool as Address,
  registry: dep.registry as Address,
  version: dep.version ?? "current",
  deployBlock: BigInt(dep.deployBlock ?? FALLBACK_DEPLOY_BLOCK),
};

/**
 * Every pool whose events the board reads: the live one, then the one it replaced, so history
 * (exits, attestations, watchers) stays visible across an upgrade. Each is scanned from its own deploy block.
 */
export interface PoolDeployment {
  version: string;
  pool: Address;
  registry: Address;
  fromBlock: bigint;
  live: boolean;
}

export const POOLS: PoolDeployment[] = [
  { version: CONTRACTS.version, pool: CONTRACTS.pool, registry: CONTRACTS.registry, fromBlock: CONTRACTS.deployBlock, live: true },
  ...(dep.previous?.pool && dep.previous.registry
    ? [
        {
          version: dep.previous.version ?? dep.previous.file?.match(/v([\d.]+)\.json$/)?.[1] ?? "previous",
          pool: dep.previous.pool as Address,
          registry: dep.previous.registry as Address,
          fromBlock: BigInt(dep.previous.deployBlock ?? FALLBACK_DEPLOY_BLOCK),
          live: false,
        },
      ]
    : []),
];

/** Which deployment a pool or registry address belongs to. */
export function poolOf(address: string): PoolDeployment | undefined {
  const a = address.toLowerCase();
  return POOLS.find((p) => p.pool.toLowerCase() === a || p.registry.toLowerCase() === a);
}

/** The public RPC refuses eth_getLogs over more than 10,000 blocks. */
export const LOG_RANGE = 10_000n;

/** The team's own accounts, labelled as the frontend brief asks. Anyone else shows as an address. */
export const KNOWN_WATCHERS: Record<string, { name: string; note: string }> = {
  "0xe754dfbe7c4c4061d089b8e262f6f4c36e563bc0": { name: "W1", note: "Active watcher; publishes the public feed" },
  "0x65261e42c226e4a34256f5f144ae2ea63db5bae4": { name: "W2", note: "Active watcher; earned the 500 QOR fraud bounty" },
  "0xac82ffe5610f14d09ef451e5c71254be9164cc88": { name: "W3", note: "Drill account, key handed to the attack bot" },
  "0x718ed43cba438b9d7095e56787b315ab433903cc": { name: "W4", note: "Q-Day demo (deliberately weak classical key)" },
};

export function watcherName(addr: string): string | undefined {
  return KNOWN_WATCHERS[addr.toLowerCase()]?.name;
}
