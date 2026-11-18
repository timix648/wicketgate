# Limits

What Wicketgate does not do, or does not do yet. Kept current; dates are UTC. Last reviewed 18 November 2026, against pool v2.1.

## Open

- **Testnet only.** The `pqcVerify` and `pqcKeyStatus` precompiles are inactive on QoreChain mainnet, so the contracts fail closed there: no attestation, admin action or watcher join can pass. Every post-quantum check goes through one library (`contracts/src/lib/PQGuard.sol`), so nothing else changes when the precompiles go live.
- **Testnet economics.** The fee is a flat 0.3% and the quorum is 2. Watcher stake is W1 190 QOR, W2 500 QOR and W3 (the drill account) 50 QOR. Each confirming watcher locks 50 QOR per batch advanced against on `wicketgate-pay`, 20 QOR on `vigil-1` and 8 QOR on `rdk-v328-e2e-mwd5v89d`. The fee does not yet rise with pool utilisation; a utilisation-based fee is the next economic change.
- **The watchers that sign today are ours.** W1 and W2 are run by the team, so a quorum of 2 is the team vouching for a batch with its own stake. The design does not depend on this (anyone with a proven ML-DSA-87 key and stake can join, and one dissenting watcher freezes payouts on a batch), but no outside watcher has joined yet.
- **Not audited.** The contracts have 38 Foundry tests, 4 invariants over random action sequences (a deep run on 18 November: 1,000 runs of 128 random actions, 128,000 calls, every invariant held), on-chain probes, and a red team of 18 attacks replayed against the live contracts ([docs/REDTEAM.md](docs/REDTEAM.md)). No external audit.
- **The pool cannot see rollup state.** The EVM cannot read `x/rdk`, so the pool learns that a batch was wrong only when an advanced exit address is not funded by its due time; then the confirming watchers' locked stake repays the pool. Watchers who confirm a wrong batch that nobody exits against are not slashed by the pool (the submitter still is, by the chain's fraud proof). A read-only precompile for RDK batch status would close this; see "What we learned" in the README.
- **Withdrawals to 32-byte addresses** cannot be exited instantly; they are left out of the exit tree and take the normal path.
- **Keepers are not paid.** Settling a repaid advance, writing off an unpaid one, releasing stake and sweeping are open to anyone, and on 18 November a collector that is not bonded on `vigil-1` repaid the pool for an exit from that rollup a minute after its batch finalised (see PROOF.md). Nobody is paid to do it yet, so in practice the team's operator does it.
- **The relay is run by the team.** It cannot forge or alter users' transactions, and users can always post to a based rollup's inbox themselves, but the convenience path depends on the team's server being up.
- **Notes hide content only** (see THREAT_MODEL.md, section 7).

## Resolved

| Date | Was | Now |
| --- | --- | --- |
| 16 Nov 2026 | The team did not hold a submitter bond, so our transactions waited in the organiser's rollup inbox | ADMIN_A bonded 1,000 QOR and submitted batch 1 of `rdk-v328-e2e-mwd5v89d`, the first batch by anyone but its creator |
| 16 Nov 2026 | Our own rollup needed about 13,000 QOR | `wicketgate-pay` launched, with every batch anchored by the creator's ML-DSA-87 key |
| 16 Nov 2026 | Stake was locked when a batch was confirmed, even if nobody exited against it | Pool v2: stake is locked only when an exit is advanced |
| 16 Nov 2026 | Watchers attested batches that had already finalised (a withdrawal could have been advanced after the chain paid it) | Pool v2.1: watchers attest only batches in their window, and the pool refuses `AlreadyPaid`; plus virtual shares against share inflation |
| 18 Nov 2026 | A rate-limited REST read could cut a watcher's scan short or read as an empty balance | Requests are spaced and retried; a failed read is an error, never a zero |
| 18 Nov 2026 | Watchers sent attestations with a 1,200,000 gas limit; the chain bills at least half the limit, so each vote paid for 600,000 gas while using 340,000 to 426,000 | The limit is 560,000, which cuts the cost of a vote by about a third (from 0.0675 QOR) |
