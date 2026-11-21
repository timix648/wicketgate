"use client";

import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useWriteContract } from "wagmi";
import { formatEther, parseEther, type Abi, type Address } from "viem";
import { isQorexUnsupportedMethodError } from "@qorechain/qorex-types";
import poolAbiJson from "@wicketgate/core/abi/ExitPool.json";
import { client } from "../lib/chain";
import { POOLS, type PoolDeployment } from "../lib/config";
import { eventTime, type EventLog } from "../lib/events";
import { usePool, useEvents } from "../lib/queries";
import { dateTime, num, qorFromWei } from "../lib/format";
import { ErrorBox, Hash, Loading, Pill, Stat } from "../components/ui";
import { LineChart, type Point } from "../components/LineChart";

const poolAbi = poolAbiJson as Abi;
/** ExitPool mints shares against virtual offsets (1 wei of assets, 1e6 shares) against share inflation. */
const VIRTUAL_SHARES = 1_000_000n;
const VIRTUAL_ASSETS = 1n;
const LIVE = POOLS.find((p) => p.live)!;

/** Wei of pool assets behind one share right now, as the contract prices a deposit or withdrawal. */
const livePrice = (assets: bigint, shares: bigint) => Number(assets + VIRTUAL_ASSETS) / Number(shares + VIRTUAL_SHARES);
/** The price an LP event was settled at: wei paid or received per share minted or burned. */
const eventPrice = (e: { amount: bigint; shares: bigint }) => Number(e.amount) / Number(e.shares);

interface LpEvent { kind: "Deposited" | "Withdrawn"; provider: Address; amount: bigint; shares: bigint; time?: number; tx: string; pool: string }

function lpEvents(log: EventLog, pool: PoolDeployment): LpEvent[] {
  return log.events
    .filter((e) => (e.name === "Deposited" || e.name === "Withdrawn") && e.address.toLowerCase() === pool.pool.toLowerCase())
    .map((e) => ({ kind: e.name as LpEvent["kind"], provider: e.args.provider, amount: e.args.amount, shares: e.args.shares, time: eventTime(log, e), tx: e.tx, pool: pool.version }));
}

async function positionOf(address: Address) {
  return Promise.all(
    POOLS.map(async (p) => {
      const [shares, assets, total] = await Promise.all([
        client.readContract({ address: p.pool, abi: poolAbi, functionName: "shares", args: [address] }) as Promise<bigint>,
        client.readContract({ address: p.pool, abi: poolAbi, functionName: "totalAssets" }) as Promise<bigint>,
        client.readContract({ address: p.pool, abi: poolAbi, functionName: "totalShares" }) as Promise<bigint>,
      ]);
      return { pool: p, shares, valueWei: (shares * (assets + VIRTUAL_ASSETS)) / (total + VIRTUAL_SHARES) };
    }),
  );
}

/** wagmi and viem wrap the wallet's own error (e.g. as UnknownRpcError); look through every cause. */
function causes(e: unknown): unknown[] {
  const out: unknown[] = [];
  for (let c: any = e; c && out.length < 10; c = c.cause) out.push(c);
  return out;
}

function explain(e: unknown): string {
  if (causes(e).some((c) => isQorexUnsupportedMethodError(c) || /not yet supported/i.test(String((c as any)?.message ?? c)))) {
    return "QoreX cannot send EVM transactions yet (it is on QoreX's planned list). Depositing and withdrawing liquidity are EVM calls from your own address, so they will work here as soon as QoreX supports them.";
  }
  const m = e instanceof Error ? (e as any).shortMessage ?? e.message : String(e);
  if (/window/i.test(m)) return `${m}. QoreChain needs an open EVM authorisation window on your account first.`;
  if (/NoLiquidity/.test(m)) return "Only idle liquidity can leave the pool: part of it is out on instant exits until the chain repays them.";
  return m;
}

export function Pool() {
  const pool = usePool();
  const events = useEvents();
  const { address, isConnected } = useAccount();
  const position = useQuery({ queryKey: ["lp-position", address], queryFn: () => positionOf(address!), enabled: !!address, refetchInterval: 30_000 });
  const { writeContractAsync, isPending } = useWriteContract();
  const [amount, setAmount] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const [view, setView] = useState(LIVE.version);

  const p = pool.data;
  const shownPool = POOLS.find((x) => x.version === view) ?? LIVE;
  const history = events.data ? lpEvents(events.data, shownPool) : [];
  const points: Point[] = history
    .filter((e) => e.time && e.shares > 0n)
    .map((e) => ({ x: e.time!, y: eventPrice(e), label: `${e.kind === "Deposited" ? "Deposit" : "Withdrawal"} of ${qorFromWei(e.amount, 2)} QOR` }));
  if (shownPool.live && p && events.data) points.push({ x: Math.floor(Date.now() / 1000), y: livePrice(p.totalAssets, p.totalShares), label: "Now, from totalAssets / totalShares" });
  const first = points[0]?.y;
  const indexed = first ? points.map((pt) => ({ ...pt, y: pt.y / first })) : [];
  const growth = indexed.length ? (indexed.at(-1)!.y - 1) * 100 : undefined;

  const act = async (kind: "deposit" | "withdraw") => {
    setMsg(undefined);
    try {
      if (kind === "deposit") {
        const value = parseEther(amount);
        if (value <= 0n) throw new Error("Enter an amount");
        await writeContractAsync({ address: LIVE.pool, abi: poolAbi, functionName: "deposit", value, gas: 300_000n });
        setMsg({ ok: true, text: `Deposited ${amount} QOR into pool v${LIVE.version}.` });
      } else {
        const mine = position.data?.find((x) => x.pool.live);
        if (!mine?.shares) throw new Error("You hold no shares in the live pool");
        await writeContractAsync({ address: LIVE.pool, abi: poolAbi, functionName: "withdraw", args: [mine.shares], gas: 300_000n });
        setMsg({ ok: true, text: "Withdrew your liquidity." });
      }
      position.refetch();
    } catch (e) {
      setMsg({ ok: false, text: explain(e) });
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>Pool</h1>
        <p>
          Liquidity providers fund the instant exits. The pool pays a withdrawal now and the chain repays it when the batch is final; the 0.3% fee
          stays in the pool, so each share is worth a little more after every repaid exit. A loss is only possible if the watchers confirm a wrong
          batch, and then their locked stake repays the pool first.
        </p>
      </div>

      {pool.error ? (
        <ErrorBox error={pool.error} />
      ) : !p ? (
        <Loading lines={2} />
      ) : (
        <div className="grid stats">
          <Stat label={`Pool assets (v${LIVE.version})`} value={qorFromWei(p.totalAssets, 2)} unit="QOR" sub={<Hash value={LIVE.pool} />} />
          <Stat label="Idle, can be withdrawn" value={qorFromWei(p.idleLiquidity, 2)} unit="QOR" />
          <Stat label="Out on instant exits" value={qorFromWei(p.outstanding, 2)} unit="QOR" sub="repaid by the chain at finalisation" />
          <Stat label="Share value since the first deposit" value={growth === undefined ? "…" : `${growth >= 0 ? "+" : ""}${num(growth, 3)}%`} sub={`pool v${LIVE.version}`} />
        </div>
      )}

      <div className="section grid two">
        <div className="card">
          <h3>Your liquidity</h3>
          {!isConnected ? (
            <>
              <p className="small muted" style={{ marginTop: 0 }}>Connect QoreX to see your shares.</p>
              <ConnectButton chainStatus="none" showBalance={false} />
            </>
          ) : position.error ? (
            <ErrorBox error={position.error} />
          ) : !position.data ? (
            <Loading lines={2} />
          ) : (
            <dl className="kv">
              {position.data.map((x) => (
                <Fragment key={x.pool.version}>
                  <dt>Pool v{x.pool.version}{x.pool.live ? "" : " (previous)"}</dt>
                  <dd>{x.shares > 0n ? `${qorFromWei(x.valueWei, 6)} QOR` : <span className="faint">none</span>}</dd>
                </Fragment>
              ))}
              <dt>Address</dt><dd>{address && <Hash value={address} />}</dd>
            </dl>
          )}
        </div>
        <div className="card">
          <h3>Add or remove liquidity</h3>
          <p className="small muted" style={{ marginTop: 0 }}>
            Both are EVM transactions from your own address. QoreX cannot send EVM transactions yet, so these buttons will tell you so until it can.
          </p>
          <div className="row">
            <input className="input" inputMode="decimal" placeholder="QOR to deposit" aria-label="QOR to deposit" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ flex: "0 1 180px" }} />
            <button className="btn" disabled={!isConnected || isPending || !amount} onClick={() => act("deposit")}>Deposit</button>
            <button className="icon-btn" disabled={!isConnected || isPending || !position.data?.find((x) => x.pool.live)?.shares} onClick={() => act("withdraw")}>Withdraw all</button>
          </div>
          {msg && <div className={`banner ${msg.ok ? "ok" : "warn"}`} style={{ marginTop: 10 }}><div className="small">{msg.text}</div></div>}
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <h2>Share value over time</h2>
          <div className="row" role="tablist">
            {POOLS.map((x) => (
              <button key={x.version} className={`tab ${view === x.version ? "on" : ""}`} role="tab" aria-selected={view === x.version} onClick={() => setView(x.version)}>
                Pool v{x.version}
              </button>
            ))}
          </div>
        </div>
        {events.error ? (
          <ErrorBox error={events.error} />
        ) : !events.data ? (
          <Loading lines={4} />
        ) : (
          <>
            <div className="card">
              <p className="small muted" style={{ marginTop: 0 }}>
                The value of one share, indexed to 1.0000 at the first deposit. Each point is a deposit or withdrawal, where the pool&apos;s own price can
                be read from the event{shownPool.live ? ", plus the value now" : ""}.
              </p>
              <LineChart points={indexed} format={(y) => y.toFixed(5)} ariaLabel={`Share value of pool v${shownPool.version} over time`} />
            </div>
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table>
                <thead><tr><th>When</th><th>Event</th><th>Provider</th><th className="num">QOR</th><th className="num">Share value</th><th>Transaction</th></tr></thead>
                <tbody>
                  {[...history].reverse().map((e) => (
                    <tr key={e.tx + e.kind}>
                      <td>{e.time ? dateTime(e.time * 1000) : "–"}</td>
                      <td>{e.kind === "Deposited" ? <Pill tone="ok">deposit</Pill> : <Pill tone="muted">withdrawal</Pill>}</td>
                      <td><Hash value={e.provider} /></td>
                      <td className="num">{num(Number(formatEther(e.amount)), 4)}</td>
                      <td className="num">{first && e.shares > 0n ? (eventPrice(e) / first).toFixed(5) : "–"}</td>
                      <td><Hash value={e.tx} /></td>
                    </tr>
                  ))}
                  {!history.length && <tr><td colSpan={6} className="empty">No deposits or withdrawals in this pool yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </>
  );
}
