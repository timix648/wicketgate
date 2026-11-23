#!/usr/bin/env bash
# Keeper for every LaneHub lane: each lane's early payouts must be settled from the chain after the
# batch finalises, or the lane's watchers are slashed for it. Every 10 minutes this runs the keeper
# once per deployments/lanes/*.json and exits, so it holds no memory between rounds.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/packages/scripts"
while true; do
  for f in "$ROOT"/deployments/lanes/*.json; do
    echo "$(date -u +%FT%TZ) [keeper-lanes] $(basename "$f")"
    WICKETGATE_DEPLOYMENTS="$f" timeout 600 npx tsx src/keeper.ts --as KEEPER --once 2>&1 | grep -v '^\s*$' | tail -5
  done
  sleep 600
done
