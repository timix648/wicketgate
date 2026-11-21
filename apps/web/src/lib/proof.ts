// The proof pages read the evidence files committed in the repository, at build time, and link
// every figure back to its file or transaction.
import qday from "../../../../docs/qday.json";
import redteam from "../../../../docs/redteam.json";
import stress from "../../../../docs/stress.json";
import timeline from "../../../../deployments/demo-timeline.json";
import { REPO_URL } from "./config";

export const sourceUrl = (path: string) => `${REPO_URL}/blob/main/${path}`;

export const SOURCES = {
  qday: { data: "docs/qday.json", doc: "docs/QDAY.md" },
  redteam: { data: "docs/redteam.json", doc: "docs/REDTEAM.md" },
  stress: { data: "docs/stress.json", doc: "docs/STRESS.md" },
  fraud: { data: "deployments/demo-timeline.json", doc: "PROOF.md" },
} as const;

export interface Attempt {
  target: string;
  layer: string;
  what: string;
  refused: boolean;
  result: string;
}

export const QDAY = qday as typeof qday & { closed: { attempts: Attempt[] }; open: { attempts: Attempt[] } };
export const REDTEAM = redteam;
export const STRESS = stress;

export interface TimelineEvent {
  story: string;
  label: string;
  lane: "cosmos" | "evm";
  tx: string;
  height: number;
  time: number;
}
export const FRAUD_DEMO = (timeline.events as TimelineEvent[]).filter((e) => e.story === "fraud");

/**
 * The second fraud catch (19 November): a batch with an honest state root but a fabricated
 * withdrawals root. Its transactions are recorded in PROOF.md, not in demo-timeline.json.
 */
export const WITHDRAWALS_ROOT_LIE = {
  date: "19 Nov 2026",
  batch: 15,
  seconds: 16,
  heights: [10_392_938, 10_392_949] as const,
  events: [
    { label: "ADMIN_B, playing the attacker, submits batch 15: honest state root, fabricated withdrawals root (the batch had no withdrawals)", tx: "D178C82640E413CDBB5A2E6B492C8B302C95C4BED8A5201B670A364D17A25C6D", height: 10_392_938 },
    { label: "Watcher W1 re-executes, builds the fraud proof and challenges: batch rejected, 1,000 QOR bond slashed, 500 burned and 500 to W1", tx: "2A766E33FB5A0C8C324B4AF16C4DD6F3E6E1A133D98ABC24615DE47EDB4CCE74", height: 10_392_949 },
    { label: "The honest operator re-batches the entries as batch 15", tx: "5B2272930F7AE39728068A316E5F0C2E3161A453D43D0BB5938A8C4D77122D70" },
  ],
};

/** Transaction hashes quoted inside a result string, so they can be shown as links or copyable. */
export function hashesIn(text: string): string[] {
  return [...new Set(text.match(/0x[0-9a-fA-F]{64}\b|\b[0-9A-F]{64}\b/g) ?? [])];
}

/** A result string without the hashes it quotes (they are shown separately). */
export function withoutHashes(text: string): string {
  return text.replace(/\s*\(?0x[0-9a-fA-F]{64}\)?/g, "").replace(/\s*(attest|drain)\s*(,|$)/g, "$2").replace(/[,\s]+$/, "");
}
