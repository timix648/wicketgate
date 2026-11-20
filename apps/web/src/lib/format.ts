import { NET } from "./config";

const nf = (max: number) => new Intl.NumberFormat("en-GB", { maximumFractionDigits: max });

/** 18-decimal wei to a QOR string. */
export function qorFromWei(wei: bigint, digits = 4): string {
  const whole = wei / 10n ** 18n;
  const frac = Number(wei % 10n ** 18n) / 1e18;
  return nf(digits).format(Number(whole) + frac);
}

/** Rollup ledger amounts are in uQOR (6 decimals). */
export function qorFromUqor(uqor: string | number): string {
  return nf(6).format(Number(uqor) / 1e6);
}

export const num = (n: number, digits = 2) => nf(digits).format(n);

export function short(s: string, head = 6, tail = 4): string {
  if (!s || s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

export function duration(secs: number): string {
  if (secs < 90) return `${Math.round(secs)} s`;
  if (secs < 5400) return `${Math.round(secs / 60)} min`;
  if (secs < 172800) return `${num(secs / 3600, 1)} h`;
  return `${num(secs / 86400, 1)} days`;
}

export function ago(date: Date | string | number): string {
  const t = typeof date === "number" ? date : new Date(date).getTime();
  const s = (Date.now() - t) / 1000;
  if (s < 0) return "just now";
  if (s < 60) return `${Math.round(s)} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export const dateTime = (d: Date | string | number) =>
  new Date(d).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/**
 * Native (Cosmos) transactions are upper-case hex without 0x and open on the explorer.
 * EVM transactions (0x…) cannot be looked up there, so they get no link.
 */
export function explorerTx(hash: string): string | undefined {
  return /^[0-9A-F]{64}$/.test(hash) ? `${NET.explorer}/tx/${hash}` : undefined;
}
