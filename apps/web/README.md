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
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | Optional. RainbowKit asks for one, but QoreX is an injected wallet and WalletConnect is never used. |

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
| `/wallet` | Connect QoreX, create or restore the rollup account, deposit, send, withdraw instantly, follow each exit |
| `/proof`, `/qday`, `/redteam`, `/stress`, `/fraud` | The proof pages, built from the committed evidence files (`docs/*.json`, `deployments/demo-timeline.json`) |
| `/pool` | Live pool, your liquidity in the live and previous pool, share value over time from `Deposited` / `Withdrawn` events; deposit and withdraw (EVM calls, which QoreX cannot send yet: the page says so) |
| `/receipt` | Verify a published or pasted settlement receipt against the chain (`POST /api/receipt/verify`, server-side because QoreChain's REST and RPC send no CORS headers), and watch a forged copy fail |

## End-to-end tests

`pnpm --filter @wicketgate/web build`, then `pnpm --filter @wicketgate/web e2e` (Playwright, Chromium). The wallet test injects `@qorechain/qorex-wallet-mock` and answers the relay and exit endpoints itself; all tests read the public testnet. CI runs them in the `web-e2e` job.

## Wallet (frontend brief, section 8.6)

Who signs what:

| Step | Signed by |
| --- | --- |
| Deposit into a rollup | the user's QoreX wallet: `MsgDepositToRollup` through `window.qorex.native.signAndBroadcast` (hybrid secp256k1 + ML-DSA-87) |
| Transfer, withdrawal | the app's own rollup key, posted through `/api/relay` |
| Instant exit | the backend's exit relay (`/api/exit`); the payout is locked to the user's EVM address, so the user signs nothing on EVM |

The rollup key is a fresh 32-byte seed from `crypto.getRandomValues`, turned into an ML-DSA-44 account with `qledgerKeypairFromSeed`. It is never derived from the wallet and never sent anywhere. Only the seed is stored, in IndexedDB, encrypted with AES-GCM under a key from the user's passphrase (PBKDF2-SHA-256, 600,000 iterations); the account id is bound in as associated data. Each withdrawal's salt and exit address are saved before anything leaves the browser and are part of the backup file (`{ version: 1, rollupId, accountId, encryptedSeed, kdf, salt, iv, exits }`), which also restores the account.

Before a withdrawal the wallet shows the fee and payout from `feeBpsFor` and the lane's keeper tip, and refuses when the pool is paused, the exit is over the pool's limit or liquidity is short. Once the withdrawal is batched it shows the exact `quote(rollupKey, batchIndex, amount)` until the exit relay reports `paid` or `failed`.

Balances: the wallet reads an optional `accounts` list (`{ id, balance, nonce }` per rollup account after the last re-executed batch) from the watcher feed. Until the feed publishes it, the wallet shows an estimate from this browser's own activity and signs with its locally tracked nonce.

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
