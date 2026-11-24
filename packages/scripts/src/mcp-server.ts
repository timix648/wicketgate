// Wicketgate MCP server: QoreChain's own MCP server (@qorechain/mcp: blocks, accounts, contracts,
// hybrid ML-DSA-87 status, simulation) with Wicketgate's tools added, so an AI agent or assistant can
// inspect the instant-exit market and plan liquidity moves. Read-only: it never holds a key and never
// signs; moves are made by the AgentVault's own agent, whose ML-DSA-87 signature the chain checks.
//   stdio:  npx tsx src/mcp-server.ts
//   Claude Code: claude mcp add wicketgate -- npx tsx /path/to/packages/scripts/src/mcp-server.ts
import { readFileSync } from "node:fs";
import { createServer } from "@qorechain/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { keccak256, toHex, type Address } from "viem";
import { artifact, getEventsChunked, publicClient } from "@wicketgate/core/evm";

const ROOT = new URL("../../../", import.meta.url);
const dep = (f: string) => JSON.parse(readFileSync(new URL(`deployments/${f}`, ROOT), "utf8"));
const MAIN = dep("diana.json"), HUB = dep("lanehub.json"), VAULT = dep("agentvault.json");
const P = artifact("ExitPool").abi, H = artifact("LaneHub").abi, AV = artifact("AgentVault").abi;
const FEED = "https://raw.githubusercontent.com/timix648/wicketgate-feed/main";
const qor = (wei: bigint) => Number(wei) / 1e18;
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) }] });
const read = <T>(address: Address, functionName: string, args: unknown[] = [], abi: any = P) => publicClient.readContract({ address, abi, functionName, args }) as Promise<T>;

async function pools() {
  const out: { pool: Address; label: string; rollupId?: string }[] = [{ pool: MAIN.pool, label: "Wicketgate main pool (all its lanes)" }];
  const ev = await getEventsChunked({ address: HUB.hub, abi: H, eventName: "LaneOpened", fromBlock: BigInt(HUB.deployBlock) });
  for (const e of ev as any[]) out.push({ pool: e.args.pool, label: `LaneHub lane for ${e.args.rollupId}`, rollupId: e.args.rollupId });
  return out;
}

const server = createServer({ defaultNetwork: "testnet" });

server.registerTool("wicketgate_list_lanes", {
  title: "List instant-exit pools",
  description: "Every pool that pays instant exits on QoreChain testnet: Wicketgate's main pool and each permissionless LaneHub lane, with liquidity, idle liquidity, paused state and the exits it has paid.",
  inputSchema: {},
}, async () => {
  const rows = [];
  for (const p of await pools()) {
    const [assets, idle, paused, exits] = await Promise.all([read<bigint>(p.pool, "totalAssets"), read<bigint>(p.pool, "idleLiquidity"), read<boolean>(p.pool, "paused"),
      getEventsChunked({ address: p.pool, abi: P, eventName: "InstantExit", fromBlock: BigInt(p.rollupId ? HUB.deployBlock : MAIN.deployBlock) })]);
    const fees = (exits as any[]).reduce((t, e) => t + BigInt(e.args.feeWei ?? 0n), 0n);
    rows.push({ ...p, liquidityQor: qor(assets), idleQor: qor(idle), paused, exitsPaid: (exits as any[]).length, feesQor: qor(fees), lpEarnedQor: qor((fees * 6000n) / 10000n) });
  }
  return ok({ hub: HUB.hub, note: "Fees split 60% liquidity providers, 30% watchers, 10% keepers.", pools: rows });
});

server.registerTool("wicketgate_quote_exit", {
  title: "Quote an instant exit",
  description: "What each pool serving a rollup would charge for an instant exit of the given amount, and which is cheapest and able to pay now (the wallet routes to that one).",
  inputSchema: { rollupId: z.string().describe("Rollup id, e.g. wicketgate-pay"), amountQor: z.number().positive() },
}, async ({ rollupId, amountQor }) => {
  const key = keccak256(toHex(rollupId));
  const wei = BigInt(Math.round(amountQor * 1e6)) * 10n ** 12n;
  const opts = [];
  for (const p of await pools()) {
    if (p.rollupId && p.rollupId !== rollupId) continue;
    const lane = await read<any[]>(p.pool, "lanes", [key]);
    if (!lane[5]) continue;
    const [bps, risk, idle, paused] = await Promise.all([read<bigint>(p.pool, "feeBpsFor", [key, wei]), read<any[]>(p.pool, "risk", [key]), read<bigint>(p.pool, "idleLiquidity"), read<boolean>(p.pool, "paused")]);
    const fee = (wei * bps) / 10000n + BigInt(risk[4]);
    const canPay = !paused && fee < wei && wei - fee <= idle && (BigInt(risk[2]) === 0n || wei <= BigInt(risk[2]));
    opts.push({ pool: p.pool, label: p.label, feeQor: qor(fee), payoutQor: qor(wei - fee), canPayNow: canPay });
  }
  opts.sort((a, b) => Number(b.canPayNow) - Number(a.canPayNow) || a.feeQor - b.feeQor);
  return ok({ rollupId, amountQor, best: opts.find((o) => o.canPayNow) ?? null, options: opts });
});

server.registerTool("wicketgate_batch_verdict", {
  title: "Watcher verdict for a batch",
  description: "Wicketgate's watchers re-execute every qledger-v1 rollup batch on QoreChain. Returns the verdict (match, mismatch, rejected-on-chain) and the roots for one batch, from the public watcher feed.",
  inputSchema: { rollupId: z.string(), batchIndex: z.number().int().nonnegative() },
}, async ({ rollupId, batchIndex }) => {
  const feed: any = await (await fetch(`${FEED}/${encodeURIComponent(rollupId)}.json`)).json().catch(() => null);
  const b = feed?.batches?.find((x: any) => x.index === batchIndex);
  if (!b) return ok({ rollupId, batchIndex, found: false });
  return ok({ rollupId, batchIndex, found: true, verdict: b.verdict, stateRoot: b.stateRoot, withdrawalsRoot: b.withdrawalsRoot, withdrawals: (b.withdrawals ?? []).length, generatedAt: feed.generatedAt });
});

server.registerTool("wicketgate_vault_status", {
  title: "AgentVault status",
  description: "The AI-managed liquidity vault: total value, idle QOR, its position in each pool, its policy (agent, per-pool cap, paused) and the agent's move count. The chain only lets the agent move money between recognised pools, under the cap, with its ML-DSA-87 signature.",
  inputSchema: {},
}, async () => {
  const [total, cap, paused, agent, nonce, idle] = await Promise.all([read<bigint>(VAULT.vault, "totalValueWei", [], AV), read<number>(VAULT.vault, "maxPerPoolBps", [], AV), read<boolean>(VAULT.vault, "agentPaused", [], AV), read<Address>(VAULT.vault, "agent", [], AV), read<bigint>(VAULT.vault, "agentNonce", [], AV), publicClient.getBalance({ address: VAULT.vault })]);
  const positions = [];
  for (const p of await pools()) {
    const v = await read<bigint>(VAULT.vault, "positionWei", [p.pool], AV);
    if (v > 0n) positions.push({ label: p.label, pool: p.pool, qor: qor(v) });
  }
  return ok({ vault: VAULT.vault, owner: VAULT.owner, agent, totalQor: qor(total), idleQor: qor(idle), maxPerPoolPct: Number(cap) / 100, agentPaused: paused, agentMoves: nonce, positions });
});

await server.connect(new StdioServerTransport());
