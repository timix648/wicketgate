# Wicketgate in numbers

Generated 2026-11-18T09:24:11.020Z from public chain data at EVM block 10,307,699 by `npx tsx packages/scripts/src/metrics.ts`. Nothing here is typed in by hand: the script reads the event logs of all three ExitPool deployments, the RDK batch records, block times and the published watcher feed. The raw numbers are in [metrics.json](metrics.json).

![Time until the money arrives, instant exit against the normal path](images/time-to-funds.svg)

## Speed

| | |
| --- | --- |
| Instant exits paid | **7** |
| Median time from the batch reaching the chain to the money arriving | **75 s** (slowest 10 min) |
| Median time from the withdrawal request to the money arriving | **90 s** |
| Same withdrawals through the normal path (measured batch finalisation) | 60 min |
| Faster on testnet (1-hour challenge window) | **48×** |
| Faster at the RDK's default 7-day window | **8,064×** |

## Money

| | |
| --- | --- |
| QOR paid out instantly | **64 QOR** (largest single exit 50 QOR) |
| Advances whose batch has finalised | 6, of which repaid: **6** |
| Defaults | **0** |
| Losses for liquidity providers | **0 QOR** |
| Fees charged (0.3%) | 0.192 QOR |
| Median time from advance to the pool being repaid | 59.08 min |
| Median gas cost of an instant exit | 0.0318554 QOR |
| Liquidity in the live pool | 400.0123 QOR |

## Post-quantum security

| | |
| --- | --- |
| Watcher attestations whose ML-DSA-87 signature was verified on chain (`pqcVerify`) | **31**, from 2 watchers |
| Batches confirmed by a quorum of PQ-signed attestations | 15 |
| Average gas of one attestation, signature check included | 581,400 |
| Batch submissions whose ML-DSA-87 layer the watchers checked (MCP `get_pq_status`) | 45 |
| Classical signature checks (`ecrecover`) in our contracts | **0** ([CBOM](../cbom/wicketgate.cdx.json)) |

## Independent verification

| | |
| --- | --- |
| Rollups our watchers follow | **4**, of which 3 we do not run |
| Batches re-executed from chain data | **45** (45 match) |
| Wrong batches kept on record after the chain replaced them | 4 |

## Fraud

| | |
| --- | --- |
| Wrong batches submitted in the demo | 1; caught **1** |
| Time from the wrong batch to the upheld fraud proof | **5 s** (4 blocks) |
| Bond slashed | 1000 QOR: 500 burned, 500 paid to the watcher |
| Honest watchers slashed | 0 |

## Q-Day Drill (the drill account, W3)

| | |
| --- | --- |
| Watched | 2026-11-16T20:15:27.435Z to 2026-11-18T09:24:08.771Z (37.14 h, 2,203 snapshots) |
| Transactions from the drill account that were not ours | **0** |
| Drill account's stake now | 50 QOR |

## Every instant exit

| Batch | Pool | QOR | Paid after batch posted | Normal path | Repaid | Exit tx |
| --- | --- | --- | --- | --- | --- | --- |
| rdk-v328-e2e-mwd5v89d #1 | v1 | 1 | 99 s | 60 min | yes | `0x837118d20f…` |
| wicketgate-pay #1 | v1 | 1 | 36 s | 60 min | yes | `0x22c2ce760d…` |
| wicketgate-pay #6 | v1 | 50 | 72 s | 60 min | yes | `0x2b196f9005…` |
| wicketgate-pay #7 | v1 | 5 | 75 s | 60 min | yes | `0x9f40176fa3…` |
| wicketgate-pay #9 | v1 | 2 | 41 s | 60 min | yes | `0x297b3e6de1…` |
| wicketgate-pay #10 | v2.1 | 3 | 10 min | 60 min | yes | `0xa4e4fd21cc…` |
| vigil-1 #28 | v2.1 | 2 | 77 s | submitted | not due yet | `0x4e0914e372…` |
