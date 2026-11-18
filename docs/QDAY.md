# Q-Day, simulated on chain

Generated 2026-11-18T18:15:05.575Z on the `qorechain-diana` testnet. Re-run from `packages/scripts`: `qday-crack.ts qor1wx8dg096gw9e6uy4u4nc0vc44dpnjq7vlc88v0`, `qday-attack.ts closed`, `qday-routine.ts open`, `qday-attack.ts open`, `qday-routine.ts close`.

## The setup

One watcher, **W4** (`0x718Ed43CBA438b9d7095e56787B315ab433903cc`), guards two pools with the same keys. Its secp256k1 key is a 40-bit number, weak on purpose: it stands in for what Shor's algorithm will do to every secp256k1 key once a large enough quantum computer exists. Its ML-DSA-87 key comes from a separate 256-bit secret. W4 is a staked watcher in Wicketgate's live registry (5 QOR) and the watcher of ClassicalTwin (10 QOR of liquidity). The two pools differ only in how they check a watcher's signature:

| | ClassicalTwin ([contracts/demo/ClassicalTwin.sol](../contracts/demo/ClassicalTwin.sol), demo only) | Wicketgate ExitPool v2.1 |
| --- | --- | --- |
| Watcher signature | secp256k1, checked with `ecrecover` (as most bridges and fast-exit pools today) | ML-DSA-87, checked with the `pqcVerify` precompile |
| Address | `0x8340ff2736de1f358313038ccdd6cc11a0ab2f2c` | `0xc5350ba167a5ac3c3302859ab8b0c8f792ff8b9a` |

## Step 1: the key falls

The attacker read W4's public key from `GET /cosmos/auth/v1beta1/accounts/qor1wx8dg096gw9e6uy4u4nc0vc44dpnjq7vlc88v0` (every account that has signed a transaction has published it) and recovered the private key with baby-step giant-step in **49 s** on one CPU core ([qday-crack.ts](../packages/scripts/src/qday-crack.ts)). Nothing else in this simulation is simulated.

## Step 2: W4's EVM window closed. QoreChain stops the stolen key

| Target | Attempt | Layer | Result |
| --- | --- | --- | --- |
| W4's funds | Move W4's balance to the attacker, signed with the stolen secp256k1 key only | QoreChain: hybrid signatures | **refused**: Broadcasting transaction failed with code 20 (codespace: pqc). Log: account qor1wx8dg096gw9e6uy4u4nc0vc44dpnjq7vlc88v0 has a registered PQC key and must include the hybrid signature extension (hybrid  |
| W4's funds | The same, with an ML-DSA-87 signature from a guessed key | QoreChain: hybrid signatures | **refused**: Broadcasting transaction failed with code 21 (codespace: pqc). Log: PQC signature verification failed for qor1wx8dg096gw9e6uy4u4nc0vc44dpnjq7vlc88v0: hybrid PQC signature verification failed |
| W4's funds | Open an EVM window for W4 with the stolen key | QoreChain: hybrid signatures | **refused**: Broadcasting transaction failed with code 20 (codespace: pqc). Log: account qor1wx8dg096gw9e6uy4u4nc0vc44dpnjq7vlc88v0 has a registered PQC key and must include the hybrid signature extension (hybrid  |
| W4's stake | requestLeave from W4, an EVM transaction signed with the stolen key | QoreChain: EVM windows | **refused**: failed to broadcast transaction: account qor1wx8dg096gw9e6uy4u4nc0vc44dpnjq7vlc88v0 has no open EVM authorisation window; open one with MsgOpenEVMWindow, signed on the Cosmos lane with the account's p |
| ClassicalTwin | Confirm an invented batch in the twin with W4's stolen signature (submitted by the attacker) | QoreChain: ecrecover outside a window | **refused**: reverted: NotWatcher |
| Wicketgate | Attest the invented batch in W4's name in ExitPool (submitted by the attacker) | Wicketgate: ML-DSA-87 via pqcVerify | **refused**: reverted: NotWatcher |

The twin refusal is not only an `eth_call`: on the first run, while W4's window was closed, the attacker's real attestation and drain transactions to ClassicalTwin both reverted on chain (drain `0x9bd76db94c2e75c139983d4ac9f756ecc1d4a1f81cd05ad0b83626ed1ee599d0`), because `ecrecover` returned no signer for W4.

With no window open, QoreChain alone protects even the classical contract: an account with a registered post-quantum key must hybrid-sign native transactions, needs a window (opened only by a hybrid-signed message) for any EVM transaction, and, since v3.2.8, its `ecrecover` signatures count only for contracts its live window admits.

## Step 3: W4's routine window open. The classical pool falls, Wicketgate does not

A watcher has to open windows to work: Wicketgate's own watchers open one scoped to the pool every round they attest. W4 opened its routine window with its real ML-DSA-87 key, scoped to the two pools it watches. While it is open, the chain lets the stolen classical key through to those contracts:

| Target | Attempt | Layer | Result |
| --- | --- | --- | --- |
| ClassicalTwin | Confirm the invented batch with W4's stolen signature, then exit the twin's whole balance to the attacker | ecrecover inside W4's window | **ACCEPTED**: 10 QOR stolen. attest 0x96222ef7f2626bbabf0b2899bed98357292a18a3d2838a6f52d609df175622b3, drain 0x1fe3b0a98f3227a900cc695d1b0c5e79435151decb2b77f4c6f58f82464cd8ef |
| Wicketgate | Attest the invented batch as W4 itself, a real EVM transaction inside W4's window, signed with the stolen key | Wicketgate: ML-DSA-87 via pqcVerify | **refused**: reverted on chain: BadSignature(0x718Ed43CBA438b9d7095e56787B315ab433903cc) (0x5bdd09e7d012623971f05e943e88e6f8a16b33d3812f1d72e14dae7141142ccf) |
| W4's stake | requestLeave from W4 inside its window (the registry is not in the window's scope) | QoreChain: window scope | **refused**: failed to broadcast transaction: the EVM authorisation window for qor1wx8dg096gw9e6uy4u4nc0vc44dpnjq7vlc88v0 does not admit this transaction: the window does not list 0x0d3e791d4b71f57Ab95f501E60A8572 |

| | Before | After |
| --- | --- | --- |
| ClassicalTwin liquidity | 10 QOR | **0 QOR** |
| Wicketgate pool assets | 400.0105 QOR | **400.0105 QOR** |
| W4's stake in Wicketgate | 5 QOR | 5 QOR |
| W4's balance | 6.608125 QOR | 6.574375 QOR: the attacker can make W4 pay gas for transactions inside its window, up to the window's spending cap (here 0.5 QOR) |

## What this shows

1. **QoreChain's protections are real**: with the window closed, the stolen key could not move W4's funds, open a window, touch its stake, or pass `ecrecover`.
2. **They are bounded by the window**: a window is how an account uses the EVM at all, and while it is open the classical key is enough for the contracts it admits. A pool that trusts `ecrecover` is then only as safe as its watchers' secp256k1 keys.
3. **Wicketgate does not depend on the window being closed**: every attestation and admin action is an ML-DSA-87 signature checked inside the contract by `pqcVerify`, so the stolen classical key gets nowhere even with the window open. There is no `ecrecover` in Wicketgate's contracts ([CBOM](../cbom/wicketgate.cdx.json)).
