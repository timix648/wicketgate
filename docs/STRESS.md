# Stress run: 20 instant exits against one batch

Generated 2026-11-18T20:01:49.163Z by `npx tsx packages/scripts/src/stress.ts`. 21 withdrawals were posted to `wicketgate-pay` together, batched as batch 11, re-executed and confirmed by 2 staked watchers. The pool then paid 20 of them one after another through a single EVM window.

| | |
| --- | --- |
| Instant exits paid | **20**, 100 QOR in all |
| Time for all of them | 57 s (21 per minute, one at a time from one account) |
| Median time from a withdrawal being posted to its money arriving | 94 s (one shared batch: posting, batching, two attestations, then the queue of exits) |
| Stake behind the batch (cover) | 100 QOR, of which advanced: **100 QOR** |
| One more exit of 1 QOR against the same batch | **refused: `CoverExceeded`** |
| Gas per exit | billed 450,000 each (half of the 900,000 limit sent); measured need 449,000 for the first exit (it locks stake) and 329,000 after. Exits now send 600,000 |

The pool never advances more against a batch than the stake its confirming watchers have locked behind it, and that held under load: once the cover was used up, the next exit was refused. Withdrawals beyond the cover still reach their owners through the normal path when the batch finalises.

| # | QOR | Seconds from posted to paid | Gas | Transaction |
| --- | --- | --- | --- | --- |
| 1 | 5 | 71 | 450,000 | `0x9de2721472e7d3e542ea12f88e616a67e8227239a494187899afc4719916de20` |
| 2 | 5 | 74 | 450,000 | `0x51f6d81875da63948999f3cf3b84eea4cb6eadf97b6a6fdad6cab114e0c556da` |
| 3 | 5 | 77 | 450,000 | `0x173c2f9b89ea9ae7398ac8055a7deeb81a3fb68c8840b16a3e8586ad2f869fb5` |
| 4 | 5 | 79 | 450,000 | `0xb0218036f0549dbb4c2757b2bb182b07ee252f21366333243850a70d3230d24f` |
| 5 | 5 | 82 | 450,000 | `0x2c805d77dcb4044c54c98b9a065ee4e7c6a3c236b49f0a1e74764c500e2f34a9` |
| 6 | 5 | 85 | 450,000 | `0x750fe88d18dece846761b000cae621be1c72fea47d4f4fc04e822381dcbcee90` |
| 7 | 5 | 88 | 450,000 | `0x6418cc816467073ae0b85b90119bb5e8074169e255683bd265d0fb4f2e01016e` |
| 8 | 5 | 88 | 450,000 | `0x86010cfd3ea6933621b1bb6b2c6792fadd95347d7535e8c1b2b222d30295bb51` |
| 9 | 5 | 91 | 450,000 | `0x12f8eb1f9b9c300af8c3a584bc2c58a822aead0ebfad0f53f63cd21f06487c70` |
| 10 | 5 | 94 | 450,000 | `0x97984a475924e731d5969532fa3c0448e7b6e9f4a180d281ad5adb5d41130b56` |
| 11 | 5 | 95 | 450,000 | `0x2dab5cd1bd806cc11e8f9ba79d5f49113f11fcc6a8bbd75200d995568a13c2ef` |
| 12 | 5 | 98 | 450,000 | `0xa3c37aa1a31a3e615eaecd18d8cdfc88dee8bf5431d8c3b4fdc39e82c163df77` |
| 13 | 5 | 101 | 450,000 | `0xc26d65be18bb17eba6ed88a8a4e2761433e17ac526bd547ef8f83056585fe627` |
| 14 | 5 | 104 | 450,000 | `0x6f541dab3f893a23c783f6bdc8b83540fd8a90c8915e970fc1196780d9ba9ca5` |
| 15 | 5 | 101 | 450,000 | `0x219702e1b723517bbe853a90ebcd06dd9bc3ea145abec206b094d20a258facc4` |
| 16 | 5 | 104 | 450,000 | `0xd8441fdd840b93b5dcd9274dcf5460a2c676b56068228503ac90e62020c96821` |
| 17 | 5 | 106 | 450,000 | `0xd7bf273504e059c36155d1f6df14a885a7c3a2d55b7deb6afd33e96d3766019c` |
| 18 | 5 | 109 | 450,000 | `0x9e612d2002a3103d48c41ff7aa08270c30813d8f95ecc82cdee40ba625936842` |
| 19 | 5 | 110 | 450,000 | `0x160bf40ac0779ecb1f0f2f8ebcc4e79df92c6d43815f8fd87d528db30b62a99b` |
| 20 | 5 | 112 | 450,000 | `0x46e6710ec7cb8bf4c996848029da15b3063e585eb4946dd1ee3dcbc34f209e6f` |

The two attestations that confirmed batch 11 were the first sent with the lower 560,000 gas limit: billed 340,052 and 426,441 gas (0.038 and 0.048 QOR), against 600,000 (0.0675 QOR) each before.

## Repayment

After batch 11 finalised (about 21:00 UTC), the operator's keeper executed all 20 withdrawals to their exit addresses and settled all 20 advances (state 2). The pool's outstanding balance returned to 0 and no watcher stake was slashed. The 21st withdrawal, which the stake cap kept off the instant path, was collected the normal way once the batch finalised: the chain paid its exit address (`E0FDB1CDF9920C424684240046596EB308E3F809B9D0A1F7780435734F0BEC73`) and `sweepToBeneficiary` returned the 1 QOR to its owner (`0x9efeaabc0d0f2f916570088a597571f9d67f405d3a1a90e15422ad4dec22e1f4`). So every one of the 21 withdrawals reached its owner: 20 in seconds, 1 after the window.
