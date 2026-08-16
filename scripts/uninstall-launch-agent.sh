#!/bin/zsh
set -euo pipefail

LABEL="ai.jarvis.mac-mvp"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "Jarvis LaunchAgent removed. Local data was kept."
