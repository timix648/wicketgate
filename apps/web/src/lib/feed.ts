// Types and fetchers for the public watcher feed and the metrics file.
import { FEED_BASE, METRICS_URL } from "./config";

export interface FeedIndex {
  version: number;
  watcher: string;
  rollups: { rollupId: string; updatedAt: string; batches: number; file: string }[];
}

export interface Withdrawal {
  index: string;
  recipient: string;
  recipientEvm: string;
  amountUqor: string;
  exitProof: string[];
  chainProof: unknown[];
}

export interface Batch {
  index: number;
  /** "finalized" today; anything else means still inside its challenge window. */
  status: string;
  inboxStart: number;
  inboxEnd: number;
  /** Unix seconds. */
  submittedTime: number;
  stateRoot: string;
  withdrawalsRoot: string;
  /** "match", "mismatch" or "rejected-on-chain". */
  verdict: string;
  reason?: string;
  challengeTx?: string | null;
  exitRoot?: string;
  withdrawals?: Withdrawal[];
  replacedSubmissions?: unknown[];
  submission?: { tx: string; height: number; signer: string; pqVerified: boolean; tier: string };
  pool?: {
    batchKey: string;
    confirmed: boolean;
    confirmedAt: string | null;
    contested: boolean;
    released: boolean;
    openAdvances: number;
    coverQor: number;
    advancedQor: number;
    watchers: string[];
  };
}

export interface RollupFeed {
  version: number;
  rollupId: string;
  rollupKey: string;
  lane?: { windowSecs: number; graceSecs: number; feeBps: number; quorum: number; lockPerWatcherQor: number; enabled: boolean };
  updatedAt: string;
  watcher: string;
  mode: string;
  inbox: { head: number; consumed: number; oldestPendingHeight: number | null };
  batches: Batch[];
}

export interface ExitRecord {
  pool: string;
  rollupId: string;
  batchIndex: number;
  batchStatus: string;
  amountQor: number;
  feeQor: number;
  exitTx: string;
  exitAddr: string;
  withdrawalPostTx?: string;
  gasUsed?: number;
  gasCostQor?: number;
  secondsFromRequest?: number;
  secondsAfterBatchPosted?: number;
  normalPathSeconds?: number;
  repaid: boolean;
  repaidTx?: string;
  repaidSecondsAfterAdvance?: number;
}

export interface Metrics {
  generatedAt: string;
  evmBlock: number;
  speed: {
    instantExits: number;
    medianSecondsFromBatchPostedToPaid: number;
    maxSecondsFromBatchPostedToPaid: number;
    medianSecondsFromWithdrawalRequestToPaid: number;
    medianNormalPathSeconds: number;
    speedupTestnet: number;
    speedupAtMainnetDefaultWindow: number;
  };
  money: {
    qorPaidInstantly: number;
    largestExitQor: number;
    feesQor: number;
    advancesDue: number;
    advancesRepaid: number;
    defaults: number;
    providerDepositsQor: number;
    poolAssetsNowQor: number;
    providerLossesQor: number;
    medianMinutesAdvanceToRepaid: number;
  };
  postQuantum: {
    attestationsVerifiedOnChain: number;
    distinctWatchers: number;
    batchesConfirmed: number;
    batchSubmissionsWithVerifiedMlDsaLayer: number;
    classicalSignatureChecksInContracts: number;
  };
  verification: { rollupsWatched: number; rollupsWeDoNotRun: number; batchesReExecuted: number; matches: number };
  fraud: { badBatchesSubmitted: number; caught: number; secondsToChallenge: number; bondSlashedQor: number };
  exits: ExitRecord[];
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} reading ${url}`);
  return (await res.json()) as T;
}

export const fetchIndex = () => getJson<FeedIndex>(`${FEED_BASE}/index.json`);
export const fetchRollup = (file: string) => getJson<RollupFeed>(`${FEED_BASE}/${file}`);
export const fetchMetrics = () => getJson<Metrics>(METRICS_URL);

/** Status of a batch as the board shows it, worst first. */
export type BatchState = "mismatch" | "contested" | "pending" | "confirmed" | "match";

export function batchState(b: Batch): BatchState {
  if (b.verdict !== "match") return "mismatch";
  if (b.pool?.contested) return "contested";
  if (b.status !== "finalized") return b.pool?.confirmed ? "confirmed" : "pending";
  return "match";
}
