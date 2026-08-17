#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -d node_modules || ! -f dist/index.js ]]; then
  "${NPM_BIN:-npm}" install
  "${NPM_BIN:-npm}" run build
fi

export DSH_HOME="${DSH_HOME:-$ROOT/.dsh}"
export DSH_TELEMETRY_DISABLED=1
export DSH_PERMISSION_MODE=workspace-write
export JARVIS_DATA_DIR="${JARVIS_DATA_DIR:-$ROOT/data}"

PORT="${JARVIS_PORT:-3080}"
MEMORY_PID=""
HARNESS_PID=""
cleanup() {
  if [[ -n "$HARNESS_PID" ]]; then
    kill "$HARNESS_PID" 2>/dev/null || true
    wait "$HARNESS_PID" 2>/dev/null || true
  fi
  if [[ -n "$MEMORY_PID" ]]; then
    kill "$MEMORY_PID" 2>/dev/null || true
    wait "$MEMORY_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

node dist/memory-service-main.js &
MEMORY_PID=$!
for attempt in {1..50}; do
  [[ -f "$JARVIS_DATA_DIR/memory-service.json" ]] && break
  kill -0 "$MEMORY_PID" 2>/dev/null || { wait "$MEMORY_PID"; exit 1; }
  sleep 0.1
done
[[ -f "$JARVIS_DATA_DIR/memory-service.json" ]]

node dist/runtime-main.js harness -- \
  "${NPM_BIN:-npm}" exec -- dsh web --patch "$ROOT/cordis.patch.yml" --host 127.0.0.1 --port "$PORT" &
HARNESS_PID=$!
wait "$HARNESS_PID"
