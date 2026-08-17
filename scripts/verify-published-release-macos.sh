#!/bin/zsh
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  print -u2 'Published release verification requires macOS.'
  exit 1
fi
if ! command -v gh >/dev/null 2>&1; then
  print -u2 'Published release verification requires the GitHub CLI.'
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAG="${JARVIS_PUBLISHED_RELEASE_TAG:-${1:-}}"
if [[ ! "$TAG" =~ '^v[0-9]+\.[0-9]+\.[0-9]+$' ]]; then
  print -u2 'Provide a release tag such as v0.1.0.'
  exit 1
fi

VERSION="${TAG#v}"
ARCHIVE_NAME="jarvis-mac-mvp-v$VERSION.zip"
CHECKSUM_NAME="$ARCHIVE_NAME.sha256"
TEMPORARY="$(mktemp -d "${TMPDIR:-/tmp}/jarvis-published-release.XXXXXX")"
ASSETS="$TEMPORARY/assets"
EXTRACT_ROOT="$TEMPORARY/extracted"
CHECKOUT="$EXTRACT_ROOT/jarvis-mac-mvp-v$VERSION"
TEST_HOME="$TEMPORARY/home"
LABEL="ai.jarvis.published-release-test.$$.${RANDOM}"
PORT=""

cleanup() {
  if [[ -d "$CHECKOUT" ]]; then
    HOME="$TEST_HOME" JARVIS_LAUNCH_AGENT_LABEL="$LABEL" \
      "$CHECKOUT/scripts/uninstall-launch-agent.sh" >/dev/null 2>&1 || true
  fi
  rm -rf "$TEMPORARY"
}
trap cleanup EXIT INT TERM

RELEASE_STATE="$(gh release view "$TAG" --json isDraft,isPrerelease --jq '[.isDraft,.isPrerelease] | @tsv')"
if [[ "$RELEASE_STATE" != $'false\tfalse' ]]; then
  print -u2 'Published release verification requires a non-draft, non-prerelease release.'
  exit 1
fi
EXPECTED_DIGEST="$(gh release view "$TAG" --json assets --jq ".assets[] | select(.name == \"$ARCHIVE_NAME\") | .digest")"
CHECKSUM_ASSET="$(gh release view "$TAG" --json assets --jq ".assets[] | select(.name == \"$CHECKSUM_NAME\") | .name")"
if [[ ! "$EXPECTED_DIGEST" =~ '^sha256:[a-f0-9]{64}$' ]] || [[ "$CHECKSUM_ASSET" != "$CHECKSUM_NAME" ]]; then
  print -u2 'Published release is missing the expected ZIP digest or checksum asset.'
  exit 1
fi

mkdir -p "$ASSETS" "$EXTRACT_ROOT" "$TEST_HOME"
gh release download "$TAG" --dir "$ASSETS" --pattern "$ARCHIVE_NAME" --pattern "$CHECKSUM_NAME"
ACTUAL_DIGEST="sha256:$(shasum -a 256 "$ASSETS/$ARCHIVE_NAME" | awk '{print $1}')"
[[ "$ACTUAL_DIGEST" == "$EXPECTED_DIGEST" ]]
(
  cd "$ASSETS"
  shasum -a 256 -c "$CHECKSUM_NAME"
  unzip -t "$ARCHIVE_NAME" >/dev/null
  unzip -q "$ARCHIVE_NAME" -d "$EXTRACT_ROOT"
)
[[ -d "$CHECKOUT" ]]

cd "$CHECKOUT"
npm ci
npm audit --omit=dev --audit-level=high
npm run verify
npm run verify:runtime
if node -e 'const scripts=require("./package.json").scripts ?? {}; process.exit(scripts["verify:recovery"] ? 0 : 1)'; then
  npm run verify:recovery
fi

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

HEALTH="$TEMPORARY/health.json"
for attempt in {1..30}; do
  if curl -fsS "http://127.0.0.1:$PORT/jarvis/health" > "$HEALTH"; then break; fi
  sleep 1
done
node --input-type=module - "$HEALTH" <<'NODE'
import { readFileSync } from 'node:fs'

const health = JSON.parse(readFileSync(process.argv[2], 'utf8'))
if (health.service !== 'jarvis-mac-mvp' || health.status !== 'ok' || health.scope !== 'loopback-only') process.exit(1)
NODE

FIRST_PID="$(launchctl print "gui/$UID/$LABEL" | awk '$1 == "pid" && $2 == "=" { print $3; exit }')"
[[ "$FIRST_PID" =~ '^[0-9]+$' ]]
kill -TERM "$FIRST_PID"
SECOND_PID=""
for attempt in {1..30}; do
  SECOND_PID="$(launchctl print "gui/$UID/$LABEL" 2>/dev/null | awk '$1 == "pid" && $2 == "=" { print $3; exit }')"
  if [[ "$SECOND_PID" =~ '^[0-9]+$' ]] && [[ "$SECOND_PID" != "$FIRST_PID" ]] \
    && curl -fsS "http://127.0.0.1:$PORT/jarvis/health" > "$HEALTH"; then
    break
  fi
  sleep 1
done
[[ "$SECOND_PID" =~ '^[0-9]+$' ]]
[[ "$SECOND_PID" != "$FIRST_PID" ]]
[[ "$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -Fn | sed -n 's/^n//p')" == "127.0.0.1:$PORT" ]]

HOME="$TEST_HOME" JARVIS_LAUNCH_AGENT_LABEL="$LABEL" ./scripts/uninstall-launch-agent.sh
for attempt in {1..30}; do
  if ! lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then break; fi
  sleep 1
done
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 \
  || launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
  print -u2 'Published release left a listener or LaunchAgent after uninstall.'
  exit 1
fi

echo "Published $TAG asset digest, checksum, tests, runtime, crash restart, and uninstall verification passed"
