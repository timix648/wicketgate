import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { NET, REPO_URL, FEED_BASE } from "../lib/config";
import { useIndex, usePool } from "../lib/queries";
import { ago } from "../lib/format";

type Theme = "system" | "light" | "dark";

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem("wg-theme") as Theme) || "system";
    } catch {
      return "system";
    }
  });
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("wg-theme", theme);
    } catch {}
  }, [theme]);
  const next = () => setTheme((t) => (t === "system" ? "dark" : t === "dark" ? "light" : "system"));
  return [theme, next];
}

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
      <rect x="3" y="3" width="26" height="26" rx="3" fill="none" stroke="var(--accent)" strokeWidth="3" />
      <rect x="12" y="13" width="8" height="16" fill="var(--accent)" />
    </svg>
  );
}

/** The feed is published every 5 minutes; after this long, say so instead of showing old data as current. */
const STALE_MINUTES = 20;

function HealthNotice({ latest, indexError }: { latest?: string; indexError: unknown }) {
  const pool = usePool();
  const problems: string[] = [];
  if (indexError) problems.push("The watcher feed cannot be reached, so rollup and batch data may be missing.");
  else if (latest && Date.now() - new Date(latest).getTime() > STALE_MINUTES * 60_000)
    problems.push(`The watcher feed was last updated ${ago(latest)}; it normally refreshes every 5 minutes, so batch data may be behind the chain.`);
  if (pool.error && !pool.data) problems.push("The QoreChain testnet EVM RPC is not answering, so live pool and watcher figures are unavailable.");
  if (!problems.length) return null;
  return (
    <div className="banner warn notice" role="status">
      <div>
        <strong>Some data may be out of date</strong>
        {problems.map((p) => <div key={p} className="small">{p}</div>)}
      </div>
    </div>
  );
}

export function Layout() {
  const [theme, nextTheme] = useTheme();
  const index = useIndex();
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  const latest = index.data?.rollups.map((r) => r.updatedAt).sort().at(-1);

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <NavLink to="/" className="brand">
            <Logo /> Wicketgate <small>board</small>
          </NavLink>
          <nav className="nav">
            <NavLink to="/" end>Overview</NavLink>
            <NavLink to="/rollups">Rollups</NavLink>
            <NavLink to="/watchers">Watchers</NavLink>
            <NavLink to="/exits">Instant exits</NavLink>
            <NavLink to="/track">Track an exit</NavLink>
          </nav>
          <div className="topbar-right">
            {latest && (
              <span className="row" style={{ gap: 6 }} title={`Watcher feed updated ${new Date(latest).toLocaleString()}`}>
                <span className="live-dot" /> feed {ago(latest)}
              </span>
            )}
            <button className="icon-btn" onClick={nextTheme} title="Switch theme">
              {theme === "system" ? "Auto" : theme === "dark" ? "Dark" : "Light"}
            </button>
          </div>
        </div>
      </header>
      <main className="shell">
        <HealthNotice latest={latest} indexError={index.error} />
        <Outlet />
        <footer className="footer">
          <span>{NET.name}, EVM chain id {NET.evmChainId}</span>
          <a href={REPO_URL} target="_blank" rel="noreferrer">Source</a>
          <a href={`${FEED_BASE.replace("raw.githubusercontent.com", "github.com").replace("/main", "/tree/main")}`} target="_blank" rel="noreferrer">Watcher feed</a>
          <a href={`${REPO_URL}/blob/main/PROOF.md`} target="_blank" rel="noreferrer">Proof</a>
          <span className="spacer" />
          <span>Read-only: no wallet, no keys.</span>
        </footer>
      </main>
    </>
  );
}
