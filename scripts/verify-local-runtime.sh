#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${JARVIS_RUNTIME_PORT:-}"
GATEWAY_PORT="${JARVIS_GATEWAY_RUNTIME_PORT:-}"
RUNTIME_DIR="$(mktemp -d -t jarvis-runtime.XXXXXX)"
LOG_FILE="$RUNTIME_DIR/harness.log"
GATEWAY_LOG_FILE="$RUNTIME_DIR/gateway.log"
HEALTH_FILE="$RUNTIME_DIR/harness-health.json"
GATEWAY_HEALTH_FILE="$RUNTIME_DIR/gateway-health.json"
PID=""
GATEWAY_PID=""

cleanup() {
  if [[ -n "$GATEWAY_PID" ]]; then
    kill "$GATEWAY_PID" 2>/dev/null || true
    wait "$GATEWAY_PID" 2>/dev/null || true
  fi
  if [[ -n "$PID" ]]; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  rm -rf "$RUNTIME_DIR"
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

if [[ -z "$GATEWAY_PORT" ]]; then
  for attempt in {1..20}; do
    candidate=$((30_000 + RANDOM % 20_000))
    if [[ "$candidate" != "$PORT" ]] && ! lsof -nP -iTCP:"$candidate" -sTCP:LISTEN >/dev/null 2>&1; then
      GATEWAY_PORT="$candidate"
      break
    fi
  done
fi
[[ -n "$GATEWAY_PORT" ]]

npm run build >/dev/null
ln -s "$ROOT/dist" "$RUNTIME_DIR/dist"
ln -s "$ROOT/config" "$RUNTIME_DIR/config"
env -u DEEPSEEK_API_KEY \
  DSH_HOME="$RUNTIME_DIR/.dsh" \
  JARVIS_DATA_DIR="$RUNTIME_DIR/harness-data" \
  JARVIS_PORT="$PORT" \
  npm start >"$LOG_FILE" 2>&1 &
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

MEMORY_FILE="$RUNTIME_DIR/harness-data/memory.json"
[[ -f "$MEMORY_FILE" ]]
[[ "$(stat -f '%Lp' "$MEMORY_FILE")" == "600" ]]
[[ -f "$RUNTIME_DIR/harness-data/memory-service.json" ]]
[[ "$(stat -f '%Lp' "$RUNTIME_DIR/harness-data/memory-service.json")" == "600" ]]
[[ -d "$RUNTIME_DIR/harness-data/.memory-writer.lock" ]]
node --input-type=module -e '
  import { readFileSync } from "node:fs"
  const memory = JSON.parse(readFileSync(process.argv[1], "utf8"))
  if (memory.version !== 1 || !Array.isArray(memory.items) || memory.items.length !== 0) process.exit(1)
' "$MEMORY_FILE"

printf 'runtime memory service check' | JARVIS_DATA_DIR="$RUNTIME_DIR/harness-data" \
  npm run memory --silent -- propose --class episodic > "$RUNTIME_DIR/memory-propose.json"
MEMORY_ID="$(node --input-type=module -e '
  import { readFileSync } from "node:fs"
  const value = JSON.parse(readFileSync(process.argv[1], "utf8"))
  if (value.item?.status !== "proposed") process.exit(1)
  process.stdout.write(value.item.id)
' "$RUNTIME_DIR/memory-propose.json")"
JARVIS_DATA_DIR="$RUNTIME_DIR/harness-data" npm run memory --silent -- delete --id "$MEMORY_ID" >/dev/null
node --input-type=module -e '
  import { readFileSync } from "node:fs"
  const memory = JSON.parse(readFileSync(process.argv[1], "utf8"))
  if (memory.items.length !== 0) process.exit(1)
' "$MEMORY_FILE"
! rg -q 'runtime memory service check' "$RUNTIME_DIR/harness-data/memory-audit.jsonl"

http_status="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/jarvis/health")"
[[ "$http_status" == "405" ]]

OWNER_TOKEN='runtime-owner-token-with-at-least-sixteen-characters'
JARVIS_OWNER_TOKEN="$OWNER_TOKEN" \
  JARVIS_DATA_DIR="$RUNTIME_DIR/gateway-data" \
  JARVIS_GATEWAY_PORT="$GATEWAY_PORT" \
  JARVIS_HARNESS_URL="http://127.0.0.1:$PORT" \
  npm run start:gateway >"$GATEWAY_LOG_FILE" 2>&1 &
GATEWAY_PID=$!

for attempt in {1..30}; do
  if curl -fsS "http://127.0.0.1:$GATEWAY_PORT/v1/health" > "$GATEWAY_HEALTH_FILE"; then
    break
  fi
  if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
    cat "$GATEWAY_LOG_FILE" >&2
    exit 1
  fi
  sleep 1
done
[[ -s "$GATEWAY_HEALTH_FILE" ]]

JARVIS_GATEWAY_URL="http://127.0.0.1:$GATEWAY_PORT" \
  JARVIS_OWNER_TOKEN="$OWNER_TOKEN" \
  node scripts/verify-gateway-harness-runtime.mjs

echo "local Harness and Gateway runtime verification passed on loopback"
