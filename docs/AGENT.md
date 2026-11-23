# AI-managed liquidity: AgentVault, the liquidity agent and the MCP server

Liquidity providers earn **60% of every instant-exit fee** in the pools they back (watchers 30%, keepers 10%). With several pools now (Wicketgate's main pool and every LaneHub lane), where to put liquidity changes as exits come in. An AI agent can manage that, but only inside limits the chain enforces.

## AgentVault (`contracts/src/AgentVault.sol`, live at `0x3d66b87ad3615121ceaa90db809d8c946236a8f1`)
- The owner deposits QOR and names an agent.
- The agent can **only move the vault's QOR between recognised pools**: Wicketgate's main pool, or a lane the LaneHub deployed (so it runs the audited pool code). Any other address is refused.
- **Per-pool cap:** no pool can hold more than the owner's cap of the vault (50% here).
- **Every agent move needs the agent's ML-DSA-87 signature**, checked on chain by the `pqcVerify` precompile, with a nonce and a deadline. A stolen classical key moves nothing; a replayed signature is refused.
- **Money leaves only to the owner.** The agent cannot withdraw, cannot pay itself, and the owner can stop it (`setPolicy(..., paused)`) or pull liquidity back (`ownerRelease`) at any time.
- 9 Foundry tests: recognised pools only, the cap, wrong signer, replay, pause, owner-only withdrawal, release, fee earning.
- **Invariant suite** (`contracts/test/AgentVaultInvariants.t.sol`): random sequences of agent allocations and releases, owner funding, withdrawals and pauses, an attacker forging signatures and withdrawals, and the agent aiming at an unrecognised pool (128 runs, 8,192 calls). It always holds that value is conserved (vault value plus owner withdrawals equals what was put in, less rounding dust), the agent and the attacker never receive a wei, no forged or unrecognised move ever succeeds, and the vault only ever holds recognised pools.

## The liquidity agent (`packages/scripts/src/agent.ts`, tmux `wicketgate-agent`, every 30 min)
- Skips paused pools and pools with a contested batch.
- Scores the rest by the liquidity providers' fee yield over the lookback, weighted by how much history exists (full weight after 7 days, so a few hours of exits cannot pull money), plus a small bonus for recent exits and confirmed batches.
- Keeps 10% idle, spreads the rest by score under the cap, and moves only on more than 1 QOR of drift.
- Sends through a QoreChain EVM window **scoped to the vault alone**, and writes its reasoning for every round to `~/.wicketgate/agent/decisions.jsonl`.

## The Wicketgate MCP server (`packages/scripts/src/mcp-server.ts`)
One MCP server with **QoreChain's own tools** (`@qorechain/mcp`: chain info, blocks, transactions, accounts, ML-DSA-87 status, contract reads, simulation, faucet) **plus Wicketgate's**:

| Tool | What it answers |
| --- | --- |
| `wicketgate_list_lanes` | Every pool paying instant exits: liquidity, idle, paused, exits paid, fees, liquidity providers' earnings |
| `wicketgate_quote_exit` | What each pool would charge for an exit on a rollup, and the cheapest that can pay now |
| `wicketgate_batch_verdict` | Our watchers' verdict and roots for any batch of any rollup |
| `wicketgate_vault_status` | The AgentVault's value, positions, policy and agent moves |

It is read-only: it holds no key and signs nothing. Add it to Claude Code with:
```bash
claude mcp add wicketgate -- npx tsx /path/to/wicketgate/packages/scripts/src/mcp-server.ts
```
