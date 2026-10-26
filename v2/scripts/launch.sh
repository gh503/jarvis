#!/usr/bin/env bash
# Start the local server if needed, then open it as a Chrome app window.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${JARVIS_DATA_DIR:-$HOME/.local/share/jarvis/data}"
URL="http://127.0.0.1:${JARVIS_PORT:-3081}"
mkdir -p "$DATA/run"

if ! curl -fsS --noproxy '*' "$URL/api/health" >/dev/null 2>&1; then
  cd "$ROOT"
  nohup npm start > "$DATA/jarvis-console.log" 2>&1 &
  for _ in $(seq 1 40); do
    curl -fsS --noproxy '*' "$URL/api/health" >/dev/null 2>&1 && break
    sleep 1
  done
fi

CHROME="${JARVIS_CHROME:-google-chrome}"
if ! command -v "$CHROME" >/dev/null 2>&1; then
  echo "google-chrome not found; opening in the default browser" >&2
  xdg-open "$URL"
  exit 0
fi

exec "$CHROME" \
  --app="$URL/" \
  --class=Jarvis \
  --name=Jarvis \
  --disable-features=Translate \
  --no-first-run \
  --no-default-browser-check
