"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { RollupFeed } from "../lib/feed";
import { useLanes } from "../lib/queries";
import { ago, dateTime } from "../lib/format";
import { Pill } from "./ui";
import { BatchStrip } from "./BatchStrip";

/** Every watched rollup as one dense row: its batches, how many verify, and whether instant exits are open. */
export function RollupTable({ rollups }: { rollups: RollupFeed[] }) {
  const router = useRouter();
  const { laneOf, isLoading: lanesLoading } = useLanes();
  const rows = [...rollups].sort((a, b) => b.batches.length - a.batches.length);
  return (
    <div className="table-wrap">
      <table className="rollup-table">
        <thead>
          <tr>
            <th>Rollup</th>
            <th>Batches, oldest to newest</th>
            <th className="num">Verified</th>
            <th className="num">ML-DSA signed</th>
            <th>Instant exits</th>
            <th>Latest batch</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const bad = r.batches.filter((b) => b.verdict !== "match").length;
            const pq = r.batches.filter((b) => b.submission?.pqVerified).length;
            const last = r.batches.at(-1);
            const to = `/r/${r.rollupId}`;
            return (
              <tr key={r.rollupId} className="link" onClick={() => router.push(to)}>
                <td className="mono"><Link href={to} onClick={(e) => e.stopPropagation()}>{r.rollupId}</Link></td>
                <td><BatchStrip rollup={r} linked={false} max={36} /></td>
                <td className="num">
                  {bad ? <span style={{ color: "var(--bad)" }}>{r.batches.length - bad}/{r.batches.length}</span> : <span>{r.batches.length}/{r.batches.length}</span>}
                </td>
                <td className="num">{pq}/{r.batches.length}</td>
                <td>{lanesLoading ? <span className="faint">…</span> : laneOf(r.rollupId)?.enabled ? <Pill tone="info">lane open</Pill> : <span className="faint">watched only</span>}</td>
                <td className="muted" title={last ? dateTime(last.submittedTime * 1000) : undefined}>{last ? ago(last.submittedTime * 1000) : "–"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

