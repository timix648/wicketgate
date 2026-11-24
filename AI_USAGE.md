# How AI was used to build Wicketgate

This file is for the Best AI-Native Build award. It records what the team decided, what an AI coding agent produced, and how every claim was checked. It is updated as the project grows.

## The team and the tools

- **Team:**
  - @timix648 (lead): direction, product decisions, review, chain operations and everything published.
  - @da-b0s: the frontend (wallet and rollup board), some backend jobs, and the demo.
- **Coding agent:** Claude Code, running on the team's own server with shell access, and the QoreChain docs read as markdown (every page is available by appending `.md` to its URL).- **Other tools:** Foundry for contracts and tests, the QoreChain kits (`@qorechain/sdk`, `@qorechain/rdk`, `@qorechain/pqc`), the public diana endpoints and explorer.

## What the team decided

The agent proposed, the team chose. These decisions shaped the project and were made by people:

- **The goal.** Treat this as a real attempt to place, not a demo. The team asked for an idea that would not look like the usual AI-generated hackathon entry, and that serves QoreChain itself, not just a fest checkbox.
- **Rejecting weak ideas.** Several earlier proposals were turned down, including a vault-style dApp, an agent with spending limits, and an election-collation rollup. The team rejected that last one as irrelevant to a web3 audience. The team asked who the product is actually for before agreeing to build anything.
- **The category and the team.** The team chose Protocol Builders after weighing it against spreading across Cross-VM and another track, and formed a two-person team to meet the category's minimum.
- **The name.** The team rejected the working name and asked for a single, unique word. Candidates were checked against npm and GitHub, and Wicketgate was picked.
- **Openness.** The team chose to keep the repository public during the fest, accepting the risk of copying in exchange for building in public.
- **Every outward-facing step.** The team creates and edits the project page, registers for the Q-Day Drill, claims faucet funds and posts updates. The agent drafts text; the team decides what is published.

## What the agent produced

- **Research.** Read the fest rules and all 190 documentation pages, queried the live testnet, scanned the other fest projects and found the gap: QoreChain's rollup kit had shipped days before, and nothing on the chain verifies rollup batches or pays exits early.
- **Design.** Proposed the watcher network and stake-capped instant exits, wrote a build blueprint, and added rules such as "one dissenting watcher freezes payouts on a batch".
- **Code.** Wrote the Solidity contracts, the Foundry tests, the TypeScript probes and the deployment scripts in this repository, following the team's direction and corrections.

## How the work was checked

Nothing here is taken on trust from the agent. Every claim about the chain has to be reproducible, and is listed with its transaction hash in [PROOF.md](PROOF.md).

- **Probes before code.** Before any product code, two read-only probes had to pass against the live testnet. One rebuilt the only existing rollup from chain data and matched its published roots. The other made the `pqcVerify` precompile accept a real ML-DSA-87 signature and reject a one-bit change.
- **Tests.** 31 Foundry tests cover the contracts, including the failure paths: forged and replayed signatures, an inactive precompile, an exit taken twice, an unpaid advance.
- **On-chain evidence.** Deployment was accepted as working only once both admins' ML-DSA-87 signatures had been verified by the chain itself.
- **Mistakes caught along the way.** A broken placeholder in the repayment path was caught before tests ran. Address checksum errors in Solidity and viem were found by compiling and running, not by review. A test read the wrong field and failed until it was fixed.

## The frontend (`apps/web`)

**What @da-b0s decided.** Build the Wicketgate frontend for the existing repository (the first brief received described a different, unrelated project). Start with a read-only board, then get functionality right before visual design. The order of work: wallet, proof pages, end-to-end test, pool and receipt checker, then figures linked to their sources and credits. Ship each step as its own pull request for early review, and have the backend owner set up hosting since only the repository owner could. @timix648 set the brief, corrected the wallet's signing model (QoreX signs only the deposit; never ask for a recovery phrase), and added the `accounts` field to the watcher feed when the wallet needed real balances.

**What the agent produced.** The Next.js app: board, rollup and batch pages, watchers, instant exits, exit tracker, proof pages, pool, receipt checker and wallet; the relay and exit-relay queues and their operator endpoints; the Playwright tests and the CI job that runs them. It read the brief, the contracts and the QoreChain and QoreX package documentation, and drafted every pull request for review.

**How it was checked.**
- **Against the live testnet.** Every page was opened in a browser and its figures compared with the chain and the committed evidence: 28 instant exits and 745 QOR of watcher stake on the board match the README; receipt checks pass for a real receipt and fail for a copy with one digit changed.
- **Tests.** Playwright runs the wallet with `@qorechain/qorex-wallet-mock` (real hybrid signing, no funds): connecting through the QoreX entry, creating and unlocking the rollup account, a deposit rejected in QoreX, and a withdrawal whose relayed transaction is decoded and signature-checked by the test, with its salt confirmed in storage before it is sent. The queue API was exercised end to end, including wrong signatures, oversized bodies, rate limits and duplicate requests.
- **Findings passed to the backend.** The board flagged a real advance on pool v2.1 that was overdue and unrepaid; it was then repaid and closed, and the closed state was read back from chain.
- **Mistakes caught along the way.** An effect that returned a value crashed the first board; the exits page counted the fee twice until the contract was read; the wallet's first save path could lose a change before it reached storage; `Buffer` does not exist in the browser; wagmi needed a newer viem than the repository pins; wagmi wraps the wallet's refusal, so the pool page showed "unknown RPC error" until the test asked for the real message; the receipt checker refused every check without queue storage. Each was found by running the app or a test, and fixed.

## Keys and safety

The project's accounts are testnet-only. Their recovery phrases live in a file outside the repository, readable only by its owner, and are never committed. Setting up the drill is the one exception, by the drill's own design: the drill account's classical key was handed to the organiser, who publishes it after the drill.

## Log

| Date | Who | What |
| --- | --- | --- |
| 15–16 Nov 2026 | Team, agent | Research, idea selection (several rejected), category and team decision, name chosen |
| 16 Nov 2026 | Agent | Probes, contracts, tests, scripts |
| 16 Nov 2026 | Team | Repository created and made public, faucet funding, project page, drill registration |
| 16 Nov 2026 | Agent | Accounts registered, contracts deployed, watchers staked, proof recorded |
| 16 Nov 2026 | Team | Roles set: @da-b0s owns the frontend, some backend jobs and the demo |
| 16 Nov 2026 | Team | Asked the organiser for test QOR and received 15,000; created the feed repository; registered the Q-Day Drill; funded the accounts from the faucet |
| 16 Nov 2026 | Agent | Watcher, operator, exit and receipt scripts; launched `wicketgate-pay`; ran the instant exits, the fraud demo and the encrypted notes on diana; CI, invariant tests and the QoreScan inventory |
| 16 Nov 2026 | Team | Decided to keep building now and update the project page later |
| 20 Nov 2026 | @da-b0s, agent | Read-only rollup board (PR #2); moved to Next.js with the relay and exit-relay queues as the frontend brief asked |
| 20 Nov 2026 | @timix648 | Set up the Vercel project and queue storage, connected the operator, merged PR #2 |
| 21 Nov 2026 | @da-b0s, agent | Wallet and pool v3.1 history (PR #3), proof pages (PR #4), Playwright test in CI (PR #5), pool and receipt checker (PR #6), figures linked to their sources |
| 21 Nov 2026 | @timix648 | Published rollup account balances in the feed; repaid the overdue v2.1 advance the board flagged |
