# Limits

What Wicketgate does not do, or does not do yet. Kept current; dates are UTC.

- **Testnet only.** The `pqcVerify` and `pqcKeyStatus` precompiles are inactive on QoreChain mainnet, so the contracts would fail closed there.
- **Toy economics.** Watcher stake (10 QOR), stake locked per confirmation (8 QOR), fee (0.3%) and quorum (2) are testnet values chosen so the flows can be shown, not tuned for real value.
- **Not audited.** The contracts have Foundry tests and on-chain probes, not an external audit.
- **The pool cannot see rollup state.** The EVM cannot read `x/rdk`, so the pool learns that a batch was wrong only when an advanced exit address is not funded by its due time. Watchers who confirm a wrong batch that nobody exits against are not slashed by the pool (the submitter still is, by the chain's fraud proof).
- **Withdrawals to 32-byte addresses** cannot be exited instantly; they are left out of the exit tree and take the normal path.
- **Batching needs a bond.** On 16 November the team does not yet hold the 1,000 QOR submitter bond; our deposit, transfer and exit withdrawal are waiting in the inbox of `rdk-v328-e2e-mwd5v89d`.
- **Our own rollup** needs about 13,000 QOR (stake, layer registration, bonds), requested from the organiser. Until then the settlement-receipt flow is shown on the organiser's rollup, whose anchors are signed by its creator, not by us.
- **Relay and operator are run by the team.** They cannot forge or alter users' transactions, and users can always post to the inbox directly, but the convenience path depends on the team's server being up.
- **Notes hide content only** (see THREAT_MODEL.md, section 7).
- **Stake is locked at confirmation.** `ExitPool` locks each confirming watcher's stake when a batch reaches quorum, even if nothing is ever advanced against it. Watchers therefore attest on chain only batches that carry withdrawals that could be exited instantly; batches without one are still re-executed and reported in the feed. A later version of the pool should lock stake only when the first advance is made.

