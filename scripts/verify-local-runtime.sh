#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${JARVIS_RUNTIME_PORT:-3183}"
LOG_FILE="$(mktemp -t jarvis-runtime.XXXXXX.log)"
PID=""

cleanup() {
  if [[ -n "$PID" ]]; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  rm -f "$LOG_FILE"
}
trap cleanup EXIT INT TERM

npm run build >/dev/null
env -u DEEPSEEK_API_KEY JARVIS_PORT="$PORT" npm start >"$LOG_FILE" 2>&1 &
PID=$!

for attempt in {1..30}; do
  if curl -fsS "http://127.0.0.1:$PORT/jarvis/health" > /tmp/jarvis-health.json; then
    break
  fi
  if ! kill -0 "$PID" 2>/dev/null; then
    cat "$LOG_FILE" >&2
    exit 1
  fi
  sleep 1
done

[[ -s /tmp/jarvis-health.json ]]
node --input-type=module -e '
  import { readFileSync } from "node:fs"
  const health = JSON.parse(readFileSync("/tmp/jarvis-health.json", "utf8"))
  if (health.service !== "jarvis-mac-mvp" || health.status !== "ok" || health.scope !== "loopback-only") {
    throw new Error(`unexpected health response: ${JSON.stringify(health)}`)
  }
'

http_status="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/jarvis/health")"
[[ "$http_status" == "405" ]]
echo "local runtime verification passed on 127.0.0.1:$PORT"
