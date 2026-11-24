"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { batchState, type Batch, type RollupFeed } from "../lib/feed";
import { useAllRollups, useEvents, useLanes, useMetrics, usePool } from "../lib/queries";
import { CONTRACTS, METRICS_SOURCE, repoFile } from "../lib/config";
import { ago, dateTime, num, qorFromUqor, qorFromWei } from "../lib/format";
import { BatchPill, ErrorBox, Hash, Loading, Pill, Stat } from "../components/ui";
import { BatchStrip, StripLegend } from "../components/BatchStrip";
import { Activity } from "../components/Activity";

export function Overview() {
  const metrics = useMetrics();
  const { rollups, isLoading, error } = useAllRollups();
  const m = metrics.data;

  return (
    <>
      <section className="hero">
        <div>
          <div className="eyebrow">Instant exits for QoreChain rollups</div>
          <h1 style={{ marginTop: 6 }}>Leaving a rollup should take seconds, not seven days.</h1>
          <p>
            Independent watchers re-execute every rollup batch, sign what they found with ML-DSA-87 post-quantum keys and put stake behind it. A
            pool pays your withdrawal from a confirmed batch at once, and the chain repays the pool when the batch is final.
          </p>
          <div className="hero-actions">
            <Link href="/wallet" className="btn">Withdraw instantly</Link>
            <Link href="/proof" className="btn-ghost">See the proof</Link>
            <Link href="/r" className="btn-ghost">Every rollup, live</Link>
          </div>
        </div>
        <ExitBoard m={m} error={metrics.error} />
      </section>

      <LiveStrip rollups={rollups} />

      <div className="section">
        <LeadFinding />
      </div>

      <div className="section">
        <div className="section-head">
          <h2>Since 16 November, on testnet</h2>
          {m && <p>recomputed from chain data {ago(m.generatedAt)}</p>}
        </div>
        {metrics.error ? (
          <ErrorBox error={metrics.error} />
        ) : !m ? (
          <Loading lines={2} />
        ) : (
          <div className="grid stats">
            <Stat
              label="Paid out instantly"
              value={num(m.money.qorPaidInstantly, 0)}
              unit="QOR"
              sub={<>{m.speed.instantExits} exits; {m.money.advancesRepaid} of {m.money.advancesDue} repaid by the chain, {m.money.defaults} defaults</>}
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
              sub={<>ML-DSA-87, checked inside the contract; {m.postQuantum.classicalSignatureChecksInContracts} classical signature checks</>}
              source={METRICS_SOURCE}
            />
            <Stat
              label="Lost by liquidity providers"
              value={num(m.money.providerLossesQor, 0)}
              unit="QOR"
              sub={<>{num(m.money.feesQor, 3)} QOR earned in fees</>}
              source={METRICS_SOURCE}
            />
          </div>
        )}
      </div>

      <div className="section">
        <div className="section-head">
          <h2>Rollups being watched</h2>
          <StripLegend />
        </div>
        {error ? <ErrorBox error={error} /> : isLoading && rollups.length === 0 ? <Loading /> : <RollupTable rollups={rollups} />}
      </div>

      <div className="section grid two" style={{ alignItems: "start" }}>
        <div>
          <div className="section-head">
            <h2>Pool activity</h2>
            <Link href="/exits" className="small">Every exit →</Link>
          </div>
          <Activity limit={8} />
        </div>
        <div>
          <div className="section-head">
            <h2>Latest batches</h2>
            <Link href="/r" className="small">All rollups →</Link>
          </div>
          {rollups.length > 0 ? <RecentBatches rollups={rollups} /> : <Loading lines={4} />}
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------- the departure board

function ExitBoard({ m, error }: { m?: ReturnType<typeof useMetrics>["data"]; error: unknown }) {
  return (
    <div className="board" aria-label="Time from a confirmed batch to money in hand">
      <div className="board-head">
        <span className="eyebrow">Batch on chain → money in hand</span>
        <span className="eyebrow" style={{ color: "var(--faint)" }}>median</span>
      </div>
      {error ? (
        <div style={{ padding: 14 }}><ErrorBox error={error} /></div>
      ) : !m ? (
        <div style={{ padding: 14 }}><Loading lines={3} /></div>
      ) : (
        <>
          <div className="board-row fast">
            <div><div className="what">Wicketgate instant exit</div><div className="how">paid by the pool once two watchers confirm</div></div>
            <div className="time">{num(m.speed.medianSecondsFromBatchPostedToPaid, 0)}<small>s</small></div>
          </div>
          <div className="board-row slow">
            <div><div className="what">Normal withdrawal, testnet</div><div className="how">waits out the 1-hour challenge window</div></div>
            <div className="time">{num(m.speed.medianNormalPathSeconds / 60, 0)}<small>min</small></div>
          </div>
          <div className="board-row slow">
            <div><div className="what">Normal withdrawal, chain default</div><div className="how">the 7-day window most rollups keep</div></div>
            <div className="time">7<small>days</small></div>
          </div>
          <div className="board-foot">
            {m.speed.instantExits} exits · about {num(m.speed.speedupAtMainnetDefaultWindow, 0)}× faster at the default ·{" "}
            <a href={METRICS_SOURCE.href} target="_blank" rel="noreferrer">{METRICS_SOURCE.label} ↗</a>
          </div>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------- live status strip

function LiveStrip({ rollups }: { rollups: RollupFeed[] }) {
  const pool = usePool();
  const events = useEvents();
  const latest = rollups.map((r) => r.updatedAt).sort().at(-1);
  const stale = latest ? Date.now() - new Date(latest).getTime() > 20 * 60_000 : false;
  const batches = rollups.flatMap((r) => r.batches);
  const matching = batches.filter((b) => b.verdict === "match").length;
  // watchers that attested on the live pool in the last 24 hours
  const dayAgo = Date.now() / 1000 - 86_400;
  const signing = events.data
    ? new Set(
        events.data.events
          .filter((e) => e.name === "Attested" && e.address.toLowerCase() === CONTRACTS.pool.toLowerCase() && (events.data!.blockTimes[String(e.block)] ?? 0) > dayAgo)
          .map((e) => String(e.args.watcher).toLowerCase()),
      ).size
    : undefined;

  return (
    <div className="strip-live" role="status" aria-label="Live status">
      <div>
        <div className="eyebrow">QoreChain testnet</div>
        <div className="v">{pool.data ? <>#{pool.data.block.toLocaleString()}</> : "…"}<small>EVM block</small></div>
      </div>
      <div>
        <div className="eyebrow">Watcher feed</div>
        <div className={`v ${latest ? (stale ? "warn" : "ok") : ""}`}>{latest ? ago(latest) : "…"}</div>
      </div>
      <div>
        <div className="eyebrow">Watchers signing</div>
        <div className="v">{signing ?? "…"}<small>in the last 24 h</small></div>
      </div>
      <div>
        <div className="eyebrow">Batches verified</div>
        <div className="v">{batches.length ? <>{matching}<small>/ {batches.length} match</small></> : "…"}</div>
      </div>
      <div>
        <div className="eyebrow">Ready to pay out</div>
        <div className="v">{pool.data ? <>{qorFromWei(pool.data.idleLiquidity, 0)}<small>QOR idle</small></> : "…"}</div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- lead finding

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
    <div className="card lead">
      <div className="row" style={{ gap: 8, marginBottom: 6 }}>
        <Pill tone="ok">Caught live</Pill>
        <span className="small muted">21 Nov 2026 · a rollup we do not run</span>
      </div>
      <h2 style={{ marginBottom: 6 }}>A wrong batch on LedgerPump&apos;s rollup was challenged 12 seconds after it was posted</h2>
      <p className="small" style={{ margin: 0, maxWidth: 900 }}>
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

// ------------------------------------------------------------- rollups, as a dense table

function RollupTable({ rollups }: { rollups: RollupFeed[] }) {
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

function RecentBatches({ rollups }: { rollups: RollupFeed[] }) {
  const router = useRouter();
  const rows: { rollupId: string; b: Batch }[] = rollups
    .flatMap((r) => r.batches.map((b) => ({ rollupId: r.rollupId, b })))
    .sort((x, y) => y.b.submittedTime - x.b.submittedTime)
    .slice(0, 8);
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Batch</th>
            <th>When</th>
            <th className="num">Out</th>
            <th>Verdict</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ rollupId, b }) => {
            const total = (b.withdrawals ?? []).reduce((s, w) => s + Number(w.amountUqor), 0);
            const to = `/r/${rollupId}/${b.index}`;
            return (
              <tr key={`${rollupId}-${b.index}`} className="link" onClick={() => router.push(to)}>
                <td><Link href={to} onClick={(e) => e.stopPropagation()} className="mono">{rollupId}</Link> <span className="muted">#{b.index}</span></td>
                <td className="muted" title={dateTime(b.submittedTime * 1000)}>{ago(b.submittedTime * 1000)}</td>
                <td className="num">{b.withdrawals?.length ? `${qorFromUqor(total)} QOR` : <span className="faint">–</span>}</td>
                <td><BatchPill state={batchState(b)} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

