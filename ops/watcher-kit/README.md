# Watcher kit: run an independent Wicketgate watcher

This runs a Wicketgate watcher on **your own machine, with your own key**. The team's watchers (W1, W2, W5) all run on one server, so a watcher on separate hardware run by someone else means the quorum no longer rests on one box.

The watcher finds every `qledger-v1` rollup on QoreChain, rebuilds each one from main-chain data alone and re-executes every batch. When you are staked, it also:
- signs an ML-DSA-87 attestation for every batch whose roots match, which `ExitPool` checks on chain through the `pqcVerify` precompile;
- sends a fraud proof within seconds for any batch that is wrong, and is paid half the cheating submitter's bond.

It uses the **independent reader** by default. That reader recovers each post by the hash the chain committed to, so no transaction wrapper can hide a post from it (`WG_READER=rdk` switches to the RDK reader).

## What you need
- A Linux machine with Docker and Docker Compose, about 1 GB of free RAM and 2 GB of disk.
- About 52 test QOR (testnet only). Ask the team, or use the faucet.

## Steps (about 15 minutes)

```bash
git clone https://github.com/timix648/wicketgate && cd wicketgate
./ops/watcher-kit/kit.sh build                 # build the image (2-3 min)
./ops/watcher-kit/kit.sh keygen DAB0S          # makes YOUR key here; prints your qor1 / 0x address
#   -> send only the qor1 address to get test QOR. Never share ops/watcher-kit/keys/keys.env.
./ops/watcher-kit/kit.sh onboard DAB0S 50      # registers your ML-DSA-87 key (proof of possession) and stakes 50 QOR
./ops/watcher-kit/kit.sh up DAB0S              # starts it; restarts on crash and on reboot
./ops/watcher-kit/kit.sh status DAB0S          # after ~5 min: healthy, and a verdict for every rollup
```

Use any name in place of `DAB0S` (letters, digits and `_`).

Other commands: `logs <NAME>` follows the log; `down <NAME>` stops the watcher. Your stake stays registered until you leave the registry (`packages/scripts/src/leave.ts`).

## Where things live
| Path (in `ops/watcher-kit/`) | What |
| --- | --- |
| `keys/keys.env` | Your recovery phrase, mode 600. It never leaves this machine; **back it up** |
| `feed/<rollup>.json` | Your watcher's verdicts, exit proofs and accounts per rollup |
| `state/` | Search cache, so a restart takes seconds instead of minutes |

All three are git-ignored.

## What you risk and earn
Your stake backs the attestations you sign. If you sign two different results for one batch, anyone can submit both signatures and take your stake (equivocation slashing). An honest watcher cannot lose it. You earn a share of exit fees and half the bond of any submitter you catch. These are toy values on testnet.

## Checked
On 23 Nov 2026 this kit was run on the team server from a fresh folder with a fresh key. The container was healthy and caught up on all 8 rollups (more than 900 batches) in under 5 minutes, matching W1's verdicts, including the wrong `wicketgate-pay` batch 12. That run found a real issue: the node now prunes old posted-data records, so a fresh watcher could not check old batches with either reader. Both readers now check such a range against the inbox head's accumulator instead.
