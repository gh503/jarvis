#!/bin/zsh
set -euo pipefail

LABEL="${JARVIS_LAUNCH_AGENT_LABEL:-ai.jarvis.mac-mvp}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ ! "$LABEL" =~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' ]]; then
  print -u2 'JARVIS_LAUNCH_AGENT_LABEL is invalid.'
  exit 1
fi

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "Jarvis LaunchAgent removed. Local data was kept."
