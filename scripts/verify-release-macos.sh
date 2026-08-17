#!/bin/zsh
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  print -u2 'Release installation verification requires macOS.'
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REF="${JARVIS_RELEASE_REF:-HEAD}"
TEMPORARY="$(mktemp -d "${TMPDIR:-/tmp}/jarvis-release.XXXXXX")"
VERSION="$(git -C "$ROOT" show "$REF:package.json" | node -e 'let input=""; process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => process.stdout.write(JSON.parse(input).version))')"
RELEASE_ARCHIVE="$TEMPORARY/jarvis-mac-mvp-v$VERSION.zip"
RELEASE_CHECKSUM="$RELEASE_ARCHIVE.sha256"
EXTRACT_ROOT="$TEMPORARY/extracted"
CHECKOUT="$EXTRACT_ROOT/jarvis-mac-mvp-v$VERSION"
TEST_HOME="$TEMPORARY/home"
LABEL="ai.jarvis.release-test.$$.${RANDOM}"
PORT=""

cleanup() {
  if [[ -d "$CHECKOUT" ]]; then
    HOME="$TEST_HOME" JARVIS_LAUNCH_AGENT_LABEL="$LABEL" \
      "$CHECKOUT/scripts/uninstall-launch-agent.sh" >/dev/null 2>&1 || true
  fi
  rm -rf "$TEMPORARY"
}
trap cleanup EXIT INT TERM

mkdir -p "$EXTRACT_ROOT" "$TEST_HOME"
"$ROOT/scripts/build-release-archive.sh" "$RELEASE_ARCHIVE" "$REF" >/dev/null
(
  cd "$TEMPORARY"
  shasum -a 256 -c "$(basename "$RELEASE_CHECKSUM")"
)
unzip -q "$RELEASE_ARCHIVE" -d "$EXTRACT_ROOT"
[[ -d "$CHECKOUT" ]]
cd "$CHECKOUT"
npm ci
npm run verify
npm run verify:runtime
npm run verify:recovery

for attempt in {1..30}; do
  candidate=$((30_000 + RANDOM % 20_000))
  if ! lsof -nP -iTCP:"$candidate" -sTCP:LISTEN >/dev/null 2>&1; then
    PORT="$candidate"
    break
  fi
done
[[ -n "$PORT" ]]

env -u DEEPSEEK_API_KEY \
  HOME="$TEST_HOME" \
  JARVIS_LAUNCH_AGENT_LABEL="$LABEL" \
  JARVIS_PORT="$PORT" \
  ./scripts/install-launch-agent.sh

PLIST="$TEST_HOME/Library/LaunchAgents/$LABEL.plist"
[[ -f "$PLIST" ]]
launchctl print "gui/$UID/$LABEL" >/dev/null

HEALTH="$TEMPORARY/health.json"
for attempt in {1..30}; do
  if curl -fsS "http://127.0.0.1:$PORT/jarvis/health" > "$HEALTH"; then
    break
  fi
  sleep 1
done
node --input-type=module - "$HEALTH" <<'NODE'
import { readFileSync } from 'node:fs'

const health = JSON.parse(readFileSync(process.argv[2], 'utf8'))
if (health.service !== 'jarvis-mac-mvp' || health.status !== 'ok' || health.scope !== 'loopback-only') process.exit(1)
NODE

HOME="$TEST_HOME" JARVIS_LAUNCH_AGENT_LABEL="$LABEL" ./scripts/uninstall-launch-agent.sh
for attempt in {1..30}; do
  if ! lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  print -u2 'LaunchAgent port remained open after uninstall.'
  exit 1
fi
if launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
  print -u2 'LaunchAgent remained loaded after uninstall.'
  exit 1
fi
[[ ! -e "$PLIST" ]]
[[ -d "$CHECKOUT/data" ]]
[[ -f "$CHECKOUT/data/reminders.json" ]]
[[ -f "$CHECKOUT/data/audit.jsonl" ]]

echo "Checksum-verified release archive installation, startup, recovery, persistence, and uninstall passed on port $PORT"
