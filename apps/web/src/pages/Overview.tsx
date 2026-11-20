import { Link, useNavigate } from "react-router-dom";
import { batchState, type Batch, type RollupFeed } from "../lib/feed";
import { useAllRollups, useMetrics, usePool } from "../lib/queries";
import { LANES } from "../lib/config";
import { ago, dateTime, duration, num, qorFromUqor, qorFromWei } from "../lib/format";
import { BatchPill, ErrorBox, Loading, Pill, Stat } from "../components/ui";
import { BatchStrip, StripLegend } from "../components/BatchStrip";
import { Activity } from "../components/Activity";

export function Overview() {
  const metrics = useMetrics();
  const pool = usePool();
  const { rollups, isLoading, error } = useAllRollups();
  const m = metrics.data;

  return (
    <>
      <div className="page-head">
        <h1>Leaving a QoreChain rollup should take seconds, not seven days.</h1>
        <p>
          Independent watchers re-execute every rollup batch, sign what they found with ML-DSA-87 post-quantum keys and put stake
          behind it. The pool pays withdrawals from confirmed batches at once, and the chain repays the pool when the batch is final.
        </p>
      </div>

      {metrics.error ? (
        <ErrorBox error={metrics.error} />
      ) : !m ? (
        <Loading />
      ) : (
        <>
          <div className="grid stats">
            <Stat
              label="Median time to funds"
              value={num(m.speed.medianSecondsFromBatchPostedToPaid, 0)}
              unit="s"
              sub={<>from batch on chain to money paid, vs {duration(m.speed.medianNormalPathSeconds)} the normal way</>}
            />
            <Stat
              label="Paid out instantly"
              value={num(m.money.qorPaidInstantly, 0)}
              unit="QOR"
              sub={<>{m.speed.instantExits} exits, {m.money.advancesRepaid} of {m.money.advancesDue} repaid, {m.money.defaults} defaults</>}
            />
            <Stat
              label="Batches re-executed"
              value={<>{m.verification.matches}<small>/ {m.verification.batchesReExecuted} match</small></>}
              sub={<>across {m.verification.rollupsWatched} rollups, {m.verification.rollupsWeDoNotRun} run by other teams</>}
            />
            <Stat
              label="Post-quantum attestations"
              value={m.postQuantum.attestationsVerifiedOnChain}
              sub={<>ML-DSA-87 checked on chain; {m.postQuantum.classicalSignatureChecksInContracts} classical signature checks</>}
            />
          </div>

          <div className="section card">
            <div className="section-head">
              <h2>Time from batch to money</h2>
              <p>Median of {m.speed.instantExits} instant exits on testnet</p>
            </div>
            <div className="compare">
              <CompareLine label="Wicketgate" secs={m.speed.medianSecondsFromBatchPostedToPaid} max={m.speed.medianNormalPathSeconds} color="var(--accent)" />
              <CompareLine label="Normal withdrawal" secs={m.speed.medianNormalPathSeconds} max={m.speed.medianNormalPathSeconds} color="var(--faint)" />
            </div>
            <p className="small muted" style={{ marginBottom: 0 }}>
              The testnet challenge window is one hour. At the chain's seven-day default the same exits would be about{" "}
              <strong>{num(m.speed.speedupAtMainnetDefaultWindow, 0)}×</strong> faster. Figures recomputed from chain data{" "}
              {ago(m.generatedAt)}.
            </p>
          </div>
        </>
      )}

      <div className="section">
        <div className="section-head">
          <h2>Exit pool, live</h2>
          <p>{pool.data ? <>read from block {pool.data.block.toString()}</> : "reading the chain…"}</p>
        </div>
        {pool.error ? (
          <ErrorBox error={pool.error} />
        ) : !pool.data ? (
          <Loading lines={2} />
        ) : (
          <div className="grid stats">
            <Stat label="Pool assets" value={qorFromWei(pool.data.totalAssets, 2)} unit="QOR" sub="Liquidity providers' deposits plus fees" />
            <Stat label="Available to advance" value={qorFromWei(pool.data.idleLiquidity, 2)} unit="QOR" sub="Idle liquidity right now" />
            <Stat label="Advanced, awaiting repayment" value={qorFromWei(pool.data.outstanding, 2)} unit="QOR" sub="Repaid by the chain at finalisation" />
            <Stat label="Owed to watchers" value={qorFromWei(pool.data.watcherCredits, 4)} unit="QOR" sub="Their 30% share of exit fees" />
          </div>
        )}
      </div>

      <div className="section">
        <div className="section-head">
          <h2>Rollups being watched</h2>
          <StripLegend />
        </div>
        {error ? (
          <ErrorBox error={error} />
        ) : isLoading && rollups.length === 0 ? (
          <Loading />
        ) : (
          <div className="grid cards">
            {[...rollups].sort((a, b) => b.batches.length - a.batches.length).map((r) => (
              <RollupCard key={r.rollupId} rollup={r} />
            ))}
          </div>
        )}
      </div>

      <div className="section">
        <div className="section-head">
          <h2>Pool activity</h2>
          <Link to="/exits" className="small">All instant exits →</Link>
        </div>
        <Activity />
      </div>

      {rollups.length > 0 && <RecentBatches rollups={rollups} />}
    </>
  );
}

function CompareLine({ label, secs, max, color }: { label: string; secs: number; max: number; color: string }) {
  return (
    <div className="line">
      <span>{label}</span>
      <div className="track">
        <div className="fill" style={{ width: `${Math.max(1.5, (secs / max) * 100)}%`, background: color }} />
      </div>
      <span className="val">{duration(secs)}</span>
    </div>
  );
}

function RollupCard({ rollup }: { rollup: RollupFeed }) {
  const last = rollup.batches.at(-1);
  const bad = rollup.batches.filter((b) => b.verdict !== "match").length;
  const pq = rollup.batches.filter((b) => b.submission?.pqVerified).length;
  const hasLane = !!LANES[rollup.rollupId]?.enabled;
  return (
    <Link to={`/rollups/${rollup.rollupId}`} className="card">
      <div className="row" style={{ marginBottom: 10 }}>
        <h3 style={{ margin: 0 }} className="mono">{rollup.rollupId}</h3>
        <span className="spacer" />
        {hasLane ? <Pill tone="info" title="The pool pays instant exits from this rollup">Exit lane open</Pill> : <Pill tone="muted">Watched only</Pill>}
      </div>
      <BatchStrip rollup={rollup} linked={false} />
      <dl className="kv small" style={{ marginTop: 12 }}>
        <dt>Batches</dt>
        <dd>
          {rollup.batches.length} · {bad === 0 ? <span style={{ color: "var(--ok)" }}>all match</span> : <span style={{ color: "var(--bad)" }}>{bad} mismatch</span>}
        </dd>
        <dt>ML-DSA signed</dt>
        <dd>{pq} of {rollup.batches.length} submissions</dd>
        <dt>Latest batch</dt>
        <dd>{last ? ago(last.submittedTime * 1000) : "none yet"}</dd>
      </dl>
    </Link>
  );
}

function RecentBatches({ rollups }: { rollups: RollupFeed[] }) {
  const nav = useNavigate();
  const rows: { rollupId: string; b: Batch }[] = rollups
    .flatMap((r) => r.batches.map((b) => ({ rollupId: r.rollupId, b })))
    .sort((x, y) => y.b.submittedTime - x.b.submittedTime)
    .slice(0, 10);
  return (
    <div className="section">
      <div className="section-head">
        <h2>Latest batches, all rollups</h2>
        <Link to="/rollups" className="small">All rollups →</Link>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Rollup</th>
              <th className="num">Batch</th>
              <th>Submitted</th>
              <th className="num">Withdrawals</th>
              <th>Verdict</th>
              <th>Pool</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ rollupId, b }) => {
              const total = (b.withdrawals ?? []).reduce((s, w) => s + Number(w.amountUqor), 0);
              const to = `/rollups/${rollupId}/batches/${b.index}`;
              return (
                <tr key={`${rollupId}-${b.index}`} className="link" onClick={() => nav(to)}>
                  <td className="mono"><Link to={to} onClick={(e) => e.stopPropagation()}>{rollupId}</Link></td>
                  <td className="num">{b.index}</td>
                  <td title={dateTime(b.submittedTime * 1000)}>{ago(b.submittedTime * 1000)}</td>
                  <td className="num">{b.withdrawals?.length ? `${b.withdrawals.length} · ${qorFromUqor(total)} QOR` : <span className="faint">0</span>}</td>
                  <td><BatchPill state={batchState(b)} /></td>
                  <td>{b.pool?.confirmed ? <span>confirmed by {b.pool.watchers.length}</span> : <span className="faint">not confirmed</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
