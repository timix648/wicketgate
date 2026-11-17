// One swap in the native AMM from ADMIN_A (QOR -> fUSD in pool 2), hybrid-signed.
// Usage: pnpm swap [uqorIn] [poolId]
import { account } from "@wicketgate/core/env";
import { sendNative, explorerTx, restGet } from "@wicketgate/core/chain";
async function main() {
  const amount = process.argv[2] ?? "1000000";
  const poolId = process.argv[3] ?? "2";
  const A = await account("ADMIN_A");
  const { body } = await restGet<any>(`/qorechain/amm/v1/pools/${poolId}`);
  const p = body.pool;
  const denomOut = p.token_a === "uqor" ? p.token_b : p.token_a;
  const q = await restGet<any>(`/qorechain/amm/v1/quote/exact_in?pool_id=${poolId}&denom_in=uqor&amount_in=${amount}&denom_out=${encodeURIComponent(denomOut)}`);
  const expected = BigInt(q.body?.amount_out ?? q.body?.token_out?.amount ?? 0);
  if (expected === 0n) throw new Error(`no quote from the pool: ${JSON.stringify(q.body).slice(0, 200)}`);
  const minOut = expected > 0n ? (expected * 97n) / 100n : 1n; // 3% slippage
  const r = await sendNative(A, [{ typeUrl: "/qorechain.amm.v1.MsgSwapExactIn", value: { sender: A.cosmos, poolId, tokenIn: { denom: "uqor", amount }, denomOut, minOut: minOut.toString() } }], { gas: 400_000 });
  console.log(`swapped ${Number(amount) / 1e6} QOR for ${denomOut} in pool ${poolId} (quoted ${expected}, min ${minOut}): ${explorerTx(r.transactionHash)}`);
}
main().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
