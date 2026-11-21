import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { FRAUD_DEMO, QDAY, REDTEAM, SOURCES, STRESS, WITHDRAWALS_ROOT_LIE, hashesIn, sourceUrl, withoutHashes, type Attempt } from "../lib/proof";
import { NET } from "../lib/config";
import { num } from "../lib/format";
import { Hash, Pill } from "../components/ui";

// ------------------------------------------------------------- shared

function Sources({ src }: { src: { data: string; doc: string } }) {
  return (
    <p className="small muted" style={{ marginTop: 0 }}>
      Every figure on this page comes from <a href={sourceUrl(src.data)} target="_blank" rel="noreferrer"><code>{src.data}</code></a>, written by
      the script that ran the test; the write-up is <a href={sourceUrl(src.doc)} target="_blank" rel="noreferrer"><code>{src.doc}</code></a>.
      Native transactions open on explore.qore.network (press <strong>Testnet</strong> there once); EVM hashes can be copied and read with{" "}
      <code>eth_getTransactionReceipt</code> on <code>{NET.evmRpc}</code>.
    </p>
  );
}

/** A big figure that links to the file it comes from. */
function Figure({ value, unit, label, href }: { value: ReactNode; unit?: string; label: ReactNode; href: string }) {
  return (
    <a className="card stat" href={href} target="_blank" rel="noreferrer" style={{ color: "inherit" }} title="Open the data file">
      <div className="label">{label}</div>
      <div className="value">{value}{unit && <small>{unit}</small>}</div>
    </a>
  );
}

function Txs({ text }: { text: string }) {
  const hs = hashesIn(text);
  if (!hs.length) return null;
  return <span className="row" style={{ gap: 8, display: "inline-flex" }}>{hs.map((h) => <Hash key={h} value={h} tx />)}</span>;
}

function Crumb({ children }: { children: ReactNode }) {
  return <div className="crumbs" style={{ paddingTop: 24 }}><Link href="/proof">Proof</Link> / {children}</div>;
}

// ------------------------------------------------------------- hub

export function ProofIndex() {
  const cards: { href: string; title: string; line: string; figure: string }[] = [
    { href: "/qday", title: "Q-Day, simulated on chain", line: "A watcher's classical key cracked from public data; the classical twin of the pool drained, Wicketgate refused the same key.", figure: `${QDAY.crack.seconds} s to crack · ${QDAY.drain.stolenQor} QOR stolen from the twin · 0 from Wicketgate` },
    { href: "/redteam", title: "Red team", line: "Every attack we could think of, replayed against the live pool at the block of a real exit.", figure: `${REDTEAM.passed} of ${REDTEAM.total} attacks refused · ${REDTEAM.controls.length} honest controls accepted` },
    { href: "/stress", title: "Stress run", line: "Twenty exits from one batch until the watchers' stake was used up, then the next one refused.", figure: `${STRESS.exits} exits · ${STRESS.qorPaid} QOR in ${STRESS.secondsForAllExits} s · 21st refused` },
    { href: "/fraud", title: "Fraud caught", line: "Two lying batches submitted on purpose, each caught by a watcher's fraud proof and the liar's bond slashed.", figure: `caught in ${secondsBetween(FRAUD_DEMO, 1, 2)} s and ${WITHDRAWALS_ROOT_LIE.seconds} s · 2,000 QOR slashed` },
  ];
  return (
    <>
      <div className="page-head">
        <h1>Proof</h1>
        <p>Tests run on the live testnet contracts, each recorded with its transactions by the script that ran it. Nothing here is a mock-up.</p>
      </div>
      <div className="grid two">
        {cards.map((c) => (
          <Link key={c.href} href={c.href} className="card">
            <h3>{c.title}</h3>
            <p className="small muted" style={{ marginTop: 0 }}>{c.line}</p>
            <strong className="small">{c.figure}</strong>
          </Link>
        ))}
      </div>
    </>
  );
}

// ------------------------------------------------------------- Q-Day

const isTwin = (a: Attempt) => a.target === "ClassicalTwin";
const isPool = (a: Attempt) => a.target === "Wicketgate";

function AttemptRow({ a }: { a: Attempt }) {
  return (
    <li className={`attempt ${a.refused ? "held" : "fell"}`}>
      <div className="row" style={{ gap: 8 }}>
        {a.refused ? <Pill tone="ok">refused</Pill> : <Pill tone="bad">accepted</Pill>}
        <span className="small muted">{a.layer}</span>
      </div>
      <div style={{ margin: "4px 0" }}>{a.what}</div>
      <div className="small mono-wrap">{withoutHashes(a.result)}</div>
      <Txs text={a.result} />
    </li>
  );
}

export function QDay() {
  const q = QDAY;
  const src = sourceUrl(SOURCES.qday.data);
  const chainRefusals = q.closed.attempts.filter((a) => a.layer.startsWith("QoreChain")).length;
  const twinOpen = q.open.attempts.filter(isTwin);
  const poolOpen = q.open.attempts.filter(isPool);
  const twinClosed = q.closed.attempts.filter(isTwin);
  const poolClosed = q.closed.attempts.filter(isPool);
  const others = [...q.closed.attempts, ...q.open.attempts].filter((a) => !isTwin(a) && !isPool(a));

  return (
    <>
      <Crumb>Q-Day</Crumb>
      <div className="page-head" style={{ paddingTop: 8 }}>
        <h1>Q-Day, simulated on chain</h1>
        <p>
          On Q-Day a quantum computer turns any secp256k1 public key into its private key. Watcher W4 was given a deliberately weak 40-bit classical
          key (the only simulated part) and a full-strength ML-DSA-87 key, and watched two pools that differ in one thing: <strong>ClassicalTwin</strong>{" "}
          checks its signature with <code>ecrecover</code>, like most bridges and fast-exit pools today; <strong>Wicketgate</strong> checks ML-DSA-87
          inside the contract.
        </p>
      </div>
      <Sources src={SOURCES.qday} />

      <div className="grid stats">
        <Figure href={src} label="Classical key recovered from public data" value={q.crack.seconds} unit="s" />
        <Figure href={src} label="ClassicalTwin's balance" value={<>{q.open.before.twinQor} → <span style={{ color: "var(--bad)" }}>{q.open.after.twinQor}</span></>} unit="QOR" />
        <Figure href={src} label="Wicketgate pool's balance" value={<>{num(q.open.before.poolQor, 4)} → {num(q.open.after.poolQor, 4)}</>} unit="QOR" />
        <Figure href={src} label="Attempts the chain itself refused" value={chainRefusals} unit={`of ${q.closed.attempts.length} with the window closed`} />
      </div>

      <div className="section card">
        <ol className="timeline">
          <li className="step bad"><span className="dot" /><div><div className="step-title">1. The key falls</div><div className="small muted">The attacker read W4 (<Hash value={q.victim.evm} />)&apos;s public key from the chain and recovered its private key in {q.crack.seconds} s on one CPU core.</div></div></li>
          <li className="step done"><span className="dot" /><div><div className="step-title">2. W4&apos;s EVM window closed: QoreChain stops the stolen key</div><div className="small muted">{chainRefusals} attempts were refused by the chain itself (hybrid signatures, EVM windows); the rest reverted in the contracts.</div></div></li>
          <li className="step bad"><span className="dot" /><div><div className="step-title">3. W4 opens its routine window: the classical pool falls</div><div className="small muted">Inside the window the chain accepts the stolen classical signature. The attacker confirmed an invented batch in ClassicalTwin and took its {q.drain.stolenQor} QOR.</div></div></li>
          <li className="step done"><span className="dot" /><div><div className="step-title">4. Same key, same open window: Wicketgate holds</div><div className="small muted">The attestation sent from W4 itself reverted on chain with <code>BadSignature</code>, because ExitPool checks ML-DSA-87. The pool&apos;s assets did not move.</div></div></li>
        </ol>
      </div>

      <div className="section">
        <div className="section-head"><h2>Side by side</h2><p>The same stolen key against both pools</p></div>
        <div className="vs">
          <div className="card vs-col fell">
            <h3>ClassicalTwin <span className="small muted">(<code>ecrecover</code>)</span></h3>
            <p className="small muted" style={{ marginTop: 0 }}><Hash value={q.twin} /> · {q.open.before.twinQor} → {q.open.after.twinQor} QOR</p>
            <h4>Window closed</h4>
            <ul className="attempts">{twinClosed.map((a, i) => <AttemptRow key={i} a={a} />)}</ul>
            <h4>Window open</h4>
            <ul className="attempts">{twinOpen.map((a, i) => <AttemptRow key={i} a={a} />)}</ul>
          </div>
          <div className="card vs-col held">
            <h3>Wicketgate <span className="small muted">(ML-DSA-87 via <code>pqcVerify</code>)</span></h3>
            <p className="small muted" style={{ marginTop: 0 }}><Hash value={q.pool} /> · {num(q.open.before.poolQor, 4)} → {num(q.open.after.poolQor, 4)} QOR</p>
            <h4>Window closed</h4>
            <ul className="attempts">{poolClosed.map((a, i) => <AttemptRow key={i} a={a} />)}</ul>
            <h4>Window open</h4>
            <ul className="attempts">{poolOpen.map((a, i) => <AttemptRow key={i} a={a} />)}</ul>
          </div>
        </div>
      </div>

      <div className="section">
        <div className="section-head"><h2>What QoreChain itself refused</h2><p>W4&apos;s funds, stake and window</p></div>
        <div className="card"><ul className="attempts">{others.map((a, i) => <AttemptRow key={i} a={a} />)}</ul></div>
        <p className="small muted">{q.closed.onChainEvidence.replace(/`/g, "")}</p>
      </div>
    </>
  );
}

// ------------------------------------------------------------- red team

const SOURCE_LABELS: Record<string, string> = {
  payExit: "An exit on wicketgate-pay",
  vigilExit: "An exit on vigil-1",
  attestation: "A watcher attestation",
  setLane: "The two-admin lane change",
};

export function RedTeam() {
  const r = REDTEAM;
  const src = sourceUrl(SOURCES.redteam.data);
  return (
    <>
      <Crumb>Red team</Crumb>
      <div className="page-head" style={{ paddingTop: 8 }}>
        <h1>{r.passed} of {r.total} attacks refused</h1>
        <p>
          Each attack is replayed against the live pool&apos;s real state at the block of a real exit, attestation or lane change, and must be refused by
          the check written for it. The honest controls run the real transactions at the same blocks and must still be accepted, so a refusal is not
          just a broken setup.
        </p>
      </div>
      <Sources src={SOURCES.redteam} />
      <div className="grid stats">
        <Figure href={src} label="Attacks refused by the intended check" value={`${r.passed}/${r.total}`} />
        <Figure href={src} label="Honest controls accepted" value={`${r.controls.filter((c) => c.asExpected).length}/${r.controls.length}`} />
        <Figure href={src} label="Run at EVM block" value={r.evmBlock.toLocaleString()} />
      </div>

      <div className="section">
        <div className="section-head"><h2>Controls</h2><p>Real transactions, replayed at their own blocks</p></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>#</th><th>What</th><th>By</th><th>At</th><th>Result</th></tr></thead>
            <tbody>
              {r.controls.map((c) => (
                <tr key={c.id}>
                  <td className="mono">{c.id}</td>
                  <td style={{ whiteSpace: "normal" }}>{c.threat}</td>
                  <td className="muted">{c.who}</td>
                  <td className="muted">{c.at}</td>
                  <td>{c.asExpected ? <Pill tone="ok">accepted</Pill> : <Pill tone="bad">{c.got}</Pill>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="section">
        <div className="section-head"><h2>Attacks</h2><p>Expected refusal against what the contract answered</p></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>#</th><th>Attack</th><th>By</th><th>At</th><th>Expected</th><th>Got</th></tr></thead>
            <tbody>
              {r.results.map((a) => (
                <tr key={a.id}>
                  <td className="mono">{a.id}</td>
                  <td style={{ whiteSpace: "normal", minWidth: 260 }}>{a.threat}</td>
                  <td className="muted">{a.who}</td>
                  <td className="muted" style={{ whiteSpace: "normal" }}>{a.at}</td>
                  <td><code>{a.expect}</code></td>
                  <td>{a.refused && a.asExpected ? <Pill tone="ok">{a.got}</Pill> : <Pill tone="bad">{a.got}</Pill>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="section card">
        <h3>Replayed at the state of these real transactions</h3>
        <dl className="kv">
          {Object.entries(r.sources).map(([k, v]) => (
            <Fragment key={k}>
              <dt>{SOURCE_LABELS[k] ?? k}</dt>
              <dd><Hash value={v} /></dd>
            </Fragment>
          ))}
          <dt>Pool</dt><dd><Hash value={r.pool} /> (v2.1)</dd>
        </dl>
      </div>
    </>
  );
}

// ------------------------------------------------------------- stress

export function Stress() {
  const s = STRESS;
  const src = sourceUrl(SOURCES.stress.data);
  const t0 = Math.min(...s.rows.map((r) => r.paidAt));
  let cum = 0;
  const rows = s.rows.map((r, i) => {
    cum += r.amountQor;
    return { ...r, i: i + 1, cum, at: r.paidAt - t0 };
  });
  return (
    <>
      <Crumb>Stress run</Crumb>
      <div className="page-head" style={{ paddingTop: 8 }}>
        <h1>{s.exits} exits, {s.qorPaid} QOR in {s.secondsForAllExits} seconds</h1>
        <p>
          All from one batch of <Link href={`/r/${s.rollupId}/${s.batchIndex}`} className="mono">{s.rollupId}</Link> #{s.batchIndex}. The pool may never
          advance more than the stake its confirming watchers lock behind a batch: here {s.coverQor} QOR. It paid until that cover was used up, then
          refused the next exit with <code>{s.extraExit.result}</code>.
        </p>
      </div>
      <Sources src={SOURCES.stress} />
      <div className="grid stats">
        <Figure href={src} label="Exits paid from one batch" value={s.exits} unit={`in ${s.secondsForAllExits} s`} />
        <Figure href={src} label="Stake cover used" value={`${s.advancedQor} / ${s.coverQor}`} unit="QOR" />
        <Figure href={src} label="Median, withdrawal posted to paid" value={s.medianSecondsFromWithdrawalPostedToPaid} unit="s" />
        <Figure href={src} label={`Exit ${s.exits + 1} (${s.extraExit.amountQor} QOR)`} value={<span style={{ color: "var(--bad)" }}>refused</span>} unit={s.extraExit.result} />
      </div>

      <div className="section">
        <div className="section-head"><h2>The cover filling up</h2><p>Confirmed by {s.watchers.length} watchers, {s.coverQor} QOR of their stake behind the batch</p></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th className="num">Exit</th><th className="num">Paid at</th><th className="num">Amount</th><th>Cover used</th><th className="num">Posted to paid</th><th>Transaction</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.tx}>
                  <td className="num">{r.i}</td>
                  <td className="num muted">+{r.at} s</td>
                  <td className="num">{r.amountQor} QOR</td>
                  <td>
                    <div className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
                      <div className="bar" style={{ minWidth: 160 }}><span style={{ width: `${(r.cum / s.coverQor) * 100}%`, background: r.cum >= s.coverQor ? "var(--warn)" : undefined }} /></div>
                      <span className="small">{r.cum} / {s.coverQor}</span>
                    </div>
                  </td>
                  <td className="num">{r.secondsFromPost} s</td>
                  <td><Hash value={r.tx} /></td>
                </tr>
              ))}
              <tr>
                <td className="num">{s.exits + 1}</td>
                <td className="num muted">after</td>
                <td className="num">{s.extraExit.amountQor} QOR</td>
                <td><Pill tone="bad">refused: {s.extraExit.result}</Pill></td>
                <td className="num">–</td>
                <td className="muted small">reverted in simulation, never sent</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="small muted">{s.gasNote}</p>
      </div>
    </>
  );
}

// ------------------------------------------------------------- fraud

function secondsBetween(events: { time: number }[], a: number, b: number) {
  return events[b] && events[a] ? events[b].time - events[a].time : undefined;
}

export function Fraud() {
  const src = sourceUrl(SOURCES.fraud.data);
  const d = FRAUD_DEMO;
  const caught = secondsBetween(d, 1, 2);
  const blocks = d[2] && d[1] ? d[2].height - d[1].height : undefined;
  const lie = WITHDRAWALS_ROOT_LIE;
  return (
    <>
      <Crumb>Fraud caught</Crumb>
      <div className="page-head" style={{ paddingTop: 8 }}>
        <h1>Two lying batches, both caught in seconds</h1>
        <p>
          An optimistic rollup is only safe if someone re-executes every batch and challenges a wrong one inside the window. We submitted two wrong
          batches on purpose from a second bonded submitter. No watcher attested them, so the pool would not pay against them, and a watcher&apos;s fraud
          proof had the chain reject each batch and slash the liar&apos;s 1,000 QOR bond.
        </p>
      </div>
      <Sources src={SOURCES.fraud} />
      <div className="grid stats">
        <Figure href={src} label="Wrong state root, bad batch to fraud proof" value={caught ?? "–"} unit={`s (${blocks} blocks)`} />
        <Figure href={sourceUrl("PROOF.md")} label="Fabricated withdrawal, bad batch to fraud proof" value={lie.seconds} unit={`s (${lie.heights[1] - lie.heights[0]} blocks)`} />
        <Figure href={sourceUrl("PROOF.md")} label="Bonds slashed" value="2,000" unit="QOR" />
        <Figure href={sourceUrl("PROOF.md")} label="Paid to the watchers that caught them" value="1,000" unit="QOR" />
      </div>

      <div className="section">
        <div className="section-head"><h2>16 November: a flipped state root</h2><p><span className="mono">wicketgate-pay</span> batch 2</p></div>
        <div className="card">
          <ol className="timeline">
            {d.map((e, i) => (
              <li key={e.tx} className={`step ${i === 1 ? "bad" : "done"}`}>
                <span className="dot" />
                <div>
                  <div className="step-title">{e.label}</div>
                  <div className="small muted">
                    {i > 0 && <>+{e.time - d[0].time} s · </>}height {e.height.toLocaleString()} · <Hash value={e.tx} tx={e.lane === "cosmos"} />
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>

      <div className="section">
        <div className="section-head"><h2>{lie.date}: a fabricated withdrawal</h2><p><span className="mono">wicketgate-pay</span> batch {lie.batch}, the same kind of lie as batch 12</p></div>
        <div className="card">
          <ol className="timeline">
            {lie.events.map((e, i) => (
              <li key={e.tx} className={`step ${i === 0 ? "bad" : "done"}`}>
                <span className="dot" />
                <div>
                  <div className="step-title">{e.label}</div>
                  <div className="small muted">
                    {e.height && <>height {e.height.toLocaleString()} · </>}<Hash value={e.tx} tx />
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </div>
        <p className="small muted">
          Batch 12 of the same rollup, submitted by an account that is not ours, carries the same kind of wrong withdrawals root; it finalised before it
          was challenged (<Link href="/r/wicketgate-pay/12">batch 12</Link>). The cause has been reported to QoreChain privately.
        </p>
      </div>
    </>
  );
}

