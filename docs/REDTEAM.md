# Red team: 18 of 18 attacks refused

Generated 2026-11-20T10:54:01.290Z at EVM block 10,428,845 by `npx tsx packages/scripts/src/redteam.ts` (no key needed, about 30 s).

Each attack is an `eth_call` against the live ExitPool v2.1 (`0xc5350ba167a5ac3c3302859ab8b0c8f792ff8b9a`) and WatcherRegistry (`0x0d3e791d4b71f57ab95f501e60a8572b9cab20ad`) on diana, from an address with no role (`0xbad0000000000000000000000000000000000bad`) or from a real watcher's address. Where timing matters, it runs against the chain's state at the exact block of a real exit, so the batch is confirmed and its challenge window is open, as it would be for a live attacker. The signatures, facts, proofs and salts are the real ones, read back from these transactions: the 3 QOR exit [`0xa4e4fd21cc…`], the vigil-1 exit [`0x4e0914e372…`], a watcher attestation [`0xbae9d8f17c…`] and a two-admin `setLane` [`0x279aed1dae…`].

| # | Attack | Who | Against the state at | Refused by |
| --- | --- | --- | --- | --- |
| A1 | A stranger attests a batch | attacker | now | ✅ `NotWatcher` |
| A2 | Forge a watcher's ML-DSA-87 signature (a quantum attacker who has the address but not the key) | a real watcher's address | now | ✅ `BadSignature` |
| A3 | Replay a watcher's real signature on another batch | a real watcher's address | now | ✅ `BadSignature` |
| A4 | Replay a watcher's real signature with different facts (a fake exit root) | a real watcher's address | now | ✅ `BadSignature` |
| A5 | A watcher votes twice on the same batch | a real watcher's address | now | ✅ `AlreadyVoted` |
| A6 | Exit against a batch nobody has verified | attacker | now | ✅ `NotConfirmed` |
| A7 | Exit with forged facts (the attacker's own exit tree) | attacker | block 10213994 (batch confirmed, window open) | ✅ `WrongFacts` |
| A8 | Invent a 300 QOR withdrawal in a verified batch | attacker | block 10213994 | ✅ `BadProof` |
| A9 | Front-run a real exit and redirect it to the attacker | attacker | block 10213994 | ✅ `BadProof` |
| A10 | Take the same exit twice (replay the real exit call) | attacker | block 10213995 (right after it was paid) | ✅ `ExitUsed` |
| A11 | Exit after the challenge window closed | the real beneficiary | now | ✅ `TooLate` |
| A12 | Write off an advance early to slash the watchers | attacker | block 10305609 (vigil-1 exit just paid) | ✅ `NotDue` |
| A13 | Free the watchers' stake while an advance is open | attacker | block 10305609 | ✅ `NotDue` |
| A14 | Mark an unpaid advance as repaid | attacker | block 10305609 | ✅ `NotFunded` |
| A15 | Sweep an exit address while the pool's advance on it is open | attacker | block 10305609 | ✅ `StillOpen` |
| A16 | Withdraw liquidity the attacker never deposited | attacker | now | ✅ `Panic(17)` |
| A17 | Raise the fee to 10% by replaying both admins' real signatures on a changed lane | attacker | block 10213433 (signatures still within their deadline) | ✅ `BadSignature` |
| A18 | Slash a watcher's stake directly in the registry | attacker | now | ✅ `NotPool` |

**Controls.** The honest version of each kind of call, at the same blocks, is accepted, so every refusal above is the named check doing its job and not the harness failing:

| # | Honest call | At | Result |
| --- | --- | --- | --- |
| C1 | The real 3 QOR exit, by its real sender | block 10213994 | ✅ accepted |
| C2 | The real attestation, by its watcher | block 10213574 | ✅ accepted |
| C3 | The real two-admin setLane, unchanged | block 10213433 | ✅ accepted |

What the refusals mean:

- **A2 to A4, A17:** every authorisation is an ML-DSA-87 signature checked on chain by the `pqcVerify` precompile, over a message bound to the chain, this pool, the rollup, the batch and the exact facts (or, for admin actions, the action, its payload, a nonce and a deadline). A signature cannot be forged without the key, even by an attacker with a quantum computer, and a real one cannot be moved to another batch, other facts, or a changed lane.
- **A6 to A11:** the pool pays only against a batch that a quorum of staked watchers re-executed and signed, only for a withdrawal that is a leaf of the exit tree they signed, only to the exit address the rollup's withdrawal names, only once, and only while the chain can still repay it.
- **A12 to A15:** nobody can slash the watchers, unlock their stake or take the repayment before the batch has had its full window plus grace.
- **A16, A18:** liquidity and stake only move through the pool's own accounting.

The same properties are tested with random sequences of actions in `contracts/test/Invariants.t.sol` (see [PROOF.md](../PROOF.md)).
