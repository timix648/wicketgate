import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { BatchState } from "../lib/feed";
import { watcherName } from "../lib/config";
import { explorerTx, short } from "../lib/format";

export function Stat({ label, value, unit, sub }: { label: string; value: ReactNode; unit?: string; sub?: ReactNode }) {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className="value">
        {value}
        {unit && <small>{unit}</small>}
      </div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

export function Pill({ tone, children, title }: { tone: "ok" | "warn" | "bad" | "info" | "muted"; children: ReactNode; title?: string }) {
  return (
    <span className={`pill ${tone}`} title={title}>
      {children}
    </span>
  );
}

const STATE_LABEL: Record<BatchState, [string, "ok" | "warn" | "bad" | "info"]> = {
  match: ["Verified, final", "ok"],
  confirmed: ["Confirmed by watchers", "info"],
  pending: ["In challenge window", "warn"],
  contested: ["Contested", "bad"],
  mismatch: ["Mismatch", "bad"],
};

export function BatchPill({ state }: { state: BatchState }) {
  const [label, tone] = STATE_LABEL[state];
  return <Pill tone={tone}>{label}</Pill>;
}

export function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="copy"
      title="Copy"
      aria-label="Copy to clipboard"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? "✓" : "⧉"}
    </button>
  );
}

/** A hash or address, shortened, with copy; native tx hashes link to the explorer. */
export function Hash({ value, full, tx }: { value: string; full?: boolean; tx?: boolean }) {
  const href = tx ? explorerTx(value) : undefined;
  const text = full ? value : short(value, 8, 6);
  return (
    <span className="hash" title={value}>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" title="Opens on explore.qore.network (switch it to Testnet once)">
          {text}
        </a>
      ) : (
        text
      )}
      <CopyButton text={value} />
    </span>
  );
}

export function WatcherRef({ address }: { address: string }) {
  const name = watcherName(address);
  return (
    <span className="row" style={{ gap: 6, display: "inline-flex" }}>
      {name && <strong>{name}</strong>}
      <Link to={`/watchers#${address.toLowerCase()}`} className="hash">
        {short(address, 6, 4)}
      </Link>
    </span>
  );
}

export function Loading({ lines = 3 }: { lines?: number }) {
  return (
    <div className="card" aria-busy="true">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton" style={{ width: `${90 - i * 15}%`, marginBottom: 10 }} />
      ))}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : String(error);
  return <div className="card error-box">Could not load: {msg}</div>;
}
