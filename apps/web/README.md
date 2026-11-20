# Wicketgate board

A read-only web board for Wicketgate: every rollup the watchers re-execute, each batch's verdict and post-quantum signature, the exit pool's live state, the watchers and their stake, and every instant exit.

It needs no wallet, no key and no backend. It reads three public sources straight from the browser:

| Source | What it gives |
| --- | --- |
| The watcher feed (`timix648/wicketgate-feed`, refreshed every 5 minutes) | Rollups, batches, verdicts, withdrawals, submission provenance, the pool's view of each batch |
| `ExitPool` and `WatcherRegistry` over the testnet EVM RPC (`https://evm-testnet.qore.host`) | Live pool assets, idle liquidity, outstanding advances, per-batch cover and locked stake, watcher stake and fees |
| `docs/metrics.json` on `main` | Headline figures and the list of instant exits, recomputed from chain data by `pnpm metrics` |

Contract addresses come from `deployments/diana.json` and ABIs from `packages/core/abi`, so a redeploy only needs those files updated.

## Run it

```bash
pnpm install
pnpm --filter @wicketgate/web dev      # http://localhost:5173
pnpm --filter @wicketgate/web build    # static site in apps/web/dist
```

The build uses hash routing and relative asset paths, so `dist/` can be served from any static host (GitHub Pages, Vercel, Netlify, a sub-folder) without rewrite rules.

## Pages

- **Overview**: headline numbers, time-to-funds against the normal path, the live pool, every rollup as a strip of batches, the latest batches.
- **Rollups** and **rollup detail**: lane terms, inbox, every batch with verdict, signature tier and pool status.
- **Batch detail**: roots, submission transaction, the pool's live record of the batch (confirming watchers, locked stake, contested or not), withdrawals.
- **Watchers**: every watcher seen in the feed plus the team's accounts, with live stake, locked stake and fees.
- **Instant exits**: all exits with time from batch to money against the challenge window, and repayment.

Native transaction hashes link to explore.qore.network (press **Testnet** there once). EVM hashes cannot be looked up on that explorer, so they are shown with a copy button only.
