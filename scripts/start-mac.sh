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
exec node dist/runtime-main.js harness -- \
  "${NPM_BIN:-npm}" exec -- dsh web --patch "$ROOT/cordis.patch.yml" --host 127.0.0.1 --port "$PORT"
