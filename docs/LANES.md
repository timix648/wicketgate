# Permissionless lanes (LaneHub)

Anyone can open an instant-exit lane for any QoreChain rollup, without asking the Wicketgate team.

`LaneHub` (`contracts/src/LaneHub.sol`, live at `0xca544af3304a19874299a02703c5c67b4b5fff9a` on diana) deploys a **separate** `WatcherRegistry` and `ExitPool` for each lane. Its rules:
- **Audited code only.** The opener passes the creation code, and the hub refuses anything that is not byte-for-byte the audited Wicketgate code (`poolCodeHash` and `registryCodeHash` are fixed in the hub). So every lane it lists runs exactly the code in this repository.
- **Post-quantum control.** The lane is run by the opener's own two admin keys. Both must be ML-DSA-87 keys registered with proof of possession, and the opener must be one of them. Binding the registry, the lane settings, the risk limits and the pause all need those post-quantum signatures (`pqcVerify`).
- **Isolated risk.** Each lane holds its own liquidity and its own watcher stake. A badly run lane can only lose what was put into that lane: other lanes and Wicketgate's own pool are untouched.
- **A market, not a gate.** Several providers can open lanes for the same rollup and compete on fees and limits. The hub has no owner and no admin.

## Proven live (23 Nov 2026)
An outside provider (two fresh accounts, `LANE_A` `0x0764…5640` and `LANE_B` `0x55f9…7Ef8`, not Wicketgate's admins):
1. registered both ML-DSA-87 keys with proof of possession;
2. opened a lane for `wicketgate-pay` through the hub: pool `0x94347d2ad5863325B1b7E1EA7F438d1507FE5e43`, registry `0x5935383277f430D13598781bAFb83cb6fDF2858D` (tx `0xf5973636…1825`);
3. bound and configured it with its own two post-quantum signatures (setPool `0x790bfa0a…b6f6`, setLane `0x702ed8bf…ba40`, setRisk `0xa0df45e1…378f`), and funded it with 10 QOR.

W1 and W2 staked into the lane's own registry and attested batch 22 to its pool (`0x544a4c51…`, `0xc34cd396…`). A 1 QOR withdrawal to a lane exit address (`BD64DD0A…A04D`) was then paid instantly from the lane (`0xe14f2764c71dacbe79dee4794aeb4da4c5abbcdb2fc50c0e6cb46a3fc6ec8f15`), before the batch finalised. The lane pool went from 10 to 9.003 QOR; Wicketgate's own pool (400.17 QOR) was not touched.

## Lanes for other teams' rollups (23 Nov 2026)
The same outside provider opened lanes for three other Protocol Builders teams' rollups, each funded with 10 QOR, with W1 and W2 staked in each lane's registry. One watcher process per key attests every rollup to its own lane's pool (`--lanes deployments/lanes`), and a per-account lock stops two processes on one key from clashing over EVM windows.

| Rollup | Lane pool | Opened in |
| --- | --- | --- |
| `skyproof-1` | `0x4Ac1b3323cCC1180f2FE8BA85EAF6CB478E245EF` | `0x203a335b35…` |
| `ledgerpump` | `0x67c90D05a08a00EA3C3569DA685D417b3A0BC94D` | `0x60f9584c00…` |
| `vigil-pay-1` | `0x17FD413E80Cc475a0eAD49a78eAF665c53533D66` | `0x0c3634e91f…` |

All lanes are listed live on the web app's **/lanes** page, read from the hub (nothing is hard-coded but the hub's address).

## Open a lane yourself
```bash
cd packages/scripts
npx tsx src/watcher-keygen.ts MYLANE_A && npx tsx src/watcher-keygen.ts MYLANE_B   # your two keys
# fund them, then (edit the role names in lane-open.ts, or reuse it as a template):
npx tsx src/lane-open.ts <rollup-id> <liquidity QOR>
```
Watchers join the lane with `WICKETGATE_DEPLOYMENTS=deployments/lanes/<rollup>.json npx tsx src/onboard-watcher.ts <NAME> 5` and run the watcher with the same variable.

## Limits
- The lane's admins set its fee, quorum and limits. Liquidity providers and watchers choose which lanes to back; the hub does not vet providers.
- The hub cannot check from the EVM that a rollup id exists on chain. A lane for a rollup that does not exist simply never confirms a batch.
- One key serving several pools from several processes is serialised by a per-account lock file (`withAccountLock` in `packages/core/src/evm.ts`); before that fix, two processes clashed once over an EVM window.
