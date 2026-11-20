# Wicketgate web app

The board, the proof pages and the wallet for Wicketgate, plus the two queues the team's operator pulls from (the relay and the exit relay). Next.js (App Router), deployed to Vercel.

## Run it

```bash
pnpm install
pnpm --filter @wicketgate/web dev      # http://localhost:3000
pnpm --filter @wicketgate/web build
```

## Environment

None of these are needed to browse the board. Put them in `apps/web/.env.local` locally (git-ignored) and in the Vercel project settings for a deployment. Never commit them.

| Variable | For |
| --- | --- |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (or Vercel KV's `KV_REST_API_URL`, `KV_REST_API_TOKEN`) | Queue storage. Without them, `next dev` keeps the queues in memory; a production build refuses queue requests with 503 instead of losing them. |
| `OPERATOR_TOKEN` | Shared secret the operator sends as `Authorization: Bearer <token>`. Without it the operator endpoints answer 503. |

## Data the pages read

| Source | Used for |
| --- | --- |
| Watcher feed (`timix648/wicketgate-feed`, every 5 minutes) | Rollups, batches, verdicts, withdrawals, submission provenance |
| `ExitPool` / `WatcherRegistry` over `https://evm-testnet.qore.host` | Pool assets and liquidity, per-batch cover, watcher stake and fees |
| Pool and registry events from block 10,212,000, in 10,000-block chunks | Lanes (`LaneSet`), instant exits and repayments, watchers (`Joined`), attestations, activity |
| `docs/metrics.json` on `main` | Headline figures and exits from pool v1 and v2 |

Addresses come from `deployments/diana.json` and ABIs from `packages/core/abi`.

## Pages

| Route | |
| --- | --- |
| `/` | Headline numbers, time to funds, live pool, rollups, pool activity, latest batches |
| `/r`, `/r/[id]`, `/r/[id]/[batch]` | Rollups, a rollup's batches and lane terms, one batch with its live pool record |
| `/watchers` | Every registered watcher: stake, locked, fees, attestations |
| `/exits` | Every instant exit with batch-to-money time and repayment |
| `/track/[address]` | Every withdrawal and exit for a beneficiary or exit address (`0x…` or `qor1…`) |

## Queues (frontend brief, section 9)

For the app:

| | |
| --- | --- |
| `POST /api/relay` `{ rollupId, tx }` | `tx` is the hex of `encodeQledgerTx`. Decoded and signature-checked for `qorechain-diana` / `rollupId`, at most 6 KiB, at most 10 a minute per rollup account; the same transaction twice returns the same id. → `{ queued: true, id }` |
| `GET /api/relay/{id}` | `{ status: "queued" \| "posted" \| "failed", txHash?, error? }` |
| `POST /api/exit` `{ rollupId, beneficiary, salt, amountUqor }` | Shapes checked, the rollup must have an enabled pool lane (read on chain), at most 10 a minute per beneficiary; one request per (beneficiary, salt). → `{ queued: true, id, exitAddr }` |
| `GET /api/exit/{id}` | `{ status: "queued" \| "paid" \| "failed", txHash?, error?, exitAddr? }` |

For the operator (`RELAY_URL` = `https://<deployment>/api/operator`, bearer token required):

| | |
| --- | --- |
| `GET {RELAY_URL}/pending?rollupId=<id>` | `[{ id, rollupId, tx }]`, oldest first, up to 100 |
| `POST {RELAY_URL}/done` `{ id, txHash?, error? }` | `txHash` marks it posted, `error` marks it failed |
| `GET {RELAY_URL}/exits/pending?rollupId=<id>` | `[{ id, rollupId, beneficiary, salt, amountUqor }]` |
| `POST {RELAY_URL}/exits/done` `{ id, status, txHash?, error? }` | `paid` needs `txHash`, `failed` needs `error` |

Native transaction hashes link to explore.qore.network (press **Testnet** there once). EVM hashes cannot be looked up on that explorer, so they are shown with a copy button only.
