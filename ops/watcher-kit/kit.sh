#!/usr/bin/env bash
# Run an independent Wicketgate watcher on your own machine, with your own key.
#   ./ops/watcher-kit/kit.sh build                 build the image (from the repo root)
#   ./ops/watcher-kit/kit.sh keygen  <NAME>        make your key here; prints your address
#   ./ops/watcher-kit/kit.sh onboard <NAME> [QOR]  register your ML-DSA-87 key and stake (default 50)
#   ./ops/watcher-kit/kit.sh up      <NAME>        start the watcher (restarts on reboot/crash)
#   ./ops/watcher-kit/kit.sh status  <NAME>        health, last verdicts, stake
#   ./ops/watcher-kit/kit.sh logs    <NAME>        follow the log
#   ./ops/watcher-kit/kit.sh down    <NAME>        stop it (your stake stays until you leave)
set -euo pipefail
cd "$(dirname "$0")"
cmd="${1:-}"; NAME="$(echo "${2:-}" | tr a-z A-Z)"
export WG_NAME="$NAME" WG_UID="$(id -u)" WG_GID="$(id -g)"
mkdir -p keys state feed && chmod 700 keys
run() { docker run --rm $([ -t 0 ] && echo -it) -u "$WG_UID:$WG_GID" -v "$PWD/keys:/keys" -v "$PWD/state:/state" -w /app/packages/scripts wicketgate-watcher-kit "$@"; }
need() { [ -n "$NAME" ] || { echo "give a watcher name, e.g. DAB0S"; exit 1; }; }
case "$cmd" in
  build)   docker build -f Dockerfile -t wicketgate-watcher-kit ../.. ;;
  keygen)  need; run npx tsx src/watcher-keygen.ts "$NAME" ;;
  onboard) need; run npx tsx src/onboard-watcher.ts "$NAME" "${3:-50}" ;;
  up)      need; docker compose -p "wg-$(echo "$NAME" | tr A-Z a-z)" -f compose.yml up -d; echo "started. First catch-up takes about 5 minutes; then: $0 status $NAME" ;;
  down)    need; docker compose -p "wg-$(echo "$NAME" | tr A-Z a-z)" -f compose.yml down ;;
  logs)    need; docker logs -f --tail 50 "wicketgate-watcher-$NAME" ;;
  status)  need
           docker ps --filter "name=wicketgate-watcher-$NAME" --format '{{.Names}}  {{.Status}}'
           docker run --rm -v "$PWD/feed:/feed:ro" wicketgate-watcher-kit node -e '
             const fs=require("fs");for(const f of fs.readdirSync("/feed")){if(!f.endsWith(".json")||/^(index|alerts-sent|demo)\.json$/.test(f))continue;
             const b=(JSON.parse(fs.readFileSync("/feed/"+f,"utf8")).batches)||[];const c={};for(const x of b)c[x.verdict]=(c[x.verdict]||0)+1;
             console.log(f.slice(0,-5).padEnd(24),String(b.length).padStart(4),"batches",JSON.stringify(c))}' ;;
  *) sed -n 2,9p "$0"; exit 1 ;;
esac
