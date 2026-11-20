import { Link, useNavigate, useParams } from "react-router-dom";
import { batchState } from "../lib/feed";
import { useAllRollups, useRollup } from "../lib/queries";
import { LANES } from "../lib/config";
import { ago, dateTime, duration, qorFromUqor } from "../lib/format";
import { BatchPill, ErrorBox, Hash, Loading, Pill, Stat } from "../components/ui";
import { BatchStrip, StripLegend } from "../components/BatchStrip";

export function RollupList() {
  const nav = useNavigate();
  const { rollups, isLoading, error } = useAllRollups();
  return (
    <>
      <div className="page-head">
        <h1>Rollups</h1>
        <p>
          Every <code>qledger-v1</code> rollup on the chain, found by the watcher without being told about it and rebuilt from main-chain data
          alone. A rollup with an exit lane can be left through the pool in seconds.
        </p>
      </div>
      {error ? (
        <ErrorBox error={error} />
      ) : isLoading && !rollups.length ? (
        <Loading />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Rollup</th>
                <th>Batches</th>
                <th className="num">Count</th>
                <th>Verdicts</th>
                <th>Exit lane</th>
                <th>Latest batch</th>
              </tr>
            </thead>
            <tbody>
              {rollups.map((r) => {
                const bad = r.batches.filter((b) => b.verdict !== "match").length;
                const last = r.batches.at(-1);
                return (
                  <tr key={r.rollupId} className="link" onClick={() => nav(`/rollups/${r.rollupId}`)}>
                    <td className="mono"><Link to={`/rollups/${r.rollupId}`}>{r.rollupId}</Link></td>
                    <td style={{ whiteSpace: "normal", minWidth: 200 }}><BatchStrip rollup={r} linked={false} /></td>
                    <td className="num">{r.batches.length}</td>
                    <td>{bad ? <Pill tone="bad">{bad} mismatch</Pill> : <Pill tone="ok">all match</Pill>}</td>
                    <td>{LANES[r.rollupId]?.enabled ? <Pill tone="info">open</Pill> : <span className="faint">none</span>}</td>
                    <td>{last ? ago(last.submittedTime * 1000) : "–"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function RollupDetail() {
  const { rollupId } = useParams();
  const nav = useNavigate();
  const { data: r, error, isLoading } = useRollup(rollupId);

  if (error) return <><Crumbs id={rollupId} /><ErrorBox error={error} /></>;
  if (isLoading || !r) return <><Crumbs id={rollupId} /><Loading lines={5} /></>;

  const withdrawals = r.batches.flatMap((b) => b.withdrawals ?? []);
  const totalOut = withdrawals.reduce((s, w) => s + Number(w.amountUqor), 0);
  const confirmed = r.batches.filter((b) => b.pool?.confirmed).length;
  const bad = r.batches.filter((b) => b.verdict !== "match");
  const pending = r.inbox.head - r.inbox.consumed;

  return (
    <>
      <Crumbs id={rollupId} />
      <div className="page-head" style={{ paddingTop: 8 }}>
        <div className="row">
          <h1 className="mono" style={{ fontSize: 24 }}>{r.rollupId}</h1>
          {r.lane?.enabled ? <Pill tone="info">Exit lane open</Pill> : <Pill tone="muted">Watched only</Pill>}
        </div>
        <p>
          Rollup key <Hash value={r.rollupKey} /> · feed updated {ago(r.updatedAt)} by a watcher in <code>{r.mode}</code> mode
        </p>
      </div>

      {bad.length > 0 && (
        <div className="banner bad" style={{ marginBottom: 16 }}>
          <div>
            <strong>{bad.length === 1 ? "One batch does not match its re-execution" : `${bad.length} batches do not match their re-execution`}</strong>
            <span className="small">
              {bad.map((b, i) => (
                <span key={b.index}>
                  {i > 0 && ", "}
                  <Link to={`/rollups/${r.rollupId}/batches/${b.index}`}>batch {b.index}</Link>
                  {b.reason && <> ({b.reason})</>}
                </span>
              ))}
              . The pool never advances against a batch the watchers did not confirm.
            </span>
          </div>
        </div>
      )}

      <div className="grid stats">
        <Stat label="Batches" value={r.batches.length} sub={<>{r.batches.length - bad.length} match their re-execution</>} />
        <Stat label="Confirmed for the pool" value={confirmed} sub={r.lane ? `quorum of ${r.lane.quorum} watchers` : "no exit lane"} />
        <Stat label="Withdrawals" value={withdrawals.length} sub={`${qorFromUqor(totalOut)} QOR in total`} />
        <Stat label="Inbox" value={r.inbox.consumed} unit={`/ ${r.inbox.head}`} sub={pending ? `${pending} posts waiting to be batched` : "nothing waiting"} />
      </div>

      {r.lane && (
        <div className="section card">
          <h3>Exit lane terms</h3>
          <dl className="kv">
            <dt>Challenge window</dt><dd>{duration(r.lane.windowSecs)} plus {duration(r.lane.graceSecs)} grace</dd>
            <dt>Fee</dt><dd>{r.lane.feeBps / 100}% of each exit (70% to liquidity providers, 30% to the confirming watchers)</dd>
            <dt>Watchers to confirm</dt><dd>{r.lane.quorum}; one dissenting watcher freezes payouts on that batch</dd>
            <dt>Stake locked per watcher</dt><dd>up to {r.lane.lockPerWatcherQor} QOR per batch, which caps what the pool will advance</dd>
          </dl>
        </div>
      )}

      <div className="section">
        <div className="section-head">
          <h2>Batches</h2>
          <StripLegend />
        </div>
        <div className="card" style={{ marginBottom: 12 }}>
          <BatchStrip rollup={r} />
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Submitted</th>
                <th>Inbox</th>
                <th className="num">Withdrawals</th>
                <th>Verdict</th>
                <th>Signature</th>
                <th>Pool</th>
              </tr>
            </thead>
            <tbody>
              {[...r.batches].reverse().map((b) => {
                const to = `/rollups/${r.rollupId}/batches/${b.index}`;
                const total = (b.withdrawals ?? []).reduce((s, w) => s + Number(w.amountUqor), 0);
                return (
                  <tr key={b.index} className="link" onClick={() => nav(to)}>
                    <td className="num"><Link to={to} onClick={(e) => e.stopPropagation()}>{b.index}</Link></td>
                    <td title={ago(b.submittedTime * 1000)}>{dateTime(b.submittedTime * 1000)}</td>
                    <td className="muted">{b.inboxStart}–{b.inboxEnd}</td>
                    <td className="num">{b.withdrawals?.length ? `${b.withdrawals.length} · ${qorFromUqor(total)} QOR` : <span className="faint">0</span>}</td>
                    <td><BatchPill state={batchState(b)} /></td>
                    <td>{b.submission?.pqVerified ? <Pill tone="ok">ML-DSA-87</Pill> : <Pill tone="muted">{b.submission?.tier ?? "unknown"}</Pill>}</td>
                    <td>
                      {b.pool?.contested ? <Pill tone="bad">contested</Pill> : b.pool?.confirmed ? `${b.pool.watchers.length} watchers · ${b.pool.coverQor} QOR cover` : <span className="faint">–</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function Crumbs({ id }: { id?: string }) {
  return (
    <div className="crumbs" style={{ paddingTop: 24 }}>
      <Link to="/rollups">Rollups</Link> / <span className="mono">{id}</span>
    </div>
  );
}
