#!/usr/bin/env bash
# Starts every Wicketgate service that is not already running, each in its own named tmux
# session. Safe to run any time (for example after a reboot); it never stops anything.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS="$HOME/.wicketgate/logs"
mkdir -p "$LOGS" "$HOME/.wicketgate/feed-w1" "$HOME/.wicketgate/feed-w2" "$HOME/.wicketgate/feed-w5"
ROLLUPS="${WICKETGATE_ROLLUPS:-all}"

# The wicketgate-pay operator reads the app's relay URL and token (WICKETGATE_RELAY_URL,
# WICKETGATE_RELAY_TOKEN) from ~/.wicketgate/relay.env, outside the repository, when that file exists.
# W1 and the wicketgate-pay operator send Telegram alerts (blind watcher, wrong batch); the others
# stay quiet so each event arrives once. See packages/core/src/alert.ts.
start() { # name, workdir, command, log
  if tmux has-session -t "=$1" 2>/dev/null; then echo "running  $1"; return; fi
  tmux new-session -d -s "$1" "cd '$2' && $3 2>&1 | tee -a '$LOGS/$4.log'"
  echo "started  $1"
}

start wicketgate-w1     "$ROOT/packages/watcher"  "WICKETGATE_ALERTS=1 WICKETGATE_ALERT_ENV=/opt/opportunity-hunter/.env npx tsx src/cli.ts --mode challenge --as W1 --rollup $ROLLUPS --interval 10 --feed $HOME/.wicketgate/feed-w1" w1
start wicketgate-w2     "$ROOT/packages/watcher"  "npx tsx src/cli.ts --mode challenge --as W2 --rollup $ROLLUPS --interval 10 --feed $HOME/.wicketgate/feed-w2" w2
# W5 runs the independent reader (payloads recovered by their committed hash), so a bug in the RDK
# reader that W1 and W2 use cannot blind every watcher. With three watchers, quorum 2 survives one being down.
start wicketgate-w5     "$ROOT/packages/watcher"  "npx tsx src/cli.ts --mode challenge --reader independent --as W5 --rollup $ROLLUPS --interval 10 --feed $HOME/.wicketgate/feed-w5" w5
start wicketgate-op-pay "$ROOT/packages/operator" "set -a; [ -f $HOME/.wicketgate/relay.env ] && . $HOME/.wicketgate/relay.env; set +a; WICKETGATE_ALERTS=1 WICKETGATE_ALERT_ENV=/opt/opportunity-hunter/.env npx tsx src/cli.ts --rollup wicketgate-pay --interval 20" op-pay
start wicketgate-op-e2e "$ROOT/packages/operator" "npx tsx src/cli.ts --rollup rdk-v328-e2e-mwd5v89d --interval 20" op-e2e
start wicketgate-op-vigil "$ROOT/packages/operator" "npx tsx src/cli.ts --rollup vigil-1 --interval 30" op-vigil   # not bonded there: only pays out and settles withdrawals behind our advances
start wicketgate-op-vigilpay "$ROOT/packages/operator" "npx tsx src/cli.ts --rollup vigil-pay-1 --interval 30" op-vigilpay   # likewise for vigil-pay-1 (another team's rollup)
start wicketgate-feed   "$ROOT/packages/watcher"  "./publish-feed.sh" feed
# Keep-alive: the chain deletes batch records ~7 days after they finalise, so post a tiny transfer
# whenever the newest wicketgate-pay batch is over 48 h old; fresh receipts always exist.
start wicketgate-pulse  "$ROOT/packages/scripts"  "npx tsx src/pulse.ts" pulse
# Permissionless lanes opened through LaneHub by a team-run test provider with its own keys (LANE_A/LANE_B, not the admin keys),
# one per rollup in deployments/lanes/. W1 and W2 stake in every lane and attest each rollup to its
# own lane pool from one process each (--lanes), with separate state folders.
for w in w1 w2; do W=$(echo $w | tr a-z A-Z); mkdir -p "$HOME/.wicketgate/lane-$w"
  start wicketgate-lane-$w "$ROOT/packages/watcher" "WICKETGATE_STATE=$HOME/.wicketgate/lane-$w npx tsx src/cli.ts --mode attest --as $W --lanes $ROOT/deployments/lanes --interval 20 --feed $HOME/.wicketgate/lane-$w/feed" lane-$w
done
# The main pool's keeper (settles, writes off, releases; paid 10% of each advance's fee).
start wicketgate-keeper "$ROOT/packages/scripts" "npx tsx src/keeper.ts --as KEEPER --interval 60" keeper
# Settle every lane's early payouts once their batches finalise (one keeper pass per lane, every 10 min).
start wicketgate-keeper-lanes "$ROOT" "./ops/keeper-lanes.sh" keeper-lanes
# The liquidity agent: rebalances the AgentVault across the main pool and the lanes every 30 min,
# each move signed with its ML-DSA-87 key and checked on chain; reasoning in ~/.wicketgate/agent/.
start wicketgate-agent "$ROOT/packages/scripts" "npx tsx src/agent.ts --interval-min 30" agent
