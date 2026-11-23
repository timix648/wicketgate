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
        <Stat label="Instant exits paid from lanes" value={exits} sub={`${qor(lpEarned)} QOR earned by lane liquidity providers so far`} />
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <p className="small" style={{ marginTop: 0 }}>
          <strong>Who earns what.</strong> Every instant exit pays a fee (the lane&apos;s base fee, rising to 3% as its liquidity is used). <strong>60%</strong> stays
          in the pool, so each liquidity provider&apos;s shares grow in value; <strong>30%</strong> goes to the watchers whose stake backed the batch; <strong>10%</strong>{" "}
          goes to whoever settles the exit once the batch finalises. A watcher who catches fraud also takes half the cheater&apos;s bond. Yields below are the
          liquidity providers&apos; 60%, annualised at the pace so far and shown once a lane is 3 days old: real figures, but from few exits, so indicative only.
          <br />
          <strong>What protects liquidity providers.</strong> A pool never advances more against a batch than the watcher stake it can lock behind it (it refuses with{" "}
          <code>CoverExceeded</code>), so every QOR in &quot;Advanced, not yet repaid&quot; is backed 1:1 by locked, slashable stake. If the chain never repays an advance,
          that stake is slashed into the pool. Users are never exposed: a payout is locked to its beneficiary, and at worst the chain pays it later.
        </p>
        <p className="small muted">
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
                  <th>LP earnings</th>
                  <th>Share value</th>
                  <th>Yield, annualised</th>
                  <th>Advanced, not yet repaid (1:1 stake-backed)</th>
                  <th>Opened</th>
                </tr>
              </thead>
              <tbody>
                {main && (
                  <tr>
                    <td><span className="mono">all lanes of the main pool</span> <Pill tone="muted">Wicketgate pool v3.1</Pill></td>
                    <td><Hash value={CONTRACTS.pool} /></td>
                    <td><Pill tone="muted">Wicketgate admins</Pill></td>
                    <td>{qor(main.liquidity)} QOR</td>
                    <td>0.30%+</td>
                    <td>2 of 3</td>
                    <td>-</td>
                    <td>{main.exits}</td>
                    <td>{qor(main.lpFeesWei)} QOR</td>
                    <td>{main.sharePrice.toFixed(6)}</td>
                    <td>{!main.exits ? "no exits yet" : main.ageDays < 3 ? `too early (${main.ageDays.toFixed(1)} days)` : `${main.aprPct.toFixed(1)}%`}</td>
                    <td>{pool.data ? `${qor(pool.data.outstanding)} QOR` : "-"}</td>
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
                    <td>{qor(r.liquidityWei)} QOR</td>
                    <td>{(r.feeBps / 100).toFixed(2)}%</td>
                    <td>{r.quorum} of the lane&apos;s watchers</td>
                    <td>{r.confirmations}</td>
                    <td>{r.exits}</td>
                    <td>{qor(r.lpFeesWei)} QOR</td>
                    <td>{r.sharePrice.toFixed(6)}</td>
                    <td>{!r.exits ? "no exits yet" : r.ageDays < 3 ? `too early (${r.ageDays.toFixed(1)} days)` : `${r.aprPct.toFixed(1)}%`}</td>
                    <td>{qor(r.outstandingWei)} QOR</td>
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
