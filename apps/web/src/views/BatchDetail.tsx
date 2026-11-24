"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { batchState } from "../lib/feed";
import { useOnChainBatch, useRollup } from "../lib/queries";
import { dateTime, ago, qorFromUqor, qorFromWei } from "../lib/format";
import { BatchPill, ErrorBox, Hash, Loading, Pill, WatcherRef } from "../components/ui";

const ZERO = /^0x0*$/;

export function BatchDetail() {
  const { rollupId, index } = useParams<{ rollupId: string; index: string }>();
  const i = Number(index);
  const { data: r, error, isLoading } = useRollup(rollupId);
  const chain = useOnChainBatch(rollupId, Number.isInteger(i) ? i : undefined);

  const crumbs = (
    <div className="crumbs">
      <Link href="/r">Rollups</Link> / <Link href={`/r/${rollupId}`} className="mono">{rollupId}</Link> / batch {index}
    </div>
  );
  if (error) return <>{crumbs}<ErrorBox error={error} /></>;
  if (isLoading || !r) return <>{crumbs}<Loading lines={6} /></>;
  const b = r.batches.find((x) => x.index === i);
  if (!b) return <>{crumbs}<div className="card empty">Batch {index} is not in the feed yet.</div></>;

  const state = batchState(b);
  const prev = r.batches.find((x) => x.index === i - 1);
  const next = r.batches.find((x) => x.index === i + 1);
  const c = chain.data;
  const onChainConfirmed = c && c.confirmedAt > 0n;

  return (
    <>
      {crumbs}
      <div className="page-head under-crumbs">
        <div className="row">
          <h1>Batch {b.index}</h1>
          <BatchPill state={state} />
          <span className="spacer" />
          {prev && <Link className="small" href={`/r/${rollupId}/${prev.index}`}>← {prev.index}</Link>}
          {next && <Link className="small" href={`/r/${rollupId}/${next.index}`}>{next.index} →</Link>}
        </div>
        <p>
          Submitted {dateTime(b.submittedTime * 1000)} ({ago(b.submittedTime * 1000)}), covering inbox posts {b.inboxStart} to {b.inboxEnd}.
        </p>
      </div>

      {b.verdict !== "match" ? (
        <div className="banner bad">
          <div>
            <strong>The watcher's re-execution does not match what was submitted</strong>
            <span className="small">
              {b.reason ?? "Roots differ."}{" "}
              {b.challengeTx ? <>Fraud proof: <Hash value={b.challengeTx} tx /></> : "No fraud proof was landed for it in the feed."} The pool never
              advances against a batch the watchers did not confirm.
            </span>
          </div>
        </div>
      ) : (
        <div className="banner ok">
          <div>
            <strong>Re-executed independently: state and withdrawals roots match</strong>
            <span className="small">The watcher rebuilt this batch from main-chain inbox data and ran it with the RDK's qledger-v1 executor.</span>
          </div>
        </div>
      )}

      <div className="section grid two">
        <div className="card">
          <h3>What was submitted</h3>
          <dl className="kv">
            <dt>State root</dt><dd><Hash value={b.stateRoot} /></dd>
            <dt>Withdrawals root</dt><dd>{ZERO.test(b.withdrawalsRoot) || b.withdrawalsRoot === "0x" ? <span className="faint">empty</span> : <Hash value={b.withdrawalsRoot} />}</dd>
            {b.exitRoot && <><dt>Exit root</dt><dd><Hash value={b.exitRoot} /></dd></>}
            {b.submission && (
              <>
                <dt>Transaction</dt><dd><Hash value={b.submission.tx} tx /></dd>
                <dt>Height</dt><dd>{b.submission.height.toLocaleString()}</dd>
                <dt>Submitter</dt><dd><Hash value={b.submission.signer} /></dd>
                <dt>Signature</dt>
                <dd>{b.submission.pqVerified ? <Pill tone="ok">ML-DSA-87 layer verified</Pill> : <Pill tone="warn">{b.submission.tier}</Pill>}</dd>
              </>
            )}
            {b.replacedSubmissions?.length ? <><dt>Replaced</dt><dd>{b.replacedSubmissions.length} earlier submission(s) kept</dd></> : null}
          </dl>
        </div>

        <div className="card">
          <div className="row" style={{ marginBottom: 10 }}>
            <h3 style={{ margin: 0 }}>Exit pool</h3>
            <span className="spacer" />
            <span className="small faint">{chain.isFetching ? "reading chain…" : c ? "live from ExitPool" : ""}</span>
          </div>
          {chain.error ? (
            <div className="small" style={{ color: "var(--bad)" }}>Could not read ExitPool: {(chain.error as Error).message}</div>
          ) : !c ? (
            <div className="skeleton" style={{ width: "70%" }} />
          ) : !onChainConfirmed ? (
            <p className="muted small" style={{ margin: 0 }}>
              Not confirmed in the pool, so no instant exit can be paid against this batch.
              {!r.lane && " This rollup has no exit lane."}
            </p>
          ) : (
            <dl className="kv">
              <dt>Confirmed</dt><dd>{dateTime(Number(c.confirmedAt) * 1000)}</dd>
              <dt>Status</dt>
              <dd className="row" style={{ gap: 6 }}>
                {c.contested ? <Pill tone="bad">contested</Pill> : <Pill tone="ok">agreed</Pill>}
                {c.released ? <Pill tone="muted">stake released</Pill> : <Pill tone="info">stake locked</Pill>}
              </dd>
              <dt>Stake behind it</dt><dd>{qorFromWei(c.coverWei)} QOR cover · {qorFromWei(c.advancedWei)} QOR advanced</dd>
              <dt>Open advances</dt><dd>{c.openAdvances}</dd>
              <dt>Facts hash</dt><dd><Hash value={c.factsHash} /></dd>
              <dt>Watchers</dt>
              <dd>
                {c.watchers.map((w, k) => (
                  <div key={w}>
                    <WatcherRef address={w} />
                    {c.lockedAmt[k] !== undefined && c.lockedAmt[k] > 0n && <span className="small muted"> · {qorFromWei(c.lockedAmt[k])} QOR locked</span>}
                  </div>
                ))}
              </dd>
            </dl>
          )}
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <h2>Withdrawals</h2>
          <p>{b.withdrawals?.length ?? 0} in this batch</p>
        </div>
        {!b.withdrawals?.length ? (
          <div className="card empty">No withdrawals in this batch.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>Recipient (exit address)</th>
                  <th>EVM form</th>
                  <th className="num">Amount</th>
                  <th className="num">Proof</th>
                </tr>
              </thead>
              <tbody>
                {b.withdrawals.map((w) => (
                  <tr key={w.index}>
                    <td className="num">{w.index}</td>
                    <td><Hash value={w.recipient} /></td>
                    <td>
                      <Hash value={w.recipientEvm} /> <Link href={`/track/${w.recipientEvm}`} className="small">track</Link>
                    </td>
                    <td className="num">{qorFromUqor(w.amountUqor)} QOR</td>
                    <td className="num muted">{w.exitProof.length ? `${w.exitProof.length} nodes` : "single leaf"}</td>
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
