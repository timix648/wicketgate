"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchLanes, LANE_HUB, qor } from "../lib/lanes";
import { REPO_URL } from "../lib/config";
import { ErrorBox, Hash, Loading, Pill, Stat } from "../components/ui";

export function Lanes() {
  const q = useQuery({ queryKey: ["lanes"], queryFn: fetchLanes, refetchInterval: 60_000 });
  const rows = q.data ?? [];
  const rollups = new Set(rows.map((r) => r.rollupId)).size;
  const liquidity = rows.reduce((s, r) => s + r.liquidityWei, 0n);
  const exits = rows.reduce((s, r) => s + r.exits, 0);
  const outside = rows.filter((r) => !r.isWicketgateAdmin).length;

  return (
    <>
      <div className="page-head">
        <h1>Lanes</h1>
        <p>
          Anyone can open an instant-exit lane for any QoreChain rollup, without asking us. <code>LaneHub</code> deploys a separate pool and
          watcher registry for each lane, accepts only the audited Wicketgate code, and requires the opener&apos;s two admin keys to be ML-DSA-87
          keys registered on chain. Each lane holds its own liquidity, so a badly run lane can only lose what was put into it. Several lanes can
          serve one rollup and compete on fees. The hub has no owner and no admin. The lanes so far were opened by a team-run test provider with its own keys, separate from the Wicketgate admin keys; any team can open its own. Read live from the chain.
        </p>
      </div>

      <div className="grid stats">
        <Stat label="Lanes" value={rows.length} sub={`${outside} run by keys other than the Wicketgate admin keys`} />
        <Stat label="Rollups served" value={rollups} />
        <Stat label="Lane liquidity" value={qor(liquidity)} unit="QOR" sub="held by the lanes, separate from the main pool" />
        <Stat label="Instant exits paid from lanes" value={exits} />
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <p className="small muted" style={{ marginTop: 0 }}>
          LaneHub <Hash value={LANE_HUB.address} /> (deployed in <Hash value={LANE_HUB.deployTx} tx />). It refuses any pool whose creation code does
          not hash to <span className="mono">{LANE_HUB.poolCodeHash.slice(0, 18)}…</span>, the ExitPool in this repository.{" "}
          <a href={`${REPO_URL}/blob/main/docs/LANES.md`} target="_blank" rel="noreferrer">How lanes work and how to open one ↗</a>
        </p>
        {q.isLoading && <Loading />}
        {q.error && <ErrorBox error={q.error} />}
        {rows.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Rollup</th>
                  <th>Lane pool</th>
                  <th>Run by (two ML-DSA-87 keys)</th>
                  <th>Liquidity</th>
                  <th>Fee</th>
                  <th>Quorum</th>
                  <th>Batches confirmed</th>
                  <th>Exits paid</th>
                  <th>Opened</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.pool}>
                    <td><span className="mono">{r.rollupId}</span> {!r.enabled && <Pill tone="muted">disabled</Pill>}</td>
                    <td><Hash value={r.pool} /></td>
                    <td>
                      <Hash value={r.adminA} /> + <Hash value={r.adminB} />{" "}
                      {r.isWicketgateAdmin ? <Pill tone="muted">Wicketgate admins</Pill> : <Pill tone="info" title="Separate ML-DSA-87 keys, not the Wicketgate admin keys. The lanes opened so far are a team-run test provider.">separate provider keys</Pill>}
                    </td>
                    <td>{qor(r.liquidityWei)} QOR</td>
                    <td>{(r.feeBps / 100).toFixed(2)}%</td>
                    <td>{r.quorum} of the lane&apos;s watchers</td>
                    <td>{r.confirmations}</td>
                    <td>{r.exits}</td>
                    <td>{r.openTx ? <Hash value={r.openTx} tx /> : new Date(r.openedAt * 1000).toISOString().slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
