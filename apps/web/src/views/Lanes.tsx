"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchLanes, LANE_HUB, qor, yieldOf } from "../lib/lanes";
import { usePool, useEvents } from "../lib/queries";
import { CONTRACTS } from "../lib/config";
import deployments from "../../../../deployments/diana.json";
import { REPO_URL } from "../lib/config";
import { ErrorBox, Hash, Loading, Pill, Stat } from "../components/ui";

export function Lanes() {
  const q = useQuery({ queryKey: ["lanes"], queryFn: fetchLanes, refetchInterval: 60_000 });
  const rows = q.data ?? [];
  const rollups = new Set(rows.map((r) => r.rollupId)).size;
  const liquidity = rows.reduce((s, r) => s + r.liquidityWei, 0n);
  const exits = rows.reduce((s, r) => s + r.exits, 0);
  const outside = rows.filter((r) => !r.isWicketgateAdmin).length;
  const lpEarned = rows.reduce((s, r) => s + r.lpFeesWei, 0n);

  // Wicketgate's own pool, for comparison: the same fee split, from the events the app already loads.
  const pool = usePool();
  const events = useEvents();
  const main = (() => {
    if (!pool.data || !events.data) return undefined;
    const exits = events.data.events.filter((e) => e.name === "InstantExit" && e.address.toLowerCase() === CONTRACTS.pool.toLowerCase());
    const fees = exits.reduce((t, e) => t + BigInt(e.args.feeWei ?? 0n), 0n);
    const since = Date.parse((deployments as any).deployedAt) / 1000;
    return { exits: exits.length, ...yieldOf(fees, pool.data.totalAssets, pool.data.totalAssets, pool.data.totalShares, since), liquidity: pool.data.totalAssets };
  })();

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Network</div>
        <h1>Lanes</h1>
        <p>
          Anyone can open an instant-exit lane for any QoreChain rollup, without asking us. Each lane is a separate pool and watcher registry
          running only the audited Wicketgate code, controlled by its opener&apos;s two ML-DSA-87 keys and holding its own liquidity, so a badly run
          lane can only lose what was put into it. Lanes serving the same rollup compete on fees; the hub has no owner. Read live from the chain.
        </p>
      </div>

      <div className="grid stats">
        <Stat label="Lanes" value={q.data ? rows.length : "…"} sub={`${outside} run by keys other than the Wicketgate admin keys`} />
        <Stat label="Rollups served" value={q.data ? rollups : "…"} />
        <Stat label="Lane liquidity" value={q.data ? qor(liquidity) : "…"} unit="QOR" sub="held by the lanes, separate from the main pool" />
        <Stat label="Instant exits paid from lanes" value={q.data ? exits : "…"} sub={`${qor(lpEarned)} QOR earned by lane liquidity providers so far`} />
      </div>

      <div className="section grid two">
        <div className="card">
          <h3>Who earns what</h3>
          <p className="small" style={{ margin: 0 }}>
            Every instant exit pays a fee: the lane&apos;s base fee, rising to 3% as its liquidity is used. <strong>60%</strong> stays in the pool, so
            each liquidity provider&apos;s shares grow; <strong>30%</strong> goes to the watchers whose stake backed the batch; <strong>10%</strong> goes
            to whoever settles the exit once the batch is final. A watcher who catches fraud also takes half the cheater&apos;s bond.
          </p>
          <p className="small muted" style={{ marginBottom: 0 }}>
            Yields are the providers&apos; 60%, annualised at the pace so far and shown once a lane is 3 days old: real figures from few exits, so
            indicative only.
          </p>
        </div>
        <div className="card">
          <h3>What protects liquidity providers</h3>
          <p className="small" style={{ margin: 0 }}>
            A pool never advances more against a batch than the watcher stake it can lock behind it (it refuses with <code>CoverExceeded</code>), so
            every QOR advanced and not yet repaid is backed 1:1 by locked, slashable stake. If the chain never repays an advance, that stake is
            slashed into the pool. Users are never exposed: a payout is locked to its beneficiary, and at worst the chain pays it later.
          </p>
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <h2>Every lane</h2>
          <p>
            LaneHub <Hash value={LANE_HUB.address} /> · deployed in <Hash value={LANE_HUB.deployTx} tx /> · accepts only pool code hashing to{" "}
            <span className="mono">{LANE_HUB.poolCodeHash.slice(0, 18)}…</span> ·{" "}
            <a href={`${REPO_URL}/blob/main/docs/LANES.md`} target="_blank" rel="noreferrer">how to open one ↗</a>
          </p>
        </div>
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
                  <th className="num">Liquidity</th>
                  <th className="num">Fee</th>
                  <th>Quorum</th>
                  <th className="num">Batches confirmed</th>
                  <th className="num">Exits paid</th>
                  <th className="num">LP earnings</th>
                  <th className="num">Share value</th>
                  <th className="num">Yield, annualised</th>
                  <th className="num" title="Backed 1:1 by locked watcher stake">Advanced, not yet repaid</th>
                  <th>Opened</th>
                </tr>
              </thead>
              <tbody>
                {main && (
                  <tr>
                    <td><span className="mono">all lanes of the main pool</span> <Pill tone="muted">Wicketgate pool v3.1</Pill></td>
                    <td><Hash value={CONTRACTS.pool} /></td>
                    <td><Pill tone="muted">Wicketgate admins</Pill></td>
                    <td className="num">{qor(main.liquidity)} QOR</td>
                    <td className="num">0.30%+</td>
                    <td>2 of 3</td>
                    <td className="num">-</td>
                    <td className="num">{main.exits}</td>
                    <td className="num">{qor(main.lpFeesWei)} QOR</td>
                    <td className="num">{main.sharePrice.toFixed(6)}</td>
                    <td>{!main.exits ? "no exits yet" : main.ageDays < 3 ? `too early (${main.ageDays.toFixed(1)} days)` : `${main.aprPct.toFixed(1)}%`}</td>
                    <td className="num">{pool.data ? `${qor(pool.data.outstanding)} QOR` : "-"}</td>
                    <td>-</td>
                  </tr>
                )}
                {rows.map((r) => (
                  <tr key={r.pool}>
                    <td><span className="mono">{r.rollupId}</span> {!r.enabled && <Pill tone="muted">disabled</Pill>}</td>
                    <td><Hash value={r.pool} /></td>
                    <td>
                      <Hash value={r.adminA} /> + <Hash value={r.adminB} />{" "}
                      {r.isWicketgateAdmin ? <Pill tone="muted">Wicketgate admins</Pill> : <Pill tone="info" title="Separate ML-DSA-87 keys, not the Wicketgate admin keys. The lanes opened so far are a team-run test provider.">separate provider keys</Pill>}
                    </td>
                    <td className="num">{qor(r.liquidityWei)} QOR</td>
                    <td className="num">{(r.feeBps / 100).toFixed(2)}%</td>
                    <td>{r.quorum} of the lane&apos;s watchers</td>
                    <td className="num">{r.confirmations}</td>
                    <td className="num">{r.exits}</td>
                    <td className="num">{qor(r.lpFeesWei)} QOR</td>
                    <td className="num">{r.sharePrice.toFixed(6)}</td>
                    <td>{!r.exits ? "no exits yet" : r.ageDays < 3 ? `too early (${r.ageDays.toFixed(1)} days)` : `${r.aprPct.toFixed(1)}%`}</td>
                    <td className="num">{qor(r.outstandingWei)} QOR</td>
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
