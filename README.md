# Wicketgate

[![Built on QoreChain](https://build.qorechain.io/badge/wicketgate.svg)](https://build.qorechain.io/p/wicketgate)

**Instant exits for QoreChain rollups, backed by watchers with stake on the line.**

A wicket gate is the small door cut into a large castle gate: people pass through it without waiting for the main gate to open. Wicketgate does that for rollup withdrawals.

> Built for Build Before Q-Day, the QoreChain Developer Fest (category: Protocol Builders). Testnet only (`qorechain-diana`). Work in progress.

## The problem

An optimistic rollup only pays a withdrawal after its challenge window: one hour on the QoreChain testnet, seven days by the chain's default. Nothing on QoreChain today checks rollup batches independently, and nothing pays an exit early.

## How it works

1. **Watchers** rebuild a rollup's ledger from chain data alone and re-execute every batch with the RDK's `qledger-v1` executor.
2. A watcher that gets the same roots **signs an attestation with its ML-DSA-87 key** and calls `ExitPool.attest`. The contract checks the signature on chain through the `pqcVerify` precompile, against the key the chain holds for that watcher (`pqcKeyStatus`, with proof of possession required).
3. When enough staked watchers agree, the batch is confirmed and **each confirming watcher locks stake behind it**.
4. A user withdraws to an exit address computed in advance. The pool pays them at once, minus a small fee, **never more than the stake locked behind that batch**.
5. When the batch finalises, the chain pays the exit address and the pool collects it.
6. If the batch is wrong: watchers refuse to sign, **a single watcher that attests different facts freezes payouts on that batch**, and a watcher sends the fraud proof that slashes the submitter. If an exit is never repaid, the confirming watchers' stake repays the pool.

## Status (16 November 2026)

| Piece | State |
| --- | --- |
| Watcher replay | Works against the live testnet: rebuilds batch 0 of the only rollup on diana and matches both roots |
| `pqcVerify` from contracts | Probed on the live testnet: accepts a real ML-DSA-87 signature, rejects a changed byte |
| Contracts (`WatcherRegistry`, `ExitPool`, `ExitAddress`, `Directory`, `MemoBoard`) | Deployed on diana (addresses in [deployments/diana.json](deployments/diana.json)); admin actions verified by two ML-DSA-87 signatures on chain; 3 watchers staked; 31 Foundry tests |
| Watcher (`packages/watcher`) | Running on diana: two watchers re-execute every batch every 30 s, attest matching batches on chain and challenge wrong ones; batch 0 of the organiser's rollup is confirmed in the pool by both |
| Own rollup `wicketgate-pay` | Live: anchored batches, instant exits, and a fraud proof that slashed a bad submitter (see PROOF.md) |
| Operator (`packages/operator`) | Running on both rollups: batches the inbox, pays withdrawals behind instant exits and settles them |
| Wallet and board | In progress (frontend) |

Evidence for every claim is in [PROOF.md](PROOF.md). The threat model is in [THREAT_MODEL.md](THREAT_MODEL.md) and the known limits in [LIMITS.md](LIMITS.md). How AI was used, and what the team decided, is in [AI_USAGE.md](AI_USAGE.md).

## Run the probes

```bash
pnpm install
cd packages/scripts
npx tsx src/probe-replay.ts            # rebuild a rollup from chain data and compare roots
npx tsx src/probe-pqcverify.ts         # check the ML-DSA-87 verify precompile with eth_call
cd ../../contracts && forge test       # contract tests
```

## Run a watcher

```bash
cd packages/watcher
npx tsx src/cli.ts --mode observe --rollup rdk-v328-e2e-mwd5v89d --feed ./feed     # needs no key
```

Observe mode rebuilds the rollup from chain data and writes verdicts and exit proofs to `./feed/<rollup>.json`. `--mode attest` and `--mode challenge` also sign and send attestations and fraud proofs; they need a staked watcher account.

Neither probe needs a key or funds.

## Built with

QoreChain kits: [`@qorechain/rdk`](https://www.npmjs.com/package/@qorechain/rdk) 0.9.0, [`@qorechain/sdk`](https://www.npmjs.com/package/@qorechain/sdk) 0.14.0, [`@qorechain/pqc`](https://www.npmjs.com/package/@qorechain/pqc) 0.2.3. Also [viem](https://viem.sh) and [Foundry](https://getfoundry.sh) with [forge-std](https://github.com/foundry-rs/forge-std).

## Licence

Apache-2.0. See [LICENSE](LICENSE).
