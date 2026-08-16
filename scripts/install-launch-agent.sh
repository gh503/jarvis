#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="ai.jarvis.mac-mvp"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NPM_BIN="$(command -v npm)"
PATH_VALUE="$PATH"

mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/data"
chmod 700 "$ROOT/data"

/usr/bin/python3 - "$PLIST" "$ROOT" "$NPM_BIN" "$PATH_VALUE" <<'PY'
import plistlib
import sys

path, root, npm_bin, path_value = sys.argv[1:]
document = {
    "Label": "ai.jarvis.mac-mvp",
    "ProgramArguments": ["/bin/zsh", f"{root}/scripts/start-mac.sh"],
    "WorkingDirectory": root,
    "RunAtLoad": True,
    "KeepAlive": True,
    "EnvironmentVariables": {"NPM_BIN": npm_bin, "PATH": path_value},
    "StandardOutPath": f"{root}/data/service.log",
    "StandardErrorPath": f"{root}/data/service-error.log",
    "ProcessType": "Interactive",
}
with open(path, "wb") as output:
    plistlib.dump(document, output)
PY

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"
launchctl kickstart -k "gui/$UID/$LABEL"
echo "Jarvis LaunchAgent installed: $PLIST"
