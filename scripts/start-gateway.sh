#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -z "${JARVIS_OWNER_TOKEN:-}" ]]; then
  print -u2 'JARVIS_OWNER_TOKEN is required and must not be committed.'
  exit 1
fi

if [[ ! -d node_modules ]]; then
  "${NPM_BIN:-npm}" install
fi
"${NPM_BIN:-npm}" run build --silent

exec node dist/gateway-main.js
