// Alerts to a human, for the moments a watchtower must never be silent about: when it cannot verify
// a rollup (it is blind), and when it finds a batch whose roots are wrong.
//
// Why: on 19 Nov 2026 a wrapped post blinded every reference-RDK watcher on wicketgate-pay for an
// hour, and a fraudulent batch finalised unchallenged inside that hour. The chain's fraud check
// covers both the state and the withdrawals root, so a watcher that could see would have rejected
// it; the failure was silence. With alerts, a blind watcher calls for help within minutes, while
// the challenge window is still open.
//
// Opt-in: alerts are sent only when WICKETGATE_ALERTS=1 and Telegram credentials are found, in
// TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID or in the env file named by WICKETGATE_ALERT_ENV. The same
// alert key is sent at most once per WICKETGATE_ALERT_REPEAT_S (default 30 minutes). Never throws.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const REPEAT_MS = Number(process.env.WICKETGATE_ALERT_REPEAT_S ?? 1800) * 1000;
const lastSent = new Map<string, number>();

function creds(): { token: string; chat: string } | undefined {
  if (process.env.WICKETGATE_ALERTS !== "1") return undefined;
  let token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  const file = process.env.WICKETGATE_ALERT_ENV;
  if ((!token || !chat) && file && existsSync(file)) {
    const env = Object.fromEntries(readFileSync(file, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")];
    }));
    token ??= env.TELEGRAM_BOT_TOKEN;
    chat ??= env.TELEGRAM_CHAT_ID;
  }
  return token && chat ? { token, chat } : undefined;
}

/**
 * Send `text` unless the same `key` was sent within the repeat interval. `persist` names a JSON file
 * that remembers keys across restarts (for one-off events such as "batch 12 is fraudulent").
 */
export async function alert(key: string, text: string, persist?: string): Promise<boolean> {
  try {
    const now = Date.now();
    if (persist) {
      const seen: Record<string, number> = existsSync(persist) ? JSON.parse(readFileSync(persist, "utf8")) : {};
      if (seen[key]) return false;
      seen[key] = now;
      writeFileSync(persist, JSON.stringify(seen, null, 2));
    } else {
      if (now - (lastSent.get(key) ?? 0) < REPEAT_MS) return false;
      lastSent.set(key, now);
    }
    console.log(`${new Date().toISOString()} ALERT ${key}: ${text}`);
    const c = creds();
    if (!c) return false;
    const res = await fetch(`https://api.telegram.org/bot${c.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: c.chat, text: `Wicketgate: ${text}` }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
