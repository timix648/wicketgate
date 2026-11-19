# The Q-Day Drill, 18 November 2026

On 18 November, from 00:00 to 23:59 UTC, the organisers' bot played an attacker who had recovered the **classical (ECDSA) private key** of our drill account and tried everything that key alone can do: native transfers, opening EVM windows, EVM transfers, token approvals and drain calls on the two contracts we registered.

| | |
| --- | --- |
| Drill account | **W3**: `qor14jp0letppu2dp8h528juwyj5h6gkfnygclxrhf` / `0xAC82Ffe5610f14d09eF451E5c71254Be9164cc88`, a Wicketgate watcher with 50 QOR staked |
| Contracts registered for attack | WatcherRegistry `0x0d3e791d4b71f57ab95f501e60a8572b9cab20ad`, ExitPool `0xc5350ba167a5ac3c3302859ab8b0c8f792ff8b9a` (pool v2.1) |
| Our proof transaction | [ACEEC3FD…5446](https://explore.qore.network/tx/ACEEC3FD18F02DFCFCAB626CB247371CCAD15EC91BD4CC2B8FD3BCABB6495446), 08:00:45 UTC, hybrid-signed, code 0; accepted on the project page |
| Attack log | Not yet published by the organisers (checked 19 Nov). The rules say it is published after the drill; we will link it here when it is |

## What our monitor saw

A monitor ([`drill-monitor.ts`](../../packages/scripts/src/drill-monitor.ts)) read W3's account, its EVM window, its stake and both contracts' holdings every minute. The full day is in [monitor-2026-11-18.jsonl](monitor-2026-11-18.jsonl): 1,427 snapshots, 1,423 readable (4 failed reads, logged as unknown, never as zero).

| | 00:00 UTC | 23:59 UTC | Why it changed |
| --- | --- | --- | --- |
| W3 balance | 64.547021 QOR | 64.457021 QOR | Our own proof transaction's fee (0.09 QOR). **Value kept: 99.86%** |
| W3 sequence (transactions it sent) | 22 | 23 | Our proof, the only transaction W3 sent all day |
| W3 EVM window | closed | closed | Never opened, all day |
| W3 stake in the registry | 50 QOR | 50 QOR | Unchanged |
| Registry holdings | 740 QOR | 745 QOR | Another of our watchers (W4) joined with 5 QOR for the Q-Day simulation ([QDAY.md](../QDAY.md)) |
| ExitPool assets | 400.0063 QOR | 400.2205 QOR | Fees from our own instant exits, including the 20-exit stress run ([STRESS.md](../STRESS.md)) |

**Successful attacks: 0.** Every change in the table is ours. One alert at 08:48 was a failed read (the public REST endpoint rate-limited a request and the old monitor read it as a zero balance); the next read a minute later was normal, and failed reads have been logged as unknown since.

## What the attacker could not do, and why

Holding only W3's classical key:

| Attempt | Refused by |
| --- | --- |
| Move W3's QOR with a native transaction | QoreChain: an account with a registered ML-DSA-87 key must hybrid-sign; the classical signature alone is refused |
| Open an EVM window for W3 | QoreChain: opening a window is a native message, so it needs the ML-DSA-87 half too |
| Send any EVM transaction from W3 (transfer, approval, `requestLeave` to start taking the stake out) | QoreChain: no EVM transaction from W3 is accepted without an open window |
| Sign as W3 in a contract that uses `ecrecover` | QoreChain (v3.2.8): a PQC account's `ecrecover` signature counts only for contracts its live window admits, and W3's window stayed closed |
| Attest a batch in W3's name, or drain the pool or the registry | Wicketgate: every attestation and admin action is an ML-DSA-87 signature checked on chain by `pqcVerify`; red-team attacks A1 to A4 and A18 ([REDTEAM.md](../REDTEAM.md)) show a forged or replayed signature from a watcher's address is refused |

We then ran the same attack against ourselves on purpose, with a key we broke from its public key, and measured what changes when a window *is* open: [QDAY.md](../QDAY.md).

## After the drill

W3 stays out of every Wicketgate service: it runs no watcher, operator or keeper and signs nothing. The monitor keeps watching it until 2 December 23:59 UTC; anything that happens to W3 or its stake before then will show in the log.
