"use client";

import { useEffect, useMemo, useState } from "react";
import { getAddress } from "viem";
import Link from "next/link";
import { useAllRollups, useEvents, usePool, useWatchers } from "../lib/queries";
import { deriveWatcherAddresses } from "../lib/events";
import { KNOWN_WATCHERS, REPO_URL } from "../lib/config";
import { duration, qorFromWei } from "../lib/format";
import { ErrorBox, Hash, Loading, Pill, Stat } from "../components/ui";

export function Watchers() {
  const { rollups } = useAllRollups();
  const pool = usePool();
  const events = useEvents();
  const [hash, setHash] = useState("");
  useEffect(() => {
    const read = () => setHash(window.location.hash.toLowerCase());
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  // Everyone who ever joined the registry (from its events), anyone who confirmed a batch in the
  // feed, and the team's known accounts. Attestations are counted from the pool's events.
  const { addresses, attests } = useMemo(() => {
    const attests = new Map<string, number>();
    for (const e of events.data?.events ?? []) if (e.name === "Attested") attests.set(String(e.args.watcher).toLowerCase(), (attests.get(String(e.args.watcher).toLowerCase()) ?? 0) + 1);
    const fromFeed = rollups.flatMap((r) => r.batches.flatMap((b) => b.pool?.watchers ?? [])).map((w) => w.toLowerCase());
    const joined = events.data ? deriveWatcherAddresses(events.data) : [];
    const set = new Set([...Object.keys(KNOWN_WATCHERS), ...joined, ...fromFeed]);
    return { addresses: [...set], attests };
  }, [rollups, events.data]);

  const results = useWatchers(addresses);
  const loaded = results.map((q) => q.data).filter((d) => !!d);
  const totalStake = loaded.reduce((s, w) => s + w.stake, 0n);
  const totalLocked = loaded.reduce((s, w) => s + w.locked, 0n);
  const active = loaded.filter((w) => w.active).length;

  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ block: "center" });
  }, [hash, loaded.length]);

  return (
    <>
      <div className="page-head">
        <h1>Watchers</h1>
        <p>
          A watcher re-executes every batch and, when the roots match, signs an attestation with its ML-DSA-87 key. Its stake backs what it
          signs: if the pool advances against a batch that never pays out, the confirming watchers' locked stake repays it. Anyone can run one,
          see <a href={`${REPO_URL}/blob/main/docs/WATCHERS.md`} target="_blank" rel="noreferrer">docs/WATCHERS.md</a>.
        </p>
      </div>

      <div className="grid stats">
        <Stat label="Registered watchers" value={active} sub={`of ${addresses.length} addresses seen`} />
        <Stat label="Total stake" value={qorFromWei(totalStake, 2)} unit="QOR" />
        <Stat label="Locked behind open exits" value={qorFromWei(totalLocked, 2)} unit="QOR" />
        <Stat
          label="To join"
          value={pool.data ? qorFromWei(pool.data.minStake, 2) : "…"}
          unit="QOR min."
          sub={pool.data ? `leaving waits ${duration(Number(pool.data.leaveDelay))}` : undefined}
        />
      </div>

      <div className="section table-wrap">
        <table>
          <thead>
            <tr>
              <th>Watcher</th>
              <th>Address</th>
              <th>Status</th>
              <th className="num">Stake</th>
              <th>Locked</th>
              <th className="num">Fees earned</th>
              <th className="num" title="ML-DSA-87 attestations accepted by the current pool">Attestations</th>
            </tr>
          </thead>
          <tbody>
            {addresses.map((a, k) => {
              const q = results[k];
              const w = q?.data;
              const known = KNOWN_WATCHERS[a];
              const lockedPct = w && w.stake > 0n ? Number((w.locked * 10000n) / w.stake) / 100 : 0;
              return (
                <tr key={a} id={a} style={hash === `#${a}` ? { outline: "2px solid var(--accent)", outlineOffset: -2 } : undefined}>
                  <td>
                    <strong>{known?.name ?? "Independent"}</strong>
                    {known && <div className="small muted">{known.note}</div>}
                  </td>
                  <td><Hash value={getAddress(a)} /></td>
                  <td>
                    {q?.error ? <Pill tone="bad">read failed</Pill> : !w ? <span className="skeleton" style={{ display: "inline-block", width: 60 }} /> : w.active ? <Pill tone="ok">active</Pill> : w.leaveAfter > 0n ? <Pill tone="warn">leaving</Pill> : <Pill tone="muted">not registered</Pill>}
                  </td>
                  <td className="num">{w ? `${qorFromWei(w.stake, 2)} QOR` : ""}</td>
                  <td>
                    {w && (
                      <div className="row" style={{ gap: 8 }}>
                        <div className="bar" style={{ minWidth: 80 }}><span style={{ width: `${lockedPct}%` }} /></div>
                        <span className="small muted">{qorFromWei(w.locked, 2)}</span>
                      </div>
                    )}
                  </td>
                  <td className="num">{w ? `${qorFromWei(w.credit, 4)} QOR` : ""}</td>
                  <td className="num">{events.data ? attests.get(a) ?? 0 : "…"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {results.some((q) => q.error) && <div className="section"><ErrorBox error={results.find((q) => q.error)!.error} /></div>}
      {!rollups.length && <div className="section"><Loading lines={1} /></div>}

      <div className="section card">
        <h3>Why post-quantum keys matter here</h3>
        <p className="small muted" style={{ margin: 0 }}>
          ExitPool checks every attestation with the chain's ML-DSA-87 precompile and has no classical signature check at all. In the{" "}
          <a href={`${REPO_URL}/blob/main/docs/QDAY.md`} target="_blank" rel="noreferrer">Q-Day simulation</a>, watcher W4's classical key was
          cracked in 49 seconds: an <code>ecrecover</code> twin of the pool was drained, and Wicketgate refused the same key with{" "}
          <code>BadSignature</code>. See the <Link href="/exits">instant exits</Link> those attestations paid for.
        </p>
      </div>
    </>
  );
}
