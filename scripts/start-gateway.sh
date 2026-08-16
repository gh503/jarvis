#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -z "${JARVIS_OWNER_TOKEN:-}" ]]; then
  print -u2 'JARVIS_OWNER_TOKEN is required and must not be committed.'
  exit 1
fi

if [[ ! -d node_modules || ! -f dist/gateway-main.js ]]; then
  "${NPM_BIN:-npm}" install
  "${NPM_BIN:-npm}" run build
fi

exec node dist/gateway-main.js
