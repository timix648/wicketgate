"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { batchState, type Batch, type RollupFeed } from "../lib/feed";
import { useAllRollups, useLanes, useMetrics, usePool } from "../lib/queries";
import { METRICS_SOURCE, repoFile } from "../lib/config";
import { ago, dateTime, duration, num, qorFromUqor, qorFromWei } from "../lib/format";
import { BatchPill, ErrorBox, Hash, Loading, Pill, Stat } from "../components/ui";
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

      <LeadFinding />

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
              source={METRICS_SOURCE}
            />
            <Stat
              label="Paid out instantly"
              value={num(m.money.qorPaidInstantly, 0)}
              unit="QOR"
              sub={<>{m.speed.instantExits} exits, {m.money.advancesRepaid} of {m.money.advancesDue} repaid, {m.money.defaults} defaults</>}
              source={METRICS_SOURCE}
            />
            <Stat
              label="Batches re-executed"
              value={<>{m.verification.matches}<small>/ {m.verification.batchesReExecuted} match</small></>}
              sub={<>across {m.verification.rollupsWatched} rollups, {m.verification.rollupsWeDoNotRun} created by other accounts</>}
              source={METRICS_SOURCE}
            />
            <Stat
              label="Post-quantum attestations"
              value={m.postQuantum.attestationsVerifiedOnChain}
              sub={<>ML-DSA-87 checked on chain; {m.postQuantum.classicalSignatureChecksInContracts} classical signature checks</>}
              source={METRICS_SOURCE}
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
              <a href={METRICS_SOURCE.href} target="_blank" rel="noreferrer"><strong>{num(m.speed.speedupAtMainnetDefaultWindow, 0)}×</strong></a> faster. Figures recomputed from chain data{" "}
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
            <Stat label="Pool assets" value={qorFromWei(pool.data.totalAssets, 2)} unit="QOR" sub="Liquidity providers' deposits plus fees" source={{ label: "ExitPool.totalAssets(): pool history", href: "/pool" }} />
            <Stat label="Available to advance" value={qorFromWei(pool.data.idleLiquidity, 2)} unit="QOR" sub="Idle liquidity right now" source={{ label: `ExitPool.idleLiquidity() at block ${pool.data.block}` }} />
            <Stat label="Advanced, awaiting repayment" value={qorFromWei(pool.data.outstanding, 2)} unit="QOR" sub="Repaid by the chain at finalisation" source={{ label: "ExitPool.outstandingWei(): every exit", href: "/exits" }} />
            <Stat label="Owed to watchers" value={qorFromWei(pool.data.watcherCredits, 4)} unit="QOR" sub="Their 30% share of exit fees" source={{ label: "ExitPool.watcherCreditsTotal(): per watcher", href: "/watchers" }} />
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
          <Link href="/exits" className="small">All instant exits →</Link>
        </div>
        <Activity />
      </div>

      {rollups.length > 0 && <RecentBatches rollups={rollups} />}
    </>
  );
}

/**
 * The watchtower doing its job on someone else's rollup (PROOF.md, 21 Nov 2026). LedgerPump staged
 * this fraud on purpose to show their rollup can be policed; it was, by a watcher they did not run.
 */
const LEDGERPUMP = {
  forged: "9DF2AFEB1A24EBBCE80B3CF7DA164DFB712C4CC2B35E0AB56117EB57CB193B62",
  challenge: "C93AB320110D41FFB5FC448195B05A5CD4803223FD0CB3C8224E4B7B3BFFA660",
  log: "https://github.com/lahdlahd/ledgerpump/blob/main/docs/TESTNET_LOG.md",
};

function LeadFinding() {
  return (
    <div className="card lead" style={{ marginBottom: 12 }}>
      <div className="row" style={{ gap: 8, marginBottom: 6 }}>
        <Pill tone="ok">Caught live</Pill>
        <span className="small muted">21 Nov 2026 · a rollup we do not run</span>
      </div>
      <h2 style={{ marginBottom: 6 }}>A wrong batch on LedgerPump&apos;s rollup was challenged 12 seconds after it was posted</h2>
      <p className="small" style={{ margin: 0 }}>
        LedgerPump, another team in the fest, staged a fraud demo on their own rollup: a batch with one byte of its state root flipped. Our watcher W1,
        which re-executes every rollup on QoreChain, found it and sent the fraud proof on its own, the only challenge on chain. The chain rejected the
        batch and slashed the 1,000 QOR bond, 500 burned and 500 paid to W1. Their demo showed exactly what it set out to: a lying batch on their
        rollup does not survive an independent watcher. Nobody on our team acted; we learned of it from W1&apos;s alert.
      </p>
      <div className="row small" style={{ gap: 14, marginTop: 10 }}>
        <span>forged batch <Hash value={LEDGERPUMP.forged} tx /></span>
        <span>W1&apos;s challenge <Hash value={LEDGERPUMP.challenge} tx /></span>
        <a href={LEDGERPUMP.log} target="_blank" rel="noreferrer">LedgerPump&apos;s own log ↗</a>
        <a href={repoFile("PROOF.md")} target="_blank" rel="noreferrer">PROOF.md ↗</a>
      </div>
    </div>
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
  const { laneOf } = useLanes();
  const hasLane = !!laneOf(rollup.rollupId)?.enabled;
  return (
    <Link href={`/r/${rollup.rollupId}`} className="card">
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
  const router = useRouter();
  const rows: { rollupId: string; b: Batch }[] = rollups
    .flatMap((r) => r.batches.map((b) => ({ rollupId: r.rollupId, b })))
    .sort((x, y) => y.b.submittedTime - x.b.submittedTime)
    .slice(0, 10);
  return (
    <div className="section">
      <div className="section-head">
        <h2>Latest batches, all rollups</h2>
        <Link href="/r" className="small">All rollups →</Link>
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
              const to = `/r/${rollupId}/${b.index}`;
              return (
                <tr key={`${rollupId}-${b.index}`} className="link" onClick={() => router.push(to)}>
                  <td className="mono"><Link href={to} onClick={(e) => e.stopPropagation()}>{rollupId}</Link></td>
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
