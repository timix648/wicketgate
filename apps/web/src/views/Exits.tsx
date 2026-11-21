"use client";

import Link from "next/link";
import { useBatchKeyMap, useEvents, useMetrics } from "../lib/queries";
import { deriveExits, type LiveExit } from "../lib/events";
import { POOLS } from "../lib/config";
import { ago, dateTime, duration, num, qorFromWei } from "../lib/format";
import { ErrorBox, Hash, Loading, Pill, Stat } from "../components/ui";

const median = (xs: number[]) => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

export function ExitStatusPill({ x }: { x: LiveExit }) {
  if (x.status === "settled") return <Pill tone="ok" title={x.closedTime && x.time ? `${duration(x.closedTime - x.time)} after the advance` : undefined}>repaid</Pill>;
  if (x.status === "recovered") return <Pill tone="ok">recovered late</Pill>;
  if (x.status === "defaulted") return <Pill tone="bad">defaulted, watchers slashed</Pill>;
  const overdue = Date.now() / 1000 > Number(x.dueBy);
  return overdue ? <Pill tone="bad">overdue</Pill> : <Pill tone="warn" title={`Due by ${dateTime(Number(x.dueBy) * 1000)}`}>awaiting repayment</Pill>;
}

export function Exits() {
  const events = useEvents();
  const metrics = useMetrics();
  const keys = useBatchKeyMap();

  const exits = events.data ? deriveExits(events.data) : [];
  const toMoney = (x: LiveExit) => {
    const b = keys.get(x.batchKey.toLowerCase());
    return b && x.time ? x.time - b.submittedTime : undefined;
  };
  const speeds = exits.map(toMoney).filter((s): s is number => s !== undefined);
  const paid = exits.reduce((s, x) => s + x.amountWei, 0n);
  const fees = exits.reduce((s, x) => s + x.feeWei, 0n);
  const repaid = exits.filter((x) => x.status === "settled" || x.status === "recovered").length;
  const open = exits.filter((x) => x.status === "open").length;
  const defaulted = exits.filter((x) => x.status === "defaulted").length;
  const med = median(speeds);
  const window = 3600;
  const scanned = new Set(POOLS.map((p) => p.version));
  const earlier = (metrics.data?.exits ?? []).filter((e) => !scanned.has(e.pool));

  return (
    <>
      <div className="page-head">
        <h1>Instant exits</h1>
        <p>
          Each exit was paid by the pool before its batch finalised, against a batch two watchers had re-executed and attested. When the batch
          finalises, the chain pays the withdrawal to the exit address and the pool sweeps it back. Read live from ExitPool events.
        </p>
      </div>

      {events.error ? (
        <ErrorBox error={events.error} />
      ) : !events.data ? (
        <Loading lines={4} />
      ) : (
        <>
          <div className="grid stats">
            <Stat label="Instant exits"  value={exits.length} sub={`${qorFromWei(paid, 2)} QOR advanced, pools ${POOLS.map((p) => `v${p.version}`).join(" and ")}`} />
            <Stat label="Median, batch to money" value={med !== undefined ? num(med, 0) : "–"} unit="s" sub={`against a ${duration(window)} challenge window`} />
            <Stat label="Repaid by the chain" value={`${repaid}/${exits.length}`} sub={`${open} awaiting repayment, ${defaulted} defaulted`} />
            <Stat label="Fees earned" value={qorFromWei(fees, 3)} unit="QOR" sub="70% liquidity providers, 30% watchers" />
          </div>

          <div className="section">
            <div className="section-head">
              <h2>Every exit</h2>
              <p>Scanned to block {events.data.toBlock.toLocaleString()}</p>
            </div>
            {exits.length === 0 ? (
              <div className="card empty">No instant exits from this pool yet.</div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Paid</th>
                      <th>Rollup / batch</th>
                      <th>Beneficiary</th>
                      <th className="num">Amount</th>
                      <th>Batch to money</th>
                      <th>Repayment</th>
                      <th>Exit transaction</th>
                      <th>Pool</th>
                    </tr>
                  </thead>
                  <tbody>
                    {exits.map((x) => {
                      const b = keys.get(x.batchKey.toLowerCase());
                      const s = toMoney(x);
                      return (
                        <tr key={`${x.pool}-${x.id}`}>
                          <td title={x.time ? dateTime(x.time * 1000) : undefined}>{x.time ? ago(x.time * 1000) : "–"}</td>
                          <td>
                            {b ? (
                              <>
                                <Link href={`/r/${b.rollupId}/${b.index}`} className="mono">{b.rollupId}</Link>
                                <span className="muted"> #{b.index}</span>
                              </>
                            ) : (
                              <Hash value={x.batchKey} />
                            )}
                          </td>
                          <td><Link href={`/track/${x.beneficiary}`} className="hash">{x.beneficiary.slice(0, 8)}…{x.beneficiary.slice(-4)}</Link></td>
                          <td className="num" title={`${qorFromWei(x.amountWei - x.feeWei, 4)} QOR paid after the ${qorFromWei(x.feeWei, 4)} QOR fee`}>{qorFromWei(x.amountWei, 3)} QOR</td>
                          <td>
                            {s !== undefined ? (
                              <div className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
                                <div className="bar"><span style={{ width: `${Math.max(1, Math.min(100, (s / window) * 100))}%` }} /></div>
                                <span className="small" style={{ minWidth: 48 }}>{duration(s)}</span>
                              </div>
                            ) : <span className="faint">–</span>}
                          </td>
                          <td><ExitStatusPill x={x} /></td>
                          <td><Hash value={x.tx} /></td>
                          <td className="muted">v{x.pool}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p className="small muted">
              Amount is the withdrawal; the beneficiary received it minus the 0.3% fee (hover for the exact payout). EVM transaction hashes cannot be looked up on
              explore.qore.network; read them with <code>eth_getTransactionReceipt</code> on the testnet EVM RPC.
            </p>
          </div>
        </>
      )}

      {earlier.length > 0 && (
        <details className="section card">
          <summary><strong>{earlier.length} exits from earlier pool versions</strong> <span className="muted small">(from docs/metrics.json)</span></summary>
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table>
              <thead>
                <tr><th>Pool</th><th>Rollup / batch</th><th className="num">Amount</th><th className="num">Batch to money</th><th>Repaid</th><th>Exit transaction</th></tr>
              </thead>
              <tbody>
                {earlier.map((e) => (
                  <tr key={e.exitTx}>
                    <td>v{e.pool}</td>
                    <td><span className="mono">{e.rollupId}</span><span className="muted"> #{e.batchIndex}</span></td>
                    <td className="num">{num(e.amountQor, 3)} QOR</td>
                    <td className="num">{e.secondsAfterBatchPosted !== undefined ? duration(e.secondsAfterBatchPosted) : "–"}</td>
                    <td>{e.repaid ? <Pill tone="ok">repaid</Pill> : <Pill tone="warn">open</Pill>}</td>
                    <td><Hash value={e.exitTx} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </>
  );
}
