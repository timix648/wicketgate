"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NET, REPO_URL, FEED_BASE } from "../lib/config";
import { useIndex, usePool } from "../lib/queries";
import { ago } from "../lib/format";

type Theme = "system" | "light" | "dark";

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => {
    try {
      const saved = localStorage.getItem("wg-theme") as Theme | null;
      if (saved) setTheme(saved);
    } catch {}
  }, []);
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

interface NavLinkDef { href: string; label: string; hint?: string }
interface NavGroup { label: string; links: NavLinkDef[] }

/** Three groups instead of ten links: what is being watched, the exits it pays, and the evidence. */
const NAV_GROUPS: NavGroup[] = [
  {
    label: "Network",
    links: [
      { href: "/r", label: "Rollups", hint: "Every rollup and batch, re-executed" },
      { href: "/watchers", label: "Watchers", hint: "Who vouches for batches, with what stake" },
      { href: "/lanes", label: "Lanes", hint: "Instant-exit pools, one per rollup" },
      { href: "/pool", label: "Pool", hint: "Liquidity behind the main lane" },
    ],
  },
  {
    label: "Exits",
    links: [
      { href: "/exits", label: "Instant exits", hint: "Every exit paid and repaid" },
      { href: "/track", label: "Track an exit", hint: "Follow any address's withdrawals" },
    ],
  },
  {
    label: "Proof",
    links: [
      { href: "/proof", label: "All proof", hint: "Every test, with its transactions" },
      { href: "/qday", label: "Q-Day, on chain" },
      { href: "/redteam", label: "Red team" },
      { href: "/stress", label: "Stress run" },
      { href: "/fraud", label: "Fraud caught" },
      { href: "/receipt", label: "Receipt checker" },
    ],
  },
];

const isActive = (href: string, pathname: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`));

function NavMenu({ group, pathname, open, onToggle }: { group: NavGroup; pathname: string; open: boolean; onToggle: () => void }) {
  const active = group.links.some((l) => isActive(l.href, pathname));
  return (
    <div className="menu">
      <button className={`menu-btn${active ? " active" : ""}`} aria-expanded={open} aria-haspopup="true" onClick={onToggle}>
        {group.label} <span aria-hidden="true" className="caret">▾</span>
      </button>
      {open && (
        <div className="menu-panel" role="menu">
          {group.links.map((l) => (
            <Link key={l.href} href={l.href} role="menuitem" className={isActive(l.href, pathname) ? "active" : undefined}>
              <span>{l.label}</span>
              {l.hint && <small>{l.hint}</small>}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function MobileNav({ pathname, onClose }: { pathname: string; onClose: () => void }) {
  return (
    <div className="mobile-nav" role="dialog" aria-label="Menu">
      <Link href="/" className={isActive("/", pathname) ? "active" : undefined} onClick={onClose}>Overview</Link>
      {NAV_GROUPS.map((g) => (
        <div key={g.label} className="mobile-group">
          <div className="mobile-label">{g.label}</div>
          {g.links.map((l) => (
            <Link key={l.href} href={l.href} className={isActive(l.href, pathname) ? "active" : undefined} onClick={onClose}>{l.label}</Link>
          ))}
        </div>
      ))}
      <Link href="/wallet" className="btn" onClick={onClose}>Open the wallet</Link>
    </div>
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

export function Shell({ children }: { children: ReactNode }) {
  const [theme, nextTheme] = useTheme();
  const index = useIndex();
  const pathname = usePathname() ?? "/";
  const latest = index.data?.rollups.map((r) => r.updatedAt).sort().at(-1);
  const [openMenu, setOpenMenu] = useState<string>();
  const [mobileOpen, setMobileOpen] = useState(false);
  // close menus on navigation, on Escape and on a click outside them
  useEffect(() => {
    setOpenMenu(undefined);
    setMobileOpen(false);
  }, [pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (setOpenMenu(undefined), setMobileOpen(false));
    const onClick = (e: MouseEvent) => !(e.target as HTMLElement).closest?.(".menu") && setOpenMenu(undefined);
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
    };
  }, []);

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <Link href="/" className="brand">
            <Logo /> Wicketgate
          </Link>
          <nav className="nav" aria-label="Main">
            <Link href="/" className={`nav-link${isActive("/", pathname) ? " active" : ""}`} aria-current={isActive("/", pathname) ? "page" : undefined}>Overview</Link>
            {NAV_GROUPS.map((g) => (
              <NavMenu key={g.label} group={g} pathname={pathname} open={openMenu === g.label} onToggle={() => setOpenMenu((o) => (o === g.label ? undefined : g.label))} />
            ))}
          </nav>
          <div className="topbar-right">
            {latest && (
              <span className="feed-age" title={`Watcher feed updated ${new Date(latest).toLocaleString()}`}>
                <span className="live-dot" /> feed {ago(latest)}
              </span>
            )}
            <button className="icon-btn" onClick={nextTheme} title="Switch theme" aria-label={`Theme: ${theme}`}>
              {theme === "system" ? "Auto" : theme === "dark" ? "Dark" : "Light"}
            </button>
            <Link href="/wallet" className={`btn btn-sm wallet-cta${isActive("/wallet", pathname) ? " active" : ""}`}>Wallet</Link>
            <button className="icon-btn menu-toggle" aria-expanded={mobileOpen} aria-label="Menu" onClick={() => setMobileOpen((v) => !v)}>
              {mobileOpen ? "Close" : "Menu"}
            </button>
          </div>
        </div>
        {mobileOpen && <MobileNav pathname={pathname} onClose={() => setMobileOpen(false)} />}
      </header>
      <main className="shell">
        <HealthNotice latest={latest} indexError={index.error} />
        {children}
        <footer className="footer">
          <span>{NET.name}, EVM chain id {NET.evmChainId}</span>
          <a href={REPO_URL} target="_blank" rel="noreferrer">Source</a>
          <a href={FEED_BASE.replace("raw.githubusercontent.com", "github.com").replace("/main", "/tree/main")} target="_blank" rel="noreferrer">Watcher feed</a>
          <a href={`${REPO_URL}/blob/main/PROOF.md`} target="_blank" rel="noreferrer">Proof</a>
          <span className="spacer" />
          <Link href="/proof">Proof pages</Link>
          <Link href="/receipt">Check a receipt</Link>
        </footer>
      </main>
    </>
  );
}
