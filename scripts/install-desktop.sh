#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPS="$HOME/.local/share/applications"
mkdir -p "$APPS"
chmod +x "$ROOT/scripts/launch.sh"
cat > "$APPS/jarvis.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Jarvis
Comment=本地优先的私人 AI 助手
Exec=bash $ROOT/scripts/launch.sh
Icon=$ROOT/web/icons/jarvis.svg
Terminal=false
Categories=Utility;Office;
StartupWMClass=Jarvis
Keywords=assistant;ai;jarvis;
DESKTOP
chmod 644 "$APPS/jarvis.desktop"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" || true
if [ "${1:-}" = "--autostart" ]; then
  mkdir -p "$HOME/.config/autostart"
  cp "$APPS/jarvis.desktop" "$HOME/.config/autostart/jarvis.desktop"
  echo "Jarvis will start with the desktop session."
fi
echo "Installed $APPS/jarvis.desktop"
echo "Launch it from the application menu, or run: bash $ROOT/scripts/launch.sh"
