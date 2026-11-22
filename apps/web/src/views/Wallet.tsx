"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";
import type { Address } from "viem";
import { feedAccount, type RollupFeed } from "../lib/feed";
import { useAllRollups, useLanes } from "../lib/queries";
import { ago, dateTime, qorFromUqor, qorFromWei } from "../lib/format";
import {
  connectNative,
  deposit,
  estimateExit,
  exitStatus,
  MIN_DEPOSIT_UQOR,
  newExitAddress,
  parseQor,
  qorexDownloadUrls,
  quoteExit,
  relay,
  relayStatus,
  requestExit,
  signTransfer,
  signWithdrawal,
} from "../lib/wallet/actions";
import {
  createAccount,
  downloadBackup,
  listRecords,
  MIN_PASSPHRASE,
  parseBackup,
  saveRecord,
  unlock,
  type Activity,
  type ExitRecord,
  type Unlocked,
  type VaultRecord,
} from "../lib/wallet/vault";
import { Hash, Loading, Pill } from "../components/ui";

const DEFAULT_ROLLUP = "wicketgate-pay";
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function Wallet() {
  const { address: evm, isConnected } = useAccount();
  const [native, setNative] = useState<string>();
  const [nativeError, setNativeError] = useState<string>();
  const [hasQorex, setHasQorex] = useState<boolean>();

  const [records, setRecords] = useState<VaultRecord[]>();
  const [storageError, setStorageError] = useState<string>();
  const [record, setRecord] = useState<VaultRecord>();
  const [keys, setKeys] = useState<Unlocked>();
  const [backedUp, setBackedUp] = useState(false);

  const { rollups } = useAllRollups();
  const { laneOf } = useLanes();
  const [rollupId, setRollupId] = useState(DEFAULT_ROLLUP);
  const exitRollups = rollups.filter((r) => laneOf(r.rollupId)?.enabled).map((r) => r.rollupId);
  const feed = rollups.find((r) => r.rollupId === rollupId);

  // QoreX injects window.qorex itself; a mobile in-app browser can do it after the page starts, so look again briefly.
  useEffect(() => {
    const check = () => setHasQorex(!!(window as any).qorex);
    check();
    const timers = [500, 1500, 3000].map((ms) => setTimeout(check, ms));
    return () => timers.forEach(clearTimeout);
  }, [isConnected]);

  useEffect(() => {
    listRecords()
      .then((rs) => {
        setRecords(rs);
        if (rs.length) setRecord(rs.sort((a, b) => b.createdAt - a.createdAt)[0]);
      })
      .catch((e) => setStorageError(errText(e)));
  }, []);

  // Native lane: the qor1 address that signs deposits. QoreX shares one site connection across lanes.
  useEffect(() => {
    if (!isConnected || native) return;
    connectNative().then(setNative, (e) => setNativeError(errText(e)));
  }, [isConnected, native]);

  // The record is also kept in a ref so a change is computed from the latest copy and written to
  // IndexedDB at once (exit salts must be stored before anything leaves the browser).
  const recordRef = useRef<VaultRecord | undefined>(undefined);
  useEffect(() => {
    recordRef.current = record;
  }, [record]);

  /** Applies a change to the stored record and keeps state in step. Resolves once it is saved. */
  const update = useCallback(async (fn: (r: VaultRecord) => VaultRecord) => {
    const cur = recordRef.current;
    if (!cur) return undefined;
    const next = fn(structuredClone(cur));
    recordRef.current = next;
    await saveRecord(next);
    setRecord(next);
    setBackedUp(false);
    return next;
  }, []);

  return (
    <>
      <div className="page-head">
        <h1>Wallet</h1>
        <p>
          Your QoreX wallet signs one thing: the deposit into a rollup. Transfers and withdrawals inside the rollup are signed by a rollup key made
          in this browser, and the instant exit is taken for you by Wicketgate&apos;s exit relay. Your recovery phrase is never asked for.
        </p>
      </div>

      <Section n={1} title="Connect QoreX">
        {hasQorex === false && !isConnected && (
          <div className="banner warn" style={{ marginBottom: 12 }}>
            <div>
              <strong>QoreX is not installed in this browser</strong>
              <span className="small">
                Install it for <a href={qorexDownloadUrls.chrome} target="_blank" rel="noreferrer">Chrome</a>,{" "}
                <a href={qorexDownloadUrls.firefox} target="_blank" rel="noreferrer">Firefox</a> or{" "}
                <a href={qorexDownloadUrls.safari} target="_blank" rel="noreferrer">Safari</a>, or open this page in the QoreX app&apos;s browser.
              </span>
            </div>
          </div>
        )}
        <div className="row">
          <ConnectButton chainStatus="none" showBalance={false} />
        </div>
        {isConnected && (
          <dl className="kv small" style={{ marginTop: 12 }}>
            <dt>EVM address</dt>
            <dd>{evm && <Hash value={evm} full />} <span className="muted">(instant exits pay here)</span></dd>
            <dt>Native address</dt>
            <dd>{native ? <Hash value={native} full /> : nativeError ? <span style={{ color: "var(--bad)" }}>{nativeError}</span> : "…"} <span className="muted">(signs deposits)</span></dd>
          </dl>
        )}
      </Section>

      <Section n={2} title="Your rollup account">
        {storageError ? (
          <div className="error-box card">This browser refused local storage ({storageError}). A private window cannot keep a rollup account.</div>
        ) : records === undefined ? (
          <Loading lines={2} />
        ) : !record ? (
          <CreateOrRestore
            onReady={async (r, k) => {
              await saveRecord(r);
              setRecords((rs) => [...(rs ?? []).filter((x) => x.accountId !== r.accountId), r]);
              setRecord(r);
              setKeys(k);
              setBackedUp(false);
            }}
          />
        ) : !keys ? (
          <UnlockForm record={record} onUnlocked={setKeys} />
        ) : (
          <AccountCard record={record} keys={keys} backedUp={backedUp} onBackup={() => { downloadBackup(record); setBackedUp(true); }} onLock={() => setKeys(undefined)} />
        )}
      </Section>

      {record && keys && (
        <>
          <Section n={3} title="Balance">
            <div className="row" style={{ marginBottom: 12 }}>
              <label className="small muted" htmlFor="rollup">Rollup</label>
              <select id="rollup" className="input" style={{ flex: "0 1 260px" }} value={rollupId} onChange={(e) => setRollupId(e.target.value)}>
                {(exitRollups.length ? exitRollups : [DEFAULT_ROLLUP]).map((id) => <option key={id} value={id}>{id}</option>)}
              </select>
            </div>
            <BalanceView record={record} feed={feed} rollupId={rollupId} />
          </Section>

          <Section n={4} title="Move money">
            <Actions
              record={record}
              keys={keys}
              rollupId={rollupId}
              feed={feed}
              evm={evm}
              native={native}
              update={update}
            />
          </Section>

          {record.exits.length > 0 && (
            <Section n={5} title="Instant exits">
              <div className="grid" style={{ gap: 12 }}>
                {[...record.exits].reverse().map((e) => (
                  <ExitProgress key={e.salt} exit={e} feed={rollups.find((r) => r.rollupId === e.rollupId)} />
                ))}
              </div>
            </Section>
          )}

          {(record.activity?.length ?? 0) > 0 && (
            <Section n={record.exits.length ? 6 : 5} title="Activity">
              <ActivityList items={record.activity ?? []} />
            </Section>
          )}
        </>
      )}
    </>
  );
}

function Section({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="section">
      <div className="section-head">
        <h2><span className="faint">{n}</span> {title}</h2>
      </div>
      <div className="card">{children}</div>
    </section>
  );
}

// ------------------------------------------------------------- account

function CreateOrRestore({ onReady }: { onReady: (r: VaultRecord, k: Unlocked) => Promise<void> }) {
  const [mode, setMode] = useState<"create" | "restore">("create");
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [file, setFile] = useState<VaultRecord>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const create = async () => {
    setError(undefined);
    if (pass !== pass2) return setError("The two passphrases differ");
    setBusy(true);
    try {
      const { record, keys } = await createAccount(pass, DEFAULT_ROLLUP);
      await onReady(record, keys);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const restore = async () => {
    setError(undefined);
    if (!file) return setError("Choose your backup file first");
    setBusy(true);
    try {
      const keys = await unlock(file, pass);
      await onReady(file, keys);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="row" role="tablist">
        <button className={`tab ${mode === "create" ? "on" : ""}`} onClick={() => setMode("create")} role="tab" aria-selected={mode === "create"}>Create a rollup account</button>
        <button className={`tab ${mode === "restore" ? "on" : ""}`} onClick={() => setMode("restore")} role="tab" aria-selected={mode === "restore"}>Restore from a backup</button>
      </div>
      {mode === "create" ? (
        <>
          <p className="small muted" style={{ margin: 0 }}>
            A new key is made from 32 random bytes in this browser. It is stored here, encrypted with your passphrase, and never sent anywhere. You
            will download a backup file next: <strong>losing both this browser&apos;s data and the backup loses your rollup balance.</strong>
          </p>
          <input className="input" type="password" autoComplete="new-password" placeholder={`Passphrase (at least ${MIN_PASSPHRASE} characters)`} value={pass} onChange={(e) => setPass(e.target.value)} />
          <input className="input" type="password" autoComplete="new-password" placeholder="Passphrase again" value={pass2} onChange={(e) => setPass2(e.target.value)} />
          <div className="row">
            <button className="btn" disabled={busy || pass.length < MIN_PASSPHRASE} onClick={create}>{busy ? "Creating…" : "Create rollup account"}</button>
          </div>
        </>
      ) : (
        <>
          <input
            className="input"
            type="file"
            accept="application/json,.json"
            onChange={async (e) => {
              setError(undefined);
              const f = e.target.files?.[0];
              if (!f) return;
              try {
                setFile(parseBackup(await f.text()));
              } catch (err) {
                setFile(undefined);
                setError(errText(err));
              }
            }}
          />
          {file && <p className="small muted" style={{ margin: 0 }}>Account {file.accountId.slice(0, 16)}…, {file.exits.length} saved exit(s).</p>}
          <input className="input" type="password" autoComplete="current-password" placeholder="Passphrase" value={pass} onChange={(e) => setPass(e.target.value)} />
          <div className="row">
            <button className="btn" disabled={busy || !file || !pass} onClick={restore}>{busy ? "Unlocking…" : "Restore"}</button>
          </div>
        </>
      )}
      {error && <p className="small" style={{ color: "var(--bad)", margin: 0 }}>{error}</p>}
    </div>
  );
}

function UnlockForm({ record, onUnlocked }: { record: VaultRecord; onUnlocked: (k: Unlocked) => void }) {
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <form
      className="grid"
      style={{ gap: 10 }}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(undefined);
        try {
          onUnlocked(await unlock(record, pass));
        } catch (err) {
          setError(errText(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="small muted" style={{ margin: 0 }}>Rollup account <span className="mono">{record.accountId.slice(0, 16)}…</span> is stored in this browser, locked.</p>
      <div className="row">
        <input className="input" type="password" autoComplete="current-password" placeholder="Passphrase" value={pass} onChange={(e) => setPass(e.target.value)} />
        <button className="btn" disabled={busy || !pass}>{busy ? "Unlocking…" : "Unlock"}</button>
      </div>
      {error && <p className="small" style={{ color: "var(--bad)", margin: 0 }}>{error}</p>}
    </form>
  );
}

function AccountCard({ record, keys, backedUp, onBackup, onLock }: { record: VaultRecord; keys: Unlocked; backedUp: boolean; onBackup: () => void; onLock: () => void }) {
  return (
    <div className="grid" style={{ gap: 10 }}>
      {!backedUp && (
        <div className="banner warn">
          <div>
            <strong>Download a backup now</strong>
            <span className="small">
              It holds your encrypted key and the salt of every exit. Download a fresh one after each withdrawal: without the salt, that exit&apos;s
              money cannot be collected.
            </span>
          </div>
        </div>
      )}
      <dl className="kv">
        <dt>Account id</dt>
        <dd><Hash value={keys.accountId} full /></dd>
        <dt>Created</dt>
        <dd>{dateTime(record.createdAt)}</dd>
      </dl>
      <div className="row">
        <button className="btn" onClick={onBackup}>Download backup</button>
        <button className="icon-btn" onClick={onLock}>Lock</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- balance and nonce

function pendingOut(record: VaultRecord, rollupId: string, fromNonce: bigint) {
  return (record.activity ?? [])
    .filter((a) => a.rollupId === rollupId && (a.kind === "send" || a.kind === "withdraw") && a.nonce !== undefined && BigInt(a.nonce) >= fromNonce)
    .reduce((s, a) => s + BigInt(a.amountUqor), 0n);
}

/** The nonce to sign with: the feed's, or one past this browser's last transaction, whichever is higher. */
function nextNonce(record: VaultRecord, feed: RollupFeed | undefined, rollupId: string): bigint {
  const fromFeed = feedAccount(feed, record.accountId)?.nonce ?? 0n;
  const local = BigInt(record.nextNonce?.[rollupId] ?? "0");
  return fromFeed > local ? fromFeed : local;
}

function BalanceView({ record, feed, rollupId }: { record: VaultRecord; feed?: RollupFeed; rollupId: string }) {
  const acct = feedAccount(feed, record.accountId);
  const deposits = (record.activity ?? []).filter((a) => a.kind === "deposit" && a.rollupId === rollupId).reduce((s, a) => s + BigInt(a.amountUqor), 0n);
  const spent = (record.activity ?? []).filter((a) => a.kind !== "deposit" && a.rollupId === rollupId).reduce((s, a) => s + BigInt(a.amountUqor), 0n);
  if (acct === undefined) {
    return (
      <div className="grid" style={{ gap: 6 }}>
        <div className="stat"><div className="value">{qorFromUqor((deposits - spent).toString())}<small>QOR, estimated</small></div></div>
        <p className="small muted" style={{ margin: 0 }}>
          Estimated from this browser&apos;s own deposits and payments. The watcher feed does not publish account balances yet, so payments made
          elsewhere with this key are not counted.
        </p>
      </div>
    );
  }
  const verified = acct?.balance ?? 0n;
  const pending = pendingOut(record, rollupId, acct?.nonce ?? 0n);
  return (
    <div className="grid" style={{ gap: 6 }}>
      <div className="stat"><div className="value">{qorFromUqor(verified.toString())}<small>QOR</small></div></div>
      <p className="small muted" style={{ margin: 0 }}>
        After the last batch the watchers re-executed{feed?.updatedAt ? ` (feed ${ago(feed.updatedAt)})` : ""}.
        {pending > 0n && <> {qorFromUqor(pending.toString())} QOR of your payments are waiting to be batched.</>}
        {acct === null && " This account has no balance on this rollup yet; a deposit shows up once it is batched."}
      </p>
    </div>
  );
}

// ------------------------------------------------------------- deposit, send, withdraw

type Tab = "deposit" | "send" | "withdraw";

function Actions(props: {
  record: VaultRecord;
  keys: Unlocked;
  rollupId: string;
  feed?: RollupFeed;
  evm?: Address;
  native?: string;
  update: (fn: (r: VaultRecord) => VaultRecord) => Promise<VaultRecord | undefined>;
}) {
  const { record, keys, rollupId, feed, evm, native, update } = props;
  const [tab, setTab] = useState<Tab>("deposit");
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: ReactNode }>();
  const uqor = parseQor(amount);

  const estimate = useQuery({
    queryKey: ["estimate", rollupId, uqor?.toString()],
    queryFn: () => estimateExit(rollupId, uqor!),
    enabled: tab === "withdraw" && !!uqor && uqor > 0n,
    staleTime: 15_000,
  });

  const log = (a: Activity, extra?: (r: VaultRecord) => void) =>
    update((r) => {
      r.activity = [...(r.activity ?? []), a];
      extra?.(r);
      return r;
    });

  const doDeposit = async () => {
    if (!native) throw new Error("Connect QoreX first: the deposit is signed by your QoreX wallet");
    if (!uqor || uqor < MIN_DEPOSIT_UQOR) throw new Error("The chain's minimum deposit is 1 QOR");
    const res = await deposit({ depositor: native, rollupId, accountId: keys.accountId, amountUqor: uqor });
    await log({ kind: "deposit", rollupId, amountUqor: uqor.toString(), at: Date.now(), txHash: res.txHash });
    setMsg({ ok: true, text: <>Deposited. Transaction <Hash value={res.txHash.toUpperCase()} tx />{res.shield !== "shielded" && <> (post-quantum layer: {res.shield})</>}. It counts once a submitter batches it.</> });
  };

  const doSend = async () => {
    const dest = to.trim().replace(/^0x/, "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(dest)) throw new Error("Send to a rollup account id: 64 hex characters");
    if (dest === keys.accountId) throw new Error("That is your own account");
    if (!uqor || uqor <= 0n) throw new Error("Enter an amount");
    const nonce = nextNonce(record, feed, rollupId);
    const tx = signTransfer(keys, rollupId, nonce, uqor, dest);
    const { id } = await relay(rollupId, tx);
    await log({ kind: "send", rollupId, amountUqor: uqor.toString(), at: Date.now(), relayId: id, to: dest, nonce: nonce.toString() }, (r) => {
      r.nextNonce = { ...(r.nextNonce ?? {}), [rollupId]: (nonce + 1n).toString() };
    });
    setMsg({ ok: true, text: "Signed and handed to the relay; it is posted to the rollup within about a minute." });
  };

  const doWithdraw = async () => {
    if (!evm) throw new Error("Connect QoreX first: the instant exit pays your EVM address");
    if (!uqor || uqor <= 0n) throw new Error("Enter an amount");
    const est = await estimateExit(rollupId, uqor);
    if (est.blocker) throw new Error(est.blocker);
    const { salt, exitAddr } = await newExitAddress(evm);
    const nonce = nextNonce(record, feed, rollupId);
    const tx = signWithdrawal(keys, rollupId, nonce, uqor, exitAddr);
    const exit: ExitRecord = { rollupId, salt, exitAddr, beneficiary: evm, amountUqor: uqor.toString(), nonce: nonce.toString(), createdAt: Date.now() };
    // Save the salt before anything leaves the browser.
    await update((r) => {
      r.exits = [...r.exits, exit];
      r.nextNonce = { ...(r.nextNonce ?? {}), [rollupId]: (nonce + 1n).toString() };
      return r;
    });
    const posted = await relay(rollupId, tx);
    const queued = await requestExit({ rollupId, beneficiary: evm, salt, amountUqor: uqor });
    await update((r) => {
      r.exits = r.exits.map((x) => (x.salt === salt ? { ...x, relayId: posted.id, exitId: queued.id } : x));
      r.activity = [...(r.activity ?? []), { kind: "withdraw", rollupId, amountUqor: uqor.toString(), at: Date.now(), relayId: posted.id, exitId: queued.id, nonce: nonce.toString(), exitAddr }];
      return r;
    });
    setMsg({ ok: true, text: <>Withdrawal signed. The exit request was sealed in this browser to the operator's ML-KEM-1024 key (from the chain's KEM registry) and queued for an instant exit to <Hash value={evm} />; the relay only holds ciphertext. Follow it below, and download a fresh backup.</> });
  };

  const run = async () => {
    setBusy(true);
    setMsg(undefined);
    try {
      if (tab === "deposit") await doDeposit();
      else if (tab === "send") await doSend();
      else await doWithdraw();
      setAmount("");
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="row" role="tablist">
        {(["deposit", "send", "withdraw"] as Tab[]).map((t) => (
          <button key={t} className={`tab ${tab === t ? "on" : ""}`} role="tab" aria-selected={tab === t} onClick={() => { setTab(t); setMsg(undefined); }}>
            {t === "deposit" ? "Deposit" : t === "send" ? "Send" : "Withdraw instantly"}
          </button>
        ))}
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        {tab === "deposit" && <>From your QoreX wallet into <span className="mono">{rollupId}</span>. QoreX shows the transaction and signs it with your post-quantum key. Minimum 1 QOR.</>}
        {tab === "send" && <>To another rollup account on <span className="mono">{rollupId}</span>, signed with your rollup key. Nothing to sign in QoreX.</>}
        {tab === "withdraw" && <>Out of <span className="mono">{rollupId}</span> to your EVM address, paid by the pool about a minute after the watchers verify the batch, instead of waiting for the challenge window.</>}
      </p>
      {tab === "send" && <input className="input" placeholder="Recipient rollup account id (64 hex characters)" value={to} onChange={(e) => setTo(e.target.value)} spellCheck={false} />}
      <div className="row">
        <input className="input" inputMode="decimal" placeholder="Amount in QOR" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ flex: "0 1 220px" }} aria-label="Amount in QOR" />
        <button className="btn" disabled={busy || !uqor || (tab === "withdraw" && !!estimate.data?.blocker)} onClick={run}>
          {busy ? "Working…" : tab === "deposit" ? "Deposit with QoreX" : tab === "send" ? "Sign and send" : "Withdraw instantly"}
        </button>
      </div>
      {amount && !uqor && <p className="small" style={{ color: "var(--bad)", margin: 0 }}>Enter an amount like 2 or 0.5 (up to 6 decimals).</p>}
      {tab === "withdraw" && uqor && uqor > 0n && (
        <div className="small">
          {estimate.isLoading ? (
            <span className="muted">Reading the pool…</span>
          ) : estimate.error ? (
            <span style={{ color: "var(--bad)" }}>Could not read the pool: {errText(estimate.error)}</span>
          ) : estimate.data ? (
            <dl className="kv">
              <dt>You receive</dt><dd><strong>{qorFromWei(estimate.data.payoutWei, 6)} QOR</strong></dd>
              <dt>Fee</dt><dd>{qorFromWei(estimate.data.feeWei, 6)} QOR ({Number(estimate.data.feeBps) / 100}%{estimate.data.tipWei > 0n && <> plus a {qorFromWei(estimate.data.tipWei, 4)} QOR execution fee</>})</dd>
              <dt>Paid to</dt><dd>{evm ? <Hash value={evm} /> : "your EVM address, once connected"}</dd>
              {estimate.data.blocker && <><dt>Cannot exit</dt><dd style={{ color: "var(--bad)" }}>{estimate.data.blocker}</dd></>}
              <dt>Before payment</dt><dd className="muted">The exact figure is fixed once the watchers confirm the batch carrying your withdrawal, and is shown below.</dd>
            </dl>
          ) : null}
        </div>
      )}
      {msg && <div className={`banner ${msg.ok ? "ok" : "bad"}`}><div className="small">{msg.text}</div></div>}
    </div>
  );
}

// ------------------------------------------------------------- exit progress

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

function ExitProgress({ exit, feed }: { exit: ExitRecord; feed?: RollupFeed }) {
  const relayQ = useQuery({
    queryKey: ["relay", exit.relayId],
    queryFn: () => relayStatus(exit.relayId!),
    enabled: !!exit.relayId,
    refetchInterval: (q) => (q.state.data?.status === "queued" ? 10_000 : false),
  });
  const exitQ = useQuery({
    queryKey: ["exit", exit.exitId],
    queryFn: () => exitStatus(exit.exitId!),
    enabled: !!exit.exitId,
    refetchInterval: (q) => (q.state.data?.status === "queued" ? 10_000 : false),
  });
  const batch = useMemo(
    () => feed?.batches.find((b) => b.withdrawals?.some((w) => w.recipientEvm.toLowerCase() === exit.exitAddr.toLowerCase())),
    [feed, exit.exitAddr],
  );
  const paid = exitQ.data?.status === "paid";
  const failed = exitQ.data?.status === "failed";
  const quote = useQuery({
    queryKey: ["quote", exit.rollupId, batch?.index, exit.amountUqor],
    queryFn: () => quoteExit(exit.rollupId, batch!.index, BigInt(exit.amountUqor)),
    enabled: !!batch && !paid && !failed,
    refetchInterval: 20_000,
  });

  const rs = relayQ.data?.status;
  const verified = batch && batch.verdict === "match";
  const confirmed = !!batch?.pool?.confirmed;

  return (
    <div className="card" style={{ background: "var(--surface-2)" }}>
      <div className="row" style={{ marginBottom: 10 }}>
        <strong>{qorFromUqor(exit.amountUqor)} QOR from <span className="mono">{exit.rollupId}</span></strong>
        <span className="spacer" />
        {paid ? <Pill tone="ok">paid</Pill> : failed ? <Pill tone="bad">not paid instantly</Pill> : <Pill tone="warn">in progress</Pill>}
      </div>
      <ol className="timeline">
        <Step state={rs === "posted" ? "done" : rs === "failed" ? "bad" : exit.relayId ? "now" : "wait"} title={rs === "posted" ? "Posted to the rollup" : rs === "failed" ? "The relay could not post it" : "Waiting for the relay to post it"}>
          {relayQ.data?.txHash && <Hash value={relayQ.data.txHash} tx />}
          {relayQ.data?.error}
        </Step>
        <Step state={batch ? "done" : rs === "posted" ? "now" : "wait"} title={batch ? `Batched in batch ${batch.index}` : "Waiting for a submitter to batch it"}>
          {batch && <Link href={`/r/${exit.rollupId}/${batch.index}`}>{dateTime(batch.submittedTime * 1000)}</Link>}
        </Step>
        <Step state={!batch ? "wait" : verified ? (confirmed ? "done" : "now") : "bad"} title={!batch ? "Verified by the watchers" : !verified ? "The watchers found this batch wrong" : confirmed ? `Verified by ${batch.pool!.watchers.length} watchers` : "Watchers re-executing and attesting"}>
          {quote.data && !paid && (
            <>
              {quote.data.text}
              {quote.data.ok && <> · you receive {qorFromWei(quote.data.payoutWei, 6)} QOR</>}
            </>
          )}
        </Step>
        <Step state={paid ? "done" : failed ? "bad" : confirmed ? "now" : "wait"} title={paid ? "Paid to your EVM address" : failed ? "Not paid instantly" : "Paid by the exit relay"}>
          {exitQ.data?.txHash && <Hash value={exitQ.data.txHash} />}
          {failed && <>{exitQ.data?.error} The money is still yours: after the batch is final it is collected to your address (<code>sweepToBeneficiary</code>). Keep your backup: it holds this exit&apos;s salt.</>}
        </Step>
      </ol>
      <p className="small muted" style={{ margin: "10px 0 0" }}>
        Exit address <Hash value={exit.exitAddr} /> · <Link href={`/track/${exit.exitAddr}`}>track it</Link>
      </p>
    </div>
  );
}

function ActivityList({ items }: { items: Activity[] }) {
  return (
    <ul className="activity">
      {[...items].reverse().map((a, i) => (
        <li key={`${a.at}-${i}`}>
          <span className="when" title={dateTime(a.at)}>{ago(a.at)}</span>
          <span>
            {a.kind === "deposit" ? "Deposited" : a.kind === "send" ? "Sent" : "Withdrew"} <strong>{qorFromUqor(a.amountUqor)} QOR</strong>
            {a.kind === "deposit" ? " into " : a.kind === "send" ? " on " : " from "}
            <span className="mono">{a.rollupId}</span>
            {a.to && <> to <span className="mono">{a.to.slice(0, 10)}…</span></>}
            {a.txHash && <> · <Hash value={a.txHash.toUpperCase()} tx /></>}
            {a.exitAddr && <> · <Link href={`/track/${a.exitAddr}`}>track</Link></>}
          </span>
        </li>
      ))}
    </ul>
  );
}

