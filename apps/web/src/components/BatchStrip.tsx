import { Link } from "react-router-dom";
import { batchState, type RollupFeed } from "../lib/feed";
import { dateTime } from "../lib/format";

/** One square per batch, oldest first, coloured by its state. */
export function BatchStrip({ rollup, linked = true }: { rollup: RollupFeed; linked?: boolean }) {
  return (
    <div className="strip" role="list" aria-label={`${rollup.batches.length} batches`}>
      {rollup.batches.map((b) => {
        const s = batchState(b);
        const title = `Batch ${b.index}: ${s}, ${dateTime(b.submittedTime * 1000)}`;
        return linked ? (
          <Link key={b.index} role="listitem" className={`s-${s}`} title={title} to={`/rollups/${rollup.rollupId}/batches/${b.index}`} />
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
