#!/usr/bin/env bash
# Delayed self-restart + post-restart smoke test for the dsh deployment.
#
# Started detached by the agent right before its final answer: it waits for the
# agent's current turn to become durable (`turn/end`), with a fixed fallback
# grace period, then restarts proxy + dsh web through the normal service
# script, then verifies the two fixes that motivated the restart:
#   1. the community `anchored-standard` preset is registered again, so old
#      sessions recorded with it can resume;
#   2. /api/pet/* traffic through the code-server proxy carries the base path,
#      both in the pet client bundle and in its JSON asset URLs.
#
# Results are appended to restart-verify.log next to the service.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$DIR/restart-verify.log"
DELAY="${RESTART_DELAY:-120}"
BASE_PATH="/proxy/3100"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT
COOKIE="$TMPDIR/cookies.txt"
HTML="$TMPDIR/index.html"
PET="$TMPDIR/pet.json"
RPC="$TMPDIR/roster.json"
PETJS="$TMPDIR/pet-client.js"

exec >>"$LOG" 2>&1
say() { printf '[%s] %s\n' "$(date -Is)" "$*"; }
fail() {
  say "RESULT: FAIL — $*"
  say '--- proxy.log tail ---'
  tail -40 "$DIR/proxy.log" || true
  exit 1
}

say "restart-and-verify armed (fallback grace ${DELAY}s)"
# Prefer the durable end of THIS turn over a guessed delay: once `turn/end`
# lands, the final answer is on disk and the restart cannot truncate it.
SESSION_FILE=""
if [ -n "${DSH_SESSION_ID:-}" ]; then
  for candidate in "${DSH_HOME:-$HOME/.dsh}"/sessions/*/"$DSH_SESSION_ID"/session.v4.jsonl.zstd; do
    [ -f "$candidate" ] || continue
    SESSION_FILE="$candidate"
    break
  done
fi
if [ -n "$SESSION_FILE" ] && [ -f "$DIR/turn-end-wait.mjs" ]; then
  say "waiting for the current turn of $DSH_SESSION_ID to finish"
  if node "$DIR/turn-end-wait.mjs" "$SESSION_FILE" 1800; then
    say 'final answer is durable; restarting now'
  else
    say "turn watcher could not confirm the end; falling back to ${DELAY}s"
    sleep "$DELAY"
  fi
else
  say "no session to watch; falling back to ${DELAY}s"
  sleep "$DELAY"
fi

say 'restarting service (proxy + dsh web)'
cd "$DIR" || fail "cannot cd $DIR"
if ! ./dsh-service.sh restart; then
  fail 'dsh-service.sh restart returned nonzero'
fi

say 'waiting for dsh web upstream'
ready=0
for _ in $(seq 1 90); do
  if curl -fsS --max-time 1 -o /dev/null "http://127.0.0.1:3001/api/pet/pets"; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" = 1 ] || fail 'dsh web did not answer on 127.0.0.1:3001 within 90s'

say 'waiting for the code-server proxy entry'
entry=000
for _ in $(seq 1 60); do
  entry=$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:3100$BASE_PATH/" || true)
  [ "$entry" = 200 ] && break
  sleep 1
done
[ "$entry" = 200 ] || fail "proxy entry returned HTTP $entry"

curl -sS -c "$COOKIE" -o "$HTML" "http://127.0.0.1:3100$BASE_PATH/" || fail 'index fetch failed'
[ -s "$HTML" ] || fail 'index body is empty'

# 1. Preset roster: anchored-standard must be declared again (and healthy).
UUID=$(cat /proc/sys/kernel/random/uuid)
curl -sS -b "$COOKIE" -H 'content-type: application/json' -H 'origin: http://127.0.0.1:3001' \
  -X POST "http://127.0.0.1:3100$BASE_PATH/api/agentPresets/list" \
  --data "{\"type\":\"client-request\",\"rpcId\":\"$UUID\",\"method\":\"agentPresets/list\",\"payload\":{\"args\":{}}}" \
  -o "$RPC" || fail 'agentPresets/list request failed'
if ! node -e '
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (!body.result || body.result.ok !== true) process.exit(1);
const rows = body.result.value.presets;
const row = rows.find((p) => p.id === "anchored-standard");
if (!row || row.broken) process.exit(1);
' "$RPC"; then
  fail 'anchored-standard is missing or broken in the agent preset roster'
fi
say 'PASS agent preset roster declares anchored-standard'

# 2. Pet client bundle through the proxy must carry the base-prefixed API path.
PET_JS=$(grep -o 'plugins/??@linxin666/dsh-pet/client\.js[^"]*' "$HTML" | head -1)
[ -n "$PET_JS" ] || fail 'pet client bundle URL not found in index.html'
curl -sS -b "$COOKIE" -o "$PETJS" "http://127.0.0.1:3100$BASE_PATH/$PET_JS" || fail 'pet client fetch failed'
if ! grep -q "$BASE_PATH/api/pet/state" "$PETJS"; then
  fail 'pet client bundle still uses root-absolute /api/pet paths'
fi
say "PASS pet client bundle uses $BASE_PATH/api/pet paths"

# 3. Pet JSON through the proxy: the poll endpoint answers, and the registry's
#    asset URLs carry the base path.
STATE="$TMPDIR/pet-state.json"
state_code=$(curl -sS -b "$COOKIE" -o "$STATE" -w '%{http_code}' "http://127.0.0.1:3100$BASE_PATH/api/pet/state" || true)
[ "$state_code" = 200 ] || fail "pet state endpoint returned HTTP $state_code"
node -e 'const fs=require("node:fs");JSON.parse(fs.readFileSync(process.argv[1],"utf8"))' "$STATE" \
  || fail 'pet state response is not JSON'
curl -sS -b "$COOKIE" -o "$PET" "http://127.0.0.1:3100$BASE_PATH/api/pet/pets" || fail 'pet registry fetch failed'
if ! node -e '
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const base = process.argv[2];
if (!Array.isArray(body) || body.length === 0) process.exit(1);
const urls = body.flatMap((p) => [p.atlasUrl, p.manifestUrl]).filter((u) => typeof u === "string");
if (urls.length === 0) process.exit(1);
if (!urls.every((u) => u.startsWith(base + "/"))) process.exit(1);
' "$PET" "$BASE_PATH"; then
  fail 'pet registry still returns root-absolute asset URLs'
fi
say 'PASS pet JSON endpoints answer and asset URLs are base-prefixed'

say 'RESULT: PASS — service restarted and both fixes verified'
say "open through code-server: $BASE_PATH/"
