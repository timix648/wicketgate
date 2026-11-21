"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { keccak256, toHex } from "viem";
import { eventTime, type ChainEvent } from "../lib/events";
import { useAllRollups, useBatchKeyMap, useEvents } from "../lib/queries";
import { ago, dateTime, qorFromWei } from "../lib/format";
import { ErrorBox, Hash, Loading, WatcherRef } from "./ui";

/** The latest pool and registry events, in plain words. */
export function Activity({ limit = 12 }: { limit?: number }) {
  const events = useEvents();
  const keys = useBatchKeyMap();
  const { rollups } = useAllRollups();
  const rollupOf = new Map(rollups.map((r) => [keccak256(toHex(r.rollupId)).toLowerCase(), r.rollupId]));

  if (events.error) return <ErrorBox error={events.error} />;
  if (!events.data) return <Loading lines={4} />;

  const batchLink = (rollupKey: string, index: bigint | number) => {
    const id = rollupOf.get(String(rollupKey).toLowerCase());
    return id ? <Link href={`/r/${id}/${index}`}><span className="mono">{id}</span> batch {String(index)}</Link> : <>batch {String(index)}</>;
  };
  const byKey = (batchKey: string) => {
    const b = keys.get(String(batchKey).toLowerCase());
    return b ? <Link href={`/r/${b.rollupId}/${b.index}`}><span className="mono">{b.rollupId}</span> batch {b.index}</Link> : <>a batch</>;
  };

  const describe = (e: ChainEvent): ReactNode | undefined => {
    const a = e.args;
    switch (e.name) {
      case "Attested": return <><WatcherRef address={a.watcher} /> attested {batchLink(a.rollupKey, a.batchIndex)} with ML-DSA-87</>;
      case "BatchConfirmed":
        return a.coverWei > 0n
          ? <>{batchLink(a.rollupKey, a.batchIndex)} confirmed, {qorFromWei(a.coverWei)} QOR of stake behind it</>
          : <>{batchLink(a.rollupKey, a.batchIndex)} confirmed by the watchers; instant exits open (their stake locks as each exit is paid)</>;
      case "BatchContestedEvt": return <><strong style={{ color: "var(--bad)" }}>Contested:</strong> <WatcherRef address={a.watcher} /> disagreed on {batchLink(a.rollupKey, a.batchIndex)}; payouts frozen</>;
      case "InstantExit": return <>Instant exit of <strong>{qorFromWei(a.amountWei)} QOR</strong> paid from {byKey(a.batchKey)} to <Link href={`/track/${a.beneficiary}`} className="hash">{String(a.beneficiary).slice(0, 8)}…</Link></>;
      case "Settled": return <>The chain repaid an advance of {qorFromWei(a.receivedWei)} QOR to the pool</>;
      case "Recovered": return <>A defaulted advance was recovered ({qorFromWei(a.receivedWei)} QOR); watchers refunded</>;
      case "Defaulted": return <><strong style={{ color: "var(--bad)" }}>Default:</strong> {qorFromWei(a.slashedWei)} QOR taken from the confirming watchers' stake</>;
      case "Deposited": return <>A liquidity provider deposited {qorFromWei(a.amount)} QOR</>;
      case "Withdrawn": return <>A liquidity provider withdrew {qorFromWei(a.amount)} QOR</>;
      case "Joined": return <><WatcherRef address={a.watcher} /> joined as a watcher with {qorFromWei(a.stake)} QOR</>;
      case "LeaveRequested": return <><WatcherRef address={a.watcher} /> asked to leave</>;
      case "Left": return <><WatcherRef address={a.watcher} /> left; {qorFromWei(a.returned)} QOR returned</>;
      case "Slashed": return <><strong style={{ color: "var(--bad)" }}>Slashed:</strong> <WatcherRef address={a.watcher} /> lost {qorFromWei(a.amount)} QOR</>;
      default: return undefined; // admin, lock/unlock and bookkeeping events
    }
  };

  const rows = [...events.data.events].reverse().map((e) => ({ e, text: describe(e) })).filter((r) => r.text).slice(0, limit);
  if (!rows.length) return <div className="card empty">No pool activity yet.</div>;

  return (
    <div className="card">
      <ul className="activity">
        {rows.map(({ e, text }) => {
          const t = eventTime(events.data!, e);
          return (
            <li key={`${e.tx}-${e.logIndex}`}>
              <span className="when" title={t ? dateTime(t * 1000) : undefined}>{t ? ago(t * 1000) : `#${e.block}`}</span>
              <span>{text} <span className="faint small">· <Hash value={e.tx} /></span></span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
