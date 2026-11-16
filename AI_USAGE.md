# How AI was used to build Wicketgate

This file is for the Best AI-Native Build award. It records what the team decided, what an AI coding agent produced, and how every claim was checked. It is updated as the project grows.

## The team and the tools

- **Team:**
  - @timix648 (lead): direction, product decisions, review, chain operations and everything published.
  - @da-b0s: the frontend (wallet and rollup board), some backend jobs, and the demo.
- **Coding agent:** Claude Code, running on the team's own server with shell access, and the QoreChain docs read as markdown (every page is available by appending `.md` to its URL).
- **Other tools:** Foundry for contracts and tests, the QoreChain kits (`@qorechain/sdk`, `@qorechain/rdk`, `@qorechain/pqc`), the public diana endpoints and explorer.

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
