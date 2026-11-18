// Watches the drill account (W3) and the registered contracts once a minute and keeps a log:
// W3's balance, account sequence, EVM window, stake in the registry, and the pool's and registry's
// holdings. Any change not made by us is reported on Telegram (owner's chat) and logged.
// Usage: pnpm drill:monitor [until-ISO]   (log: ~/.wicketgate/drill/monitor.jsonl)
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Address } from "viem";
import { fetchEvmWindow } from "@qorechain/sdk";
import { account, DEPLOYMENTS_FILE, NET, STATE_DIR } from "@wicketgate/core/env";
import { accountSeq, balanceUqor } from "@wicketgate/core/chain";
import { artifact, publicClient } from "@wicketgate/core/evm";

const UNTIL = new Date(process.argv[2] ?? "2026-11-19T23:59:00Z").getTime();
const DIR = join(STATE_DIR, "drill");
const LOG = join(DIR, "monitor.jsonl");
const OURS = join(DIR, "our-txs.txt"); // sequences we used on purpose (the drill proof)

function alert(text: string) {
  try {
    const env = Object.fromEntries(readFileSync("/opt/opportunity-hunter/.env", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => {
      const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }));
    execFileSync("curl", ["-sS", "-m", "30", "--form-string", `chat_id=${env.TELEGRAM_CHAT_ID}`, "--form-string", `text=${text}`,
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`], { stdio: "ignore" });
  } catch {}
}

async function snapshot() {
  const w = await account("W3");
  const dep = JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8"));
  const R = artifact("WatcherRegistry").abi, P = artifact("ExitPool").abi;
  const [bal, seq, win, st, poolAssets, regBal] = await Promise.all([
    balanceUqor(w.cosmos),
    accountSeq(w.cosmos),
    fetchEvmWindow({ rest: NET.rest, address: w.cosmos }),
    publicClient.readContract({ address: dep.registry as Address, abi: R, functionName: "watchers", args: [w.evm] }) as Promise<any[]>,
    publicClient.readContract({ address: dep.pool as Address, abi: P, functionName: "totalAssets", args: [] }) as Promise<bigint>,
    publicClient.getBalance({ address: dep.registry as Address }),
  ]);
  return {
    t: new Date().toISOString(), w3BalanceUqor: bal.toString(), w3Sequence: seq?.sequence ?? null,
    w3WindowOpen: Boolean(win.found && win.live), w3Stake: (st[0] as bigint).toString(), w3Active: st[3],
    poolAssetsWei: poolAssets.toString(), registryBalanceWei: regBal.toString(),
  };
}

async function main() {
  mkdirSync(DIR, { recursive: true });
  let prev = await snapshot();
  appendFileSync(LOG, JSON.stringify({ ...prev, note: "start" }) + "\n");
  alert(`Wicketgate drill monitor started. W3 stake ${Number(prev.w3Stake) / 1e18} QOR, window open: ${prev.w3WindowOpen}, pool ${Number(prev.poolAssetsWei) / 1e18} QOR`);
  while (Date.now() < UNTIL) {
    await new Promise((r) => setTimeout(r, 60_000));
    let s;
    try {
      s = await snapshot();
      if (s.w3Sequence === null) throw new Error("W3 account unreadable");
    } catch (e: any) {
      // a failed read is "unknown", never "zero": log it and compare again next minute
      appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), unknown: String(e?.message ?? e) }) + "\n");
      continue;
    }
    const ours = (() => { try { return readFileSync(OURS, "utf8").split("\n").filter(Boolean).map(Number); } catch { return []; } })();
    const changes: string[] = [];
    if (s.w3WindowOpen) changes.push("W3 HAS AN OPEN EVM WINDOW");
    if (s.w3Stake !== prev.w3Stake || s.w3Active !== prev.w3Active) changes.push(`W3 stake ${Number(prev.w3Stake) / 1e18} -> ${Number(s.w3Stake) / 1e18} QOR (active ${s.w3Active})`);
    if (s.w3Sequence !== prev.w3Sequence && !(s.w3Sequence !== null && ours.includes(s.w3Sequence))) changes.push(`W3 sequence ${prev.w3Sequence} -> ${s.w3Sequence} (a transaction from W3 we did not send?)`);
    if (BigInt(s.w3BalanceUqor) < BigInt(prev.w3BalanceUqor) && !(s.w3Sequence !== null && ours.includes(s.w3Sequence))) changes.push(`W3 balance fell ${Number(prev.w3BalanceUqor) / 1e6} -> ${Number(s.w3BalanceUqor) / 1e6} QOR`);
    if (BigInt(s.registryBalanceWei) < BigInt(prev.registryBalanceWei)) changes.push(`registry holdings fell ${Number(prev.registryBalanceWei) / 1e18} -> ${Number(s.registryBalanceWei) / 1e18} QOR`);
    appendFileSync(LOG, JSON.stringify({ ...s, changes }) + "\n");
    if (changes.length) alert(`Wicketgate drill monitor: ${changes.join("; ")}`);
    prev = s;
  }
  alert("Wicketgate drill monitor finished. Log: ~/.wicketgate/drill/monitor.jsonl");
}
main().catch((e) => { console.error(e?.message ?? e); process.exitCode = 1; });
