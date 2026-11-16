// End to end, timed: withdraw from the wicketgate-pay rollup, take the instant exit from the
// ExitPool once the watchers confirm the batch, then forward the payout over IBC to the
// beneficiary's own address on another chain (default: Osmosis testnet, channel-1).
// Usage: pnpm exit:chain [QOR] [channel] [prefix] [counterparty-lcd]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { account, NET, STATE_DIR } from "@wicketgate/core/env";
import { sendNative, explorerTx, restGet } from "@wicketgate/core/chain";
import { counterpartyAddress } from "./probe-ibc.js";

const QOR = process.argv[2] ?? "5";
const CHANNEL = process.argv[3] ?? "channel-1";
const PREFIX = process.argv[4] ?? "osmo";
const LCD = process.argv[5] ?? "https://lcd.osmotest5.osmosis.zone";
const EXITS = join(STATE_DIR, "exits.json");
const here = new URL(".", import.meta.url).pathname;
const run = (script: string, ...args: string[]) =>
  execFileSync("npx", ["tsx", join(here, script), ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s`;

async function main() {
  const A = await account("ADMIN_A");
  const receiver = counterpartyAddress(A.publicKey, PREFIX);
  console.log(`${at()} withdrawing ${QOR} QOR from wicketgate-pay; destination ${receiver} over ${CHANNEL}`);
  process.stdout.write(run("seed-ledger.ts", "wicketgate-pay", QOR));
  const exit = JSON.parse(readFileSync(EXITS, "utf8")).at(-1);

  // wait until the instant exit can be taken (batched, attested by two watchers, confirmed)
  let exitOut = "";
  for (let i = 0; i < 60; i++) {
    exitOut = run("exit.ts");
    if (exitOut.includes("instantExit: success")) break;
    await sleep(10_000);
  }
  const m = exitOut.match(/instantExit: success (0x[0-9a-f]+)/);
  if (!m) throw new Error("the exit was not taken within 10 minutes:\n" + exitOut);
  console.log(`${at()} instant exit paid by the pool: ${m[1]}`);

  // forward the payout (amount less the 0.3% fee) over IBC
  const payoutUqor = (BigInt(exit.amountUqor) * 9970n) / 10000n;
  const before = await lcdBalance(receiver);
  const r = await sendNative(A, [{
    typeUrl: "/ibc.applications.transfer.v1.MsgTransfer",
    value: {
      sourcePort: "transfer", sourceChannel: CHANNEL, token: { denom: "uqor", amount: payoutUqor.toString() },
      sender: A.cosmos, receiver, timeoutHeight: { revisionNumber: 0n, revisionHeight: 0n },
      timeoutTimestamp: BigInt(Date.now() + 15 * 60_000) * 1_000_000n, memo: "wicketgate instant exit",
    },
  }], { gas: 400_000 });
  console.log(`${at()} IBC transfer of ${Number(payoutUqor) / 1e6} QOR sent: ${explorerTx(r.transactionHash)}`);
  for (let i = 0; i < 90; i++) {
    const now = await lcdBalance(receiver);
    if (now > before) {
      console.log(`${at()} ARRIVED on ${PREFIX}: ${receiver} balance of QOR vouchers ${before} -> ${now}`);
      console.log(`total: ${((Date.now() - t0) / 1000).toFixed(0)} s from posting the withdrawal to funds on the other chain; the normal exit alone takes 3,600 s on testnet and 7 days by default`);
      return;
    }
    await sleep(5_000);
  }
  console.log("not seen on the counterparty within 7.5 minutes (relayer slow or counterparty LCD lagging)");
}

async function lcdBalance(addr: string): Promise<bigint> {
  const res = await fetch(`${LCD}/cosmos/bank/v1beta1/balances/${addr}`, { headers: { "User-Agent": "wicketgate" } });
  const d: any = await res.json().catch(() => ({}));
  return (d.balances ?? []).filter((b: any) => String(b.denom).startsWith("ibc/")).reduce((s: bigint, b: any) => s + BigInt(b.amount), 0n);
}
main().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
