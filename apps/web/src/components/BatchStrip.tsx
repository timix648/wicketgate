"use client";

import Link from "next/link";
import { batchState, type RollupFeed } from "../lib/feed";
import { dateTime } from "../lib/format";

/**
 * One square per batch, oldest first, coloured by its state. With `max`, only the newest `max`
 * batches are drawn; the label in front counts the earlier ones and says if any of them is wrong,
 * so a mismatch never drops out of sight.
 */
export function BatchStrip({ rollup, linked = true, max }: { rollup: RollupFeed; linked?: boolean; max?: number }) {
  const shown = max && rollup.batches.length > max ? rollup.batches.slice(-max) : rollup.batches;
  const hidden = rollup.batches.slice(0, rollup.batches.length - shown.length);
  const hiddenBad = hidden.filter((b) => batchState(b) === "mismatch" || batchState(b) === "contested").length;
  return (
    <div className="strip" role="list" aria-label={`${rollup.batches.length} batches`}>
      {hidden.length > 0 && (
        <span className="strip-more" style={hiddenBad ? { color: "var(--bad)" } : undefined} title={`${hidden.length} earlier batches not drawn`}>
          +{hidden.length.toLocaleString()}{hiddenBad ? ` (${hiddenBad} wrong)` : ""}
        </span>
      )}
      {shown.map((b) => {
        const s = batchState(b);
        const title = `Batch ${b.index}: ${s}, ${dateTime(b.submittedTime * 1000)}`;
        return linked ? (
          <Link key={b.index} role="listitem" className={`s-${s}`} title={title} href={`/r/${rollup.rollupId}/${b.index}`} />
        ) : (
          <span key={b.index} role="listitem" className={`s-${s}`} title={title} />
        );
      })}
    </div>
  );
}

export function StripLegend() {
  return (
    <div className="legend">
      <span><i style={{ background: "var(--ok)", opacity: 0.75 }} />Verified, final</span>
      <span><i style={{ background: "var(--info)" }} />Confirmed, in window</span>
      <span><i style={{ background: "var(--warn)" }} />Awaiting watchers</span>
      <span><i style={{ background: "var(--bad)" }} />Mismatch or contested</span>
    </div>
  );
}
