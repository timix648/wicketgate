#!/usr/bin/env bash
# Starts every Wicketgate service that is not already running, each in its own named tmux
# session. Safe to run any time (for example after a reboot); it never stops anything.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS="$HOME/.wicketgate/logs"
mkdir -p "$LOGS" "$HOME/.wicketgate/feed-w1" "$HOME/.wicketgate/feed-w2"
ROLLUPS="${WICKETGATE_ROLLUPS:-all}"

# W1 and the wicketgate-pay operator send Telegram alerts (blind watcher, wrong batch); the others
# stay quiet so each event arrives once. See packages/core/src/alert.ts.
start() { # name, workdir, command, log
  if tmux has-session -t "$1" 2>/dev/null; then echo "running  $1"; return; fi
  tmux new-session -d -s "$1" "cd '$2' && $3 2>&1 | tee -a '$LOGS/$4.log'"
  echo "started  $1"
}

start wicketgate-w1     "$ROOT/packages/watcher"  "WICKETGATE_ALERTS=1 WICKETGATE_ALERT_ENV=/opt/opportunity-hunter/.env npx tsx src/cli.ts --mode challenge --as W1 --rollup $ROLLUPS --interval 10 --feed $HOME/.wicketgate/feed-w1" w1
start wicketgate-w2     "$ROOT/packages/watcher"  "npx tsx src/cli.ts --mode challenge --as W2 --rollup $ROLLUPS --interval 10 --feed $HOME/.wicketgate/feed-w2" w2
start wicketgate-op-pay "$ROOT/packages/operator" "WICKETGATE_ALERTS=1 WICKETGATE_ALERT_ENV=/opt/opportunity-hunter/.env npx tsx src/cli.ts --rollup wicketgate-pay --interval 20" op-pay
start wicketgate-op-e2e "$ROOT/packages/operator" "npx tsx src/cli.ts --rollup rdk-v328-e2e-mwd5v89d --interval 20" op-e2e
start wicketgate-op-vigil "$ROOT/packages/operator" "npx tsx src/cli.ts --rollup vigil-1 --interval 30" op-vigil   # not bonded there: only pays out and settles withdrawals behind our advances
start wicketgate-feed   "$ROOT/packages/watcher"  "./publish-feed.sh" feed
