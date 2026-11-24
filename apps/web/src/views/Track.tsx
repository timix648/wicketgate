"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { parseAddress } from "../lib/address";
import { client } from "../lib/chain";
import { deriveExits, type LiveExit } from "../lib/events";
import { batchState, type Batch, type RollupFeed, type Withdrawal } from "../lib/feed";
import { useAllRollups, useEvents } from "../lib/queries";
import { ago, dateTime, duration, qorFromUqor, qorFromWei } from "../lib/format";
import { ErrorBox, Hash, Loading, Pill } from "../components/ui";
import { ExitStatusPill } from "./Exits";

interface Found {
  rollup: RollupFeed;
  batch: Batch;
  withdrawal: Withdrawal;
  exit?: LiveExit;
}

export function Track() {
  const params = useParams<{ address?: string }>();
  const param = params?.address ? decodeURIComponent(params.address) : undefined;
  const router = useRouter();
  const [input, setInput] = useState(param ?? "");
  useEffect(() => setInput(param ?? ""), [param]);
  const address = param ? parseAddress(param) : undefined;

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Exits</div>
        <h1>Track an exit</h1>
        <p>
          Paste the address that receives the money (the beneficiary) or an exit address, as <code>0x…</code> or <code>qor1…</code>. You will see every
          withdrawal and instant exit linked to it, and where each one is now.
        </p>
      </div>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          const a = parseAddress(input);
          if (a) router.push(`/track/${a}`);
        }}
      >
        <input
          className="input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="0x… or qor1…"
          spellCheck={false}
          aria-label="Address"
        />
        <button className="btn" type="submit" disabled={!parseAddress(input)}>Track</button>
      </form>
      {input && !parseAddress(input) && <p className="small" style={{ color: "var(--bad)" }}>That is not a valid 0x or qor1 address.</p>}
      {param && !address && <div className="section card error-box">“{param}” is not a valid address.</div>}
      {address && <Results address={address} />}
    </>
  );
}

function Results({ address }: { address: Address }) {
  const { rollups, isLoading: feedLoading, error: feedError } = useAllRollups();
  const events = useEvents();
  const balance = useQuery({ queryKey: ["balance", address], queryFn: () => client.getBalance({ address }), refetchInterval: 30_000 });
  const a = address.toLowerCase();

  if (feedError) return <div className="section"><ErrorBox error={feedError} /></div>;
  if (events.error) return <div className="section"><ErrorBox error={events.error} /></div>;
  if ((feedLoading && !rollups.length) || !events.data) return <div className="section"><Loading lines={4} /></div>;

  const exits = deriveExits(events.data);
  const byExitAddr = new Map(exits.map((x) => [x.exitAddr.toLowerCase(), x]));

  // Withdrawals in the feed that pay this address (it is an exit address), or that pay an
  // exit address whose advance went to this beneficiary.
  const asBeneficiary = new Set(exits.filter((x) => x.beneficiary.toLowerCase() === a).map((x) => x.exitAddr.toLowerCase()));
  const found: Found[] = [];
  for (const r of rollups)
    for (const b of r.batches)
      for (const w of b.withdrawals ?? []) {
        const to = w.recipientEvm.toLowerCase();
        if (to === a || asBeneficiary.has(to)) found.push({ rollup: r, batch: b, withdrawal: w, exit: byExitAddr.get(to) });
      }
  // Exits whose batch is not (or no longer) in the feed still show up.
  const shown = new Set(found.map((f) => f.exit?.id).filter(Boolean));
  const orphans = exits.filter((x) => !shown.has(x.id) && (x.beneficiary.toLowerCase() === a || x.exitAddr.toLowerCase() === a));

  return (
    <div className="section">
      <div className="card" style={{ marginBottom: 12 }}>
        <dl className="kv">
          <dt>Address</dt><dd><Hash value={address} full /></dd>
          <dt>Balance</dt><dd>{balance.data !== undefined ? `${qorFromWei(balance.data)} QOR` : balance.error ? "unreadable" : "…"}</dd>
          <dt>Found</dt>
          <dd>
            {found.length + orphans.length === 0
              ? "Nothing yet"
              : `${found.length} withdrawal${found.length === 1 ? "" : "s"}${orphans.length ? `, ${orphans.length} other exit${orphans.length === 1 ? "" : "s"}` : ""}`}
          </dd>
        </dl>
      </div>

      {found.length + orphans.length === 0 && (
        <div className="card empty">
          No withdrawal to this address is in a batch yet, and it has received no instant exit. A withdrawal that was just posted shows up here once a
          submitter batches it and the watcher feed refreshes (every 5 minutes).
        </div>
      )}

      <div className="grid" style={{ gap: 12 }}>
        {found
          .sort((x, y) => y.batch.submittedTime - x.batch.submittedTime)
          .map((f) => (
            <Timeline key={`${f.rollup.rollupId}-${f.batch.index}-${f.withdrawal.index}`} f={f} />
          ))}
        {orphans.map((x) => (
          <div className="card" key={x.id}>
            <div className="row"><strong>Instant exit of {qorFromWei(x.amountWei)} QOR</strong><ExitStatusPill x={x} /></div>
            <p className="small muted" style={{ marginBottom: 0 }}>Its batch is not in the current watcher feed. Exit transaction <Hash value={x.tx} />.</p>
          </div>
        ))}
      </div>
    </div>
  );
}

type StepState = "done" | "now" | "wait" | "bad";

function Step({ state, title, children }: { state: StepState; title: string; children?: ReactNode }) {
  return (
    <li className={`step ${state}`}>
      <span className="dot" aria-hidden="true" />
      <div>
        <div className="step-title">{title}</div>
        {children && <div className="small muted">{children}</div>}
      </div>
    </li>
  );
}

function Timeline({ f }: { f: Found }) {
  const { rollup: r, batch: b, withdrawal: w, exit: x } = f;
  const st = batchState(b);
  const bad = b.verdict !== "match";
  const confirmed = !!b.pool?.confirmed;
  const final = b.status === "finalized";
  const now = Date.now() / 1000;
  const windowEnds = b.submittedTime + (r.lane?.windowSecs ?? 0);
  const repaid = x && (x.status === "settled" || x.status === "recovered");

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 12 }}>
        <strong>{qorFromUqor(w.amountUqor)} QOR from <Link href={`/r/${r.rollupId}`} className="mono">{r.rollupId}</Link></strong>
        <span className="spacer" />
        {x ? <ExitStatusPill x={x} /> : bad ? <Pill tone="bad">batch rejected by watchers</Pill> : confirmed && !final ? <Pill tone="info">ready to exit</Pill> : final ? <Pill tone="muted">collect the normal way</Pill> : <Pill tone="warn">awaiting watchers</Pill>}
      </div>
      <ol className="timeline">
        <Step state="done" title={`Batched in batch ${b.index}`}>
          <Link href={`/r/${r.rollupId}/${b.index}`}>{dateTime(b.submittedTime * 1000)}</Link>, to exit address <Hash value={w.recipientEvm} />
        </Step>
        <Step state={bad ? "bad" : "done"} title={bad ? "Re-execution does not match" : "Re-executed by the watchers: roots match"}>
          {bad ? b.reason ?? "The pool will not pay against this batch." : st === "match" ? "Independently verified" : undefined}
        </Step>
        {!bad && (
          <Step
            state={confirmed ? "done" : r.lane && !final ? "now" : "wait"}
            title={
              confirmed
                ? `Confirmed in the pool by ${b.pool!.watchers.length} watchers`
                : !r.lane
                  ? "No exit lane for this rollup"
                  : final
                    ? "Not confirmed in the pool before the batch became final"
                    : "Waiting for watcher attestations"
            }
          >
            {confirmed && b.pool?.confirmedAt ? `${dateTime(b.pool.confirmedAt)} · ${b.pool.coverQor} QOR of stake behind it` : undefined}
          </Step>
        )}
        {!bad && (
          <Step state={x ? "done" : confirmed && !final ? "now" : "wait"} title={x ? `Paid instantly: ${qorFromWei(x.amountWei - x.feeWei)} QOR` : "Instant exit"}>
            {x ? (
              <>
                {x.time && <>{dateTime(x.time * 1000)}, {duration(x.time - b.submittedTime)} after the batch · </>}
                to <Link href={`/track/${x.beneficiary}`} className="hash">{x.beneficiary.slice(0, 8)}…</Link> · <Hash value={x.tx} />
              </>
            ) : confirmed && !final ? (
              "The beneficiary can call instantExit now (wallet coming soon)."
            ) : final ? (
              "Not taken. The batch is final, so the withdrawal can now be executed to the exit address the normal way."
            ) : undefined}
          </Step>
        )}
        <Step state={final ? "done" : "wait"} title={final ? "Batch final" : "Challenge window"}>
          {final ? undefined : windowEnds > now ? `ends in about ${duration(windowEnds - now)}` : "should end any moment"}
        </Step>
        {x && (
          <Step state={repaid ? "done" : x.status === "defaulted" ? "bad" : "wait"} title={repaid ? "Pool repaid by the chain" : x.status === "defaulted" ? "Defaulted: the watchers' stake repaid the pool" : "Pool repayment"}>
            {x.closedTime ? `${dateTime(x.closedTime * 1000)} (${ago(x.closedTime * 1000)})` : `due by ${dateTime(Number(x.dueBy) * 1000)}`}
            {x.closedTx && <> · <Hash value={x.closedTx} /></>}
          </Step>
        )}
      </ol>
    </div>
  );
}
