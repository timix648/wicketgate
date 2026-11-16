# Wicketgate threat model

What Wicketgate protects, who might attack it, what they can do, and why the damage is bounded. It describes the code in this repository as deployed on the `qorechain-diana` testnet (addresses in [deployments/diana.json](deployments/diana.json)).

## What is at stake

| Asset | Where it lives |
| --- | --- |
| Liquidity providers' QOR | `ExitPool` balance (about 400 QOR on 16 Nov) |
| Watchers' stake | `WatcherRegistry` balance (740 QOR on 16 Nov: W1 190, W2 500, W3 50) |
| Users' rollup funds | the rollup's deposit pool, under the chain's own `x/rdk` rules |
| Users' withdrawals in flight | exit addresses, until swept to the pool or to the beneficiary |
| Admin settings | lanes (window, grace, fee, quorum, stake per watcher) and registry parameters |

## Assumptions

- The QoreChain testnet's consensus, the `x/rdk` module (re-execution of fraud proofs, withdrawal payouts) and the `pqcVerify` / `pqcKeyStatus` precompiles behave as documented. Bugs in them are out of scope.
- ML-DSA-87 (FIPS 204) is not broken. secp256k1 **may** be: that is the point of the Q-Day Drill.
- At least one honest watcher is online for each rollup (the "honest minority" assumption every optimistic rollup makes). Section 4 says what happens if not.
- Each account's post-quantum key is derived from its recovery phrase (`deriveUnifiedAccount`), not from its classical key. Knowing the classical private key gives no information about the post-quantum key.

## 1. An attacker who holds an account's classical (ECDSA) key

This is the Q-Day Drill scenario. The drill account is watcher W3 (`0xAC82Ffe5610f14d09eF451E5c71254Be9164cc88`).

| Attempt | Result | Why |
| --- | --- | --- |
| Native transfer of the account's QOR | Refused by the chain | Every native transaction must also carry an ML-DSA-87 signature from the registered key |
| Open an EVM authorisation window | Refused by the chain | Opening a window is a native message and needs the same hybrid signature |
| EVM transfer or contract call | Refused by the chain | No window is open: every Wicketgate account closes its window straight after use |
| Token approvals, permits | Refused by the chain | Same: no window. From v3.2.8 a contract-verified signature also needs the verifying contract inside the window |
| `WatcherRegistry.requestLeave` / `leave` (take the stake) | Refused | Needs an EVM transaction from the watcher itself, so a window |
| `ExitPool.attest` as the watcher | Refused | Needs an ML-DSA-87 signature over the batch facts, checked on chain against the key the chain holds |
| Admin functions (`setPool`, `setParams`, `setLane`) | Refused | Need ML-DSA-87 signatures from **both** admin accounts; `msg.sender` authorises nothing |
| `ExitPool.withdraw` (provider funds) | Refused | Needs pool shares; the drill account holds none |

**For the drill:** W3 holds 50 QOR of stake in the registry; no Wicketgate service uses W3, so its window stays closed; the drill-proof transaction is a native, hybrid-signed deposit into our rollup, so it needs no window either; and a monitor records W3's balance, sequence, window and stake every minute and alerts the team on any change we did not make. Its log is published after the drill.

The worst a stolen classical key can do while a window **is** open is what that window allows. Wicketgate opens windows scoped to the one contract it calls, for one to a few transactions, for at most a few hundred blocks, with a value cap of gas plus the exact value being sent, and closes them in a `finally` block.

## 2. A submitter publishes a wrong batch

- Every watcher re-executes the batch from inbox entries read back from block history and checked against the chain's own inbox accumulator. It does not trust the submitter or any node's state root.
- A watcher whose roots differ does not attest, so the batch is never confirmed and **the pool advances nothing against it**.
- In `challenge` mode the watcher builds the fraud proof with the RDK, checks it locally with `checkQledgerFraud`, and sends `MsgChallengeBatch`. The chain re-executes the batch: on an upheld challenge it rejects the batch and every batch built on it, rolls the inbox back, and slashes the submitter's **whole** bond, half burned, half to the challenger.
- The watcher never builds its own state on top of a batch that failed re-execution.

## 3. Watchers lie

| Case | What happens | Bound |
| --- | --- | --- |
| A quorum of watchers attests a wrong batch and users exit against it | The pool pays the exits; the batch is later rejected, so the exit addresses are never funded | `markDefault` after the due time repays the pool from the confirming watchers' locked stake. **Advances against a batch never exceed the stake locked behind it**, so providers are made whole even if every confirming watcher colluded |
| One watcher attests different facts from the others | The batch is marked **contested**; no more advances against it | One honest staked watcher is enough to stop the pool paying on a disputed batch |
| A watcher attests facts that disagree, to grief the pool | Fast exits on that batch stop | Liveness only: no funds move. Users fall back to the normal withdrawal and `sweepToBeneficiary` |
| A watcher replays an attestation for another batch, rollup, pool or network | Refused | The signed message binds chain id, pool address, rollup key, batch index and all three roots |
| A watcher rotates its post-quantum key | Old signatures stop verifying | The contract reads the current key when it verifies; past confirmations are stored as results, not signatures |
| A watcher leaves to escape a pending default | Refused | Leaving takes effect after a delay and only when none of its stake is locked |

## 4. Nobody watches

If no honest watcher is running, a wrong batch can finalise and the chain will pay its false withdrawals. This is the base risk of every optimistic rollup; Wicketgate exists to reduce it, not to remove it. What it adds is visibility: the board shows how many independent watchers verified each batch, and anyone can run a watcher in observe mode with one command and no key.

## 5. The instant exit itself

| Threat | Why it fails |
| --- | --- |
| Someone else calls `instantExit` for a user's withdrawal | The exit address is derived from the beneficiary and a salt, and the leaf binds the exit address, so the payout can only go to the beneficiary. A third party who calls it only pays the gas |
| Exiting the same withdrawal twice | One advance per exit address and per `(batch, withdrawal index)` |
| A forged or stretched exit proof | The leaf binds index, exit address and amount; the proof is checked against the exit root the watchers signed |
| Late repayment after a default | `settle` still works on a defaulted advance and credits the slashed watchers back |
| The pool runs dry | `instantExit` refuses; the user waits for finalisation and calls `sweepToBeneficiary` |
| Funds stuck at an exit address | `sweepToBeneficiary` deploys the exit contract and sends the whole balance to the beneficiary whenever no open advance points at it (checked on diana: see PROOF.md) |
| Re-entrancy during payouts | Every function that moves value is guarded by a re-entrancy lock |

## 6. Operator and relay

| Threat | Why it is bounded |
| --- | --- |
| The relay refuses a user's transaction | The rollup is based: anyone may post to its inbox directly with `MsgPostRollupData` |
| The relay alters a transaction | Impossible: ledger transactions are signed by the user's ML-DSA-44 ledger key; the operator only checks and forwards them |
| The operator stops batching | Any bonded account can submit batches on a based `qledger-v1` rollup; the board shows a stalled inbox |
| Data withheld | Inbox entries are transactions in main-chain blocks; their commitments are kept for 648,000 blocks |

## 6b. Exit to another chain over IBC

| Threat | Why it is bounded |
| --- | --- |
| The relayer stops, so the IBC packet is never delivered | The transfer carries a 15-minute timeout; after it, the chain refunds the sender on QoreChain. Funds are delayed, never lost |
| The counterparty credits the wrong address | The receiver is derived from the beneficiary's own secp256k1 key (`ripemd160(sha256(pubkey))`), so only the beneficiary controls it |
| Wicketgate adds IBC risk to the pool | It does not: the pool pays the beneficiary on QoreChain first; the IBC leg is the beneficiary's own transfer and the pool takes no part in it |

## 7. Privacy

Payment notes are sealed to the recipient with ML-KEM-1024 (QoreSeal). That hides their content only. Who paid whom, how much, when, and the size of each envelope remain public.

## Out of scope

Bugs in the chain, the precompiles or the kits; mainnet (the precompiles are inactive there); economic tuning of stake, fees and quorum for real value; denial of service against the public endpoints. Stakes on testnet are toy values.
