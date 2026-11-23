// The Wicketgate liquidity agent. It manages an AgentVault's QOR across every pool that pays
// instant exits (Wicketgate's main pool and each LaneHub lane), inside limits the chain enforces:
// it can only move money between recognised pools, never above the owner's per-pool cap, and every
// move carries its ML-DSA-87 signature, checked on chain by pqcVerify. It sends through a QoreChain
// EVM window scoped to the vault alone. Each round it writes its reasoning to decisions.jsonl.
//   Policy: skip paused pools and pools with a contested batch in the lookback; score the rest by
//   the liquidity providers' fee yield over the lookback (weighted by how much history there is: full
//   weight after 7 days) plus a small bonus for recent activity;
//   keep 10% idle; spread the rest by score, capped by the vault; move only on drift > 1 QOR.
// Usage: npx tsx src/agent.ts [--once] [--interval-min 30] [--dry-run]
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, toHex, type Address, type Hex } from "viem";
import { account, STATE_DIR } from "@wicketgate/core/env";
import { artifact, closeWindow, openWindow, pqSign, publicClient, walletFor, windowBudget, withAccountLock } from "@wicketgate/core/evm";

const ROOT = new URL("../../../", import.meta.url);
const V = JSON.parse(readFileSync(new URL("deployments/agentvault.json", ROOT), "utf8"));
const HUB = JSON.parse(readFileSync(new URL("deployments/lanehub.json", ROOT), "utf8"));
const P = artifact("ExitPool").abi, H = artifact("LaneHub").abi, AV = artifact("AgentVault").abi;
const args = process.argv.slice(2);
const ONCE = args.includes("--once"), DRY = args.includes("--dry-run");
const INTERVAL_MIN = Number(args[args.indexOf("--interval-min") + 1] || 30);
const LOOKBACK_BLOCKS = 200_000n; // about three days at testnet block times
const IDLE_BPS = 1000n, MIN_MOVE = 10n ** 18n, QOR = 1e18;
const LOG_DIR = join(STATE_DIR, "agent");
const log = (m: string) => console.log(`${new Date().toISOString()} [agent] ${m}`);

async function logs(address: Address, eventName: string, from: bigint, to: bigint) {
  const out: any[] = [];
  for (let f = from; f <= to; f += 10_000n) {
    const t = f + 9_999n < to ? f + 9_999n : to;
    out.push(...(await publicClient.getContractEvents({ address, abi: P, eventName, fromBlock: f, toBlock: t } as any)));
  }
  return out;
}

async function candidates() {
  const list: { pool: Address; label: string; rollupId?: string }[] = [{ pool: V.mainPool, label: "Wicketgate main pool" }];
  const opened = await publicClient.getContractEvents({ address: HUB.hub, abi: H, eventName: "LaneOpened", fromBlock: BigInt(HUB.deployBlock) } as any);
  for (const e of opened as any[]) list.push({ pool: e.args.pool, label: `${e.args.rollupId} lane`, rollupId: e.args.rollupId });
  return list;
}

async function assess() {
  const latest = await publicClient.getBlockNumber();
  const from = latest > LOOKBACK_BLOCKS ? latest - LOOKBACK_BLOCKS : 0n;
  const out = [];
  for (const c of await candidates()) {
    const lookFrom = c.rollupId ? BigInt(HUB.deployBlock) : from;
    const [assets, idle, paused, exits, contested, confirmed, recognised] = await Promise.all([
      publicClient.readContract({ address: c.pool, abi: P, functionName: "totalAssets" }) as Promise<bigint>,
      publicClient.readContract({ address: c.pool, abi: P, functionName: "idleLiquidity" }) as Promise<bigint>,
      publicClient.readContract({ address: c.pool, abi: P, functionName: "paused" }) as Promise<boolean>,
      logs(c.pool, "InstantExit", lookFrom, latest),
      logs(c.pool, "BatchContestedEvt", lookFrom, latest),
      logs(c.pool, "BatchConfirmed", lookFrom, latest),
      publicClient.readContract({ address: V.vault, abi: AV, functionName: "recognised", args: [c.pool] }) as Promise<boolean>,
    ]);
    const fees = exits.reduce((t: bigint, e: any) => t + BigInt(e.args.feeWei ?? 0n), 0n);
    const lpFees = (fees * 6000n) / 10_000n;
    const days = Number(latest - lookFrom) * 1.4 / 86400 || 1;
    const yieldPct = assets > 0n ? (Number(lpFees) / Number(assets)) * (365 / days) * 100 : 0;
    const healthy = recognised && !paused && contested.length === 0;
    // a yield from a few hours of history is mostly noise: trust it in proportion to the history, full weight after 7 days
    const confidence = Math.min(1, days / 7);
    const score = healthy ? yieldPct * confidence + Math.min(exits.length, 5) * 0.5 + Math.min(confirmed.length, 5) * 0.2 + 0.1 : 0;
    const position = (await publicClient.readContract({ address: V.vault, abi: AV, functionName: "positionWei", args: [c.pool] })) as bigint;
    const shares = (await publicClient.readContract({ address: c.pool, abi: P, functionName: "shares", args: [V.vault] })) as bigint;
    out.push({ ...c, assets, idle, paused, recognised, exits: exits.length, contested: contested.length, confirmed: confirmed.length, yieldPct, score, position, shares,
      why: !recognised ? "not recognised by the vault" : paused ? "paused" : contested.length ? `${contested.length} contested batch(es)` : `yield ${yieldPct.toFixed(2)}%/yr over ${days.toFixed(1)} days (weight ${(confidence * 100).toFixed(0)}%), ${exits.length} exits, ${confirmed.length} confirmed batches` });
  }
  return out;
}

async function round() {
  const pools = await assess();
  const total = (await publicClient.readContract({ address: V.vault, abi: AV, functionName: "totalValueWei" })) as bigint;
  const cap = BigInt((await publicClient.readContract({ address: V.vault, abi: AV, functionName: "maxPerPoolBps" })) as number);
  const deployable = (total * (10_000n - IDLE_BPS)) / 10_000n;
  const scored = pools.filter((p) => p.score > 0).sort((a, b) => b.score - a.score);
  const sum = scored.reduce((t, p) => t + p.score, 0);
  const capWei = (total * cap) / 10_000n - 10n ** 15n; // stay just under the cap: fees move values between blocks
  const target = new Map<string, bigint>();
  let left = deployable;
  for (const p of scored) {
    const want = BigInt(Math.floor((Number(deployable) * p.score) / sum));
    const t = want > capWei ? capWei : want > left ? left : want;
    target.set(p.pool, t);
    left -= t;
  }
  const moves: { action: "allocate" | "release"; pool: Address; amount: bigint; label: string; reason: string }[] = [];
  for (const p of pools) {
    const t = target.get(p.pool) ?? 0n;
    if (p.position > t + MIN_MOVE) {
      const releaseWei = p.position - t;
      const sh = (p.shares * releaseWei) / (p.position || 1n);
      moves.push({ action: "release", pool: p.pool, amount: sh > p.shares ? p.shares : sh, label: p.label, reason: `${p.why}; holding ${(Number(p.position) / QOR).toFixed(2)} QOR, target ${(Number(t) / QOR).toFixed(2)}` });
    }
  }
  for (const p of scored) {
    const t = target.get(p.pool) ?? 0n;
    if (t > p.position + MIN_MOVE) moves.push({ action: "allocate", pool: p.pool, amount: t - p.position, label: p.label, reason: `${p.why}; target ${(Number(t) / QOR).toFixed(2)} QOR` });
  }
  const decision = { at: new Date().toISOString(), vault: V.vault, totalQor: Number(total) / QOR, pools: pools.map((p) => ({ label: p.label, pool: p.pool, score: +p.score.toFixed(3), positionQor: +(Number(p.position) / QOR).toFixed(4), why: p.why })), moves: moves.map((m) => ({ ...m, amount: m.amount.toString() })) as any[] };
  for (const p of decision.pools) log(`${p.label.padEnd(24)} score ${String(p.score).padStart(6)}  holds ${p.positionQor} QOR  (${p.why})`);
  if (!moves.length) log("no move: allocation within 1 QOR of target");

  if (moves.length && !DRY) {
    const agent = await account("AGENT");
    await withAccountLock(agent, async () => {
      await openWindow(agent, { blocks: 300, maxTxs: moves.length, maxValueUqor: await windowBudget(moves.length, 1_500_000n), allowedTargets: [V.vault] });
      try {
        const w = walletFor(agent);
        for (const m of moves) {
          const nonce = (await publicClient.readContract({ address: V.vault, abi: AV, functionName: "agentNonce" })) as bigint;
          const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
          const msg = (await publicClient.readContract({ address: V.vault, abi: AV, functionName: "agentMessage", args: [toHex(m.action, { size: 32 }), m.pool, m.amount, nonce, deadline] })) as Hex;
          const hash = await w.writeContract({ address: V.vault, abi: AV, functionName: m.action, args: [m.pool, m.amount, deadline, pqSign(agent, msg)], gas: 1_500_000n } as any);
          const rc = await publicClient.waitForTransactionReceipt({ hash });
          (m as any).tx = hash;
          (m as any).status = rc.status;
          log(`${m.action} ${m.action === "allocate" ? (Number(m.amount) / QOR).toFixed(3) + " QOR to" : "shares from"} ${m.label}: ${rc.status} ${hash} (ML-DSA-87 signed, nonce ${nonce})`);
        }
      } finally {
        await closeWindow(agent);
      }
    });
    decision.moves = moves.map((m) => ({ ...m, amount: m.amount.toString() }));
  }
  mkdirSync(LOG_DIR, { recursive: true });
  appendFileSync(join(LOG_DIR, "decisions.jsonl"), JSON.stringify(decision) + "\n");
  return decision;
}

for (;;) {
  await round().catch((e) => log(`round failed: ${e?.shortMessage ?? e?.message ?? e}`));
  if (ONCE) break;
  await new Promise((r) => setTimeout(r, INTERVAL_MIN * 60_000));
}
