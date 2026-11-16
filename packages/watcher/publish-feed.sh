#!/usr/bin/env bash
# Publishes the W1 watcher's feed to github.com/timix648/wicketgate-feed every 5 minutes, so
# the board can read it from raw.githubusercontent.com. Waits until that repository exists.
set -u
REPO="git@github.com:timix648/wicketgate-feed.git"
SRC="${WICKETGATE_FEED_SRC:-$HOME/.wicketgate/feed-w1}"
DIR="${WICKETGATE_FEED_REPO:-$HOME/.wicketgate/feed-repo}"
while true; do
  if [ ! -d "$DIR/.git" ]; then
    if timeout 60 git ls-remote "$REPO" >/dev/null 2>&1; then
      rm -rf "$DIR" && git clone -q "$REPO" "$DIR" 2>/dev/null || { mkdir -p "$DIR" && cd "$DIR" && git init -q -b main && git remote add origin "$REPO"; }
      echo "$(date -u +%FT%TZ) feed repo ready at $DIR"
    else
      echo "$(date -u +%FT%TZ) waiting for $REPO to be created"; sleep 300; continue
    fi
  fi
  if [ -d "$SRC" ] && ls "$SRC"/*.json >/dev/null 2>&1; then
    cp "$SRC"/*.json "$DIR"/
    [ -f "$DIR/README.md" ] || printf '# Wicketgate watcher feed\n\nVerdicts and exit proofs published by a Wicketgate watcher every 5 minutes. See https://github.com/timix648/wicketgate.\n' > "$DIR/README.md"
    cd "$DIR"
    git add -A
    if ! git diff --cached --quiet; then
      git commit -q -m "Update the watcher feed. Written automatically by the W1 watcher."
      for i in 1 2 3 4; do timeout 120 git push -q -u origin main 2>/dev/null && break; sleep $((i * 5)); done
      echo "$(date -u +%FT%TZ) feed published"
    fi
  fi
  sleep 300
done
