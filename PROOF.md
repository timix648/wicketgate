# Proof

Every claim Wicketgate makes about the chain, with how to check it. Dates are UTC.

| Date | Claim | How to check |
| --- | --- | --- |
| 16 Nov 2026 | Rebuilding rollup `rdk-v328-e2e-mwd5v89d` from chain data reproduces batch 0: state root `83274dd8c1e80acbe22bb5fb8bd054f08d5c020ecea632a3b650ffe685f387a7`, withdrawals root `75482e03e14c4ad163d4d8986f1133caa3d5ce7132538af8f7df84cf14167d98`, one withdrawal of 300,000 uqor | `npx tsx packages/scripts/src/probe-replay.ts` |
| 16 Nov 2026 | That rollup's batch 1 was rejected on chain (the RDK team's own fraud test), and inbox posts 5 and 6 (first included at height 9,936,617) are still waiting for a batch | Same probe; `GET https://api-testnet.qore.host/qorechain/rdk/v1/inbox/rdk-v328-e2e-mwd5v89d` |
| 16 Nov 2026 | The `pqcVerify` precompile at `0x…0a01` returns true for an ML-DSA-87 signature over a 256-byte attestation-shaped message and false after one bit is changed; a full `eth_call` is estimated at 318,160 gas | `npx tsx packages/scripts/src/probe-pqcverify.ts` (uses an ephemeral key that is never stored) |
| 16 Nov 2026 | `pqcKeyStatus` at `0x…0a02` returns `registered, algorithmId 1, 2592-byte key, possessionProven` for a registered testnet account | Same probe |

Nothing in this repository is deployed yet. Addresses will be listed here as they are deployed.
