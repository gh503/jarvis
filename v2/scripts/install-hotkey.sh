#!/usr/bin/env bash
# Install a GNOME global shortcut that opens the local Jarvis PWA.
# Usage: bash scripts/install-hotkey.sh ['<Super>j']
set -euo pipefail

binding="${1:-<Super>j}"
base="org.gnome.settings-daemon.plugins.media-keys"
path="/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/jarvis/"
desktop="${XDG_CURRENT_DESKTOP:-}"
if ! command -v gsettings >/dev/null 2>&1; then
  echo "gsettings not found; this shortcut installer is for GNOME." >&2
  exit 1
fi
if [[ "$desktop" != *GNOME* && "$desktop" != *Unity* ]]; then
  echo "Current desktop is '${desktop:-unknown}'; install the shortcut manually:" >&2
  echo "  command: xdg-open http://127.0.0.1:3081" >&2
  echo "  binding: $binding" >&2
  exit 2
fi

current="$(gsettings get "$base" custom-keybindings)"
if [[ "$current" != *"$path"* ]]; then
  if [[ "$current" == "@as []" || "$current" == "[]" ]]; then
    next="['$path']"
  else
    next="${current%]}, '$path']"
  fi
  gsettings set "$base" custom-keybindings "$next"
fi
schema="${base}.custom-keybinding:$path"
gsettings set "$schema" name 'Jarvis'
gsettings set "$schema" command 'xdg-open http://127.0.0.1:3081'
gsettings set "$schema" binding "$binding"
echo "Installed: $binding opens http://127.0.0.1:3081"
echo "Disable with: gsettings set $base custom-keybindings \"$(gsettings get "$base" custom-keybindings | sed "s#, '$path'##; s#'$path', ##")\""
