#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="${JARVIS_LAUNCH_AGENT_LABEL:-ai.jarvis.mac-mvp}"
PORT="${JARVIS_PORT:-3080}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NPM_BIN="$(command -v npm)"
PATH_VALUE="$PATH"

if [[ ! "$LABEL" =~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' ]]; then
  print -u2 'JARVIS_LAUNCH_AGENT_LABEL is invalid.'
  exit 1
fi
if [[ ! "$PORT" =~ '^[0-9]+$' ]] || (( PORT < 1 || PORT > 65535 )); then
  print -u2 'JARVIS_PORT must be an integer from 1 to 65535.'
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/data"
chmod 700 "$ROOT/data"

TEMP_DIRECTORY="$(mktemp -d "${TMPDIR:-/tmp}/jarvis-launch-agent.XXXXXX")"
trap 'rm -rf "$TEMP_DIRECTORY"' EXIT
node --input-type=module - "$TEMP_DIRECTORY/agent.json" "$LABEL" "$PORT" "$ROOT" "$NPM_BIN" "$PATH_VALUE" <<'NODE'
import { writeFileSync } from 'node:fs'

const [path, label, port, root, npmBin, pathValue] = process.argv.slice(2)
const document = {
  Label: label,
  ProgramArguments: ['/bin/zsh', `${root}/scripts/start-mac.sh`],
  WorkingDirectory: root,
  RunAtLoad: true,
  KeepAlive: true,
  EnvironmentVariables: { NPM_BIN: npmBin, PATH: pathValue, JARVIS_PORT: port },
  StandardOutPath: `${root}/data/service.log`,
  StandardErrorPath: `${root}/data/service-error.log`,
  ProcessType: 'Interactive',
}
writeFileSync(path, `${JSON.stringify(document)}\n`, { encoding: 'utf8', mode: 0o600 })
NODE
/usr/bin/plutil -convert xml1 -o "$TEMP_DIRECTORY/agent.plist" "$TEMP_DIRECTORY/agent.json"
chmod 600 "$TEMP_DIRECTORY/agent.plist"
mv "$TEMP_DIRECTORY/agent.plist" "$PLIST"

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"
launchctl kickstart -k "gui/$UID/$LABEL"
echo "Jarvis LaunchAgent installed: $PLIST (port $PORT)"
