# Run a Wicketgate watcher

Anyone can watch QoreChain's rollups with Wicketgate, and anyone with a post-quantum key and a little stake can sign for them. One honest watcher that disagrees with the others freezes payouts on a batch, so every independent watcher makes the pool safer for everybody.

All of this is on the `qorechain-diana` testnet. Use a fresh, testnet-only account.

## 1. Watch, with no key and no tokens (2 minutes)

```bash
git clone https://github.com/timix648/wicketgate && cd wicketgate && pnpm install
cd packages/watcher
npx tsx src/cli.ts --mode observe --rollup all --once --feed ./feed
```

It finds every `qledger-v1` rollup on the chain, rebuilds each one from main-chain data alone and re-executes every batch. The verdicts land in `./feed/<rollup>.json`. With Docker instead: `docker build -t wicketgate-watcher . && docker run --rm -v "$PWD/feed:/feed" wicketgate-watcher --mode observe --rollup all --once` from the repository root.

## 2. Sign and stake (10 minutes, needs about 7 test QOR)

1. Make a fresh testnet recovery phrase (for example with QoreX, or `npx tsx -e "import('@qorechain/sdk').then(m=>console.log(m.generateMnemonic()))"` in `packages/scripts`) and fund its `qor1…` address from the faucet. Never use a phrase that has held mainnet funds.
2. Put it in your own key file, readable only by you. Pick any upper-case name; `ALICE` here:

   ```bash
   mkdir -p ~/.wicketgate && touch ~/.wicketgate/keys.env && chmod 600 ~/.wicketgate/keys.env
   # add this line to ~/.wicketgate/keys.env with your editor (keep it out of your shell history):
   # WG_ALICE_MNEMONIC="your twelve or twenty-four words"
   ```

3. Register your ML-DSA-87 key and join the registry with 5 QOR of stake (the minimum):

   ```bash
   cd packages/scripts && npx tsx src/onboard-watcher.ts ALICE 5
   ```

   It registers the post-quantum key with proof of possession if needed, then stakes through an EVM window scoped to the registry and closes the window straight after.

4. Run the watcher:

   ```bash
   cd ../watcher && npx tsx src/cli.ts --mode attest --as ALICE --rollup all --interval 30 --feed ./feed
   ```

   In `attest` mode it signs every batch whose re-execution matches, with your ML-DSA-87 key, and the pool checks that signature on chain. Use `--mode challenge` to also send a fraud proof the moment a batch does not match (half of the cheating submitter's bond goes to you).

5. Pick a reader (optional). `--reader rdk` (the default) reads inbox posts with the RDK's fetcher, with posts hidden inside wrapper messages hoisted out. `--reader independent` uses Wicketgate's second implementation, which recovers every post by the sha256 the chain committed to, wherever it sits in the transaction. The team runs both kinds: W1 and W2 use the RDK reader and W5 the independent one, so a bug in one reader cannot blind every watcher. Running the reader the network has fewer of makes it stronger.

## What you risk and what you earn

- Your stake is locked only when the pool advances an exit against a batch you confirmed, and only up to the lane's limit per watcher. It unlocks after the batch's window and grace period.
- If you confirm a batch and the chain never pays the withdrawal the pool advanced against it, your locked share repays the pool. So only sign what you re-executed yourself, which is all the watcher does.
- Confirming watchers share 30% of each exit fee.
- Leaving: `requestLeave`, then `leave` after the registry's delay (2 hours on testnet), as long as nothing is locked.

Questions or a rollup you want covered: open an issue on the repository.
