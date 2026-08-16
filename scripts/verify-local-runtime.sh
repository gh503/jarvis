#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${JARVIS_RUNTIME_PORT:-}"
LOG_FILE="$(mktemp -t jarvis-runtime.XXXXXX.log)"
HEALTH_FILE="$(mktemp -t jarvis-health.XXXXXX.json)"
PID=""

cleanup() {
  if [[ -n "$PID" ]]; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  rm -f "$LOG_FILE"
  rm -f "$HEALTH_FILE"
}
trap cleanup EXIT INT TERM

if [[ -z "$PORT" ]]; then
  for attempt in {1..20}; do
    candidate=$((30_000 + RANDOM % 20_000))
    if ! lsof -nP -iTCP:"$candidate" -sTCP:LISTEN >/dev/null 2>&1; then
      PORT="$candidate"
      break
    fi
  done
fi
[[ -n "$PORT" ]]

npm run build >/dev/null
env -u DEEPSEEK_API_KEY JARVIS_PORT="$PORT" npm start >"$LOG_FILE" 2>&1 &
PID=$!

for attempt in {1..30}; do
  if curl -fsS "http://127.0.0.1:$PORT/jarvis/health" > "$HEALTH_FILE"; then
    if node --input-type=module -e '
      import { readFileSync } from "node:fs"
      const health = JSON.parse(readFileSync(process.argv[1], "utf8"))
      if (health.service !== "jarvis-mac-mvp" || health.status !== "ok" || health.scope !== "loopback-only") process.exit(1)
    ' "$HEALTH_FILE"; then
      break
    fi
  fi
  if ! kill -0 "$PID" 2>/dev/null; then
    cat "$LOG_FILE" >&2
    exit 1
  fi
  sleep 1
done

[[ -s "$HEALTH_FILE" ]]

http_status="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/jarvis/health")"
[[ "$http_status" == "405" ]]
echo "local runtime verification passed on 127.0.0.1:$PORT"
