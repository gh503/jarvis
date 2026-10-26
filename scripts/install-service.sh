#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node_bin="$(command -v node || true)"
data_dir="${JARVIS_DATA_DIR:-$HOME/.local/share/jarvis/data}"
unit_dir="$HOME/.config/systemd/user"
unit="$unit_dir/jarvis.service"

if [[ -z "$node_bin" ]]; then
  echo "node not found; install Node.js 24 first" >&2
  exit 1
fi
if [[ ! -f "$repo/package.json" ]]; then
  echo "not a Jarvis checkout: $repo" >&2
  exit 1
fi

if [[ -f "$repo/.env" ]]; then chmod 600 "$repo/.env"; fi
mkdir -p "$unit_dir"
sed -e "s|@REPO@|$repo|g" -e "s|@NODE@|$node_bin|g" -e "s|@DATA@|$data_dir|g" "$repo/ops/jarvis.service" > "$unit"
chmod 600 "$unit"
systemctl --user daemon-reload

if [[ "${1:-}" == "--no-start" ]]; then
  echo "installed $unit (not started)"
  exit 0
fi
if ss -ltn 2>/dev/null | grep -qE ':(3081)\b'; then
  echo "port 3081 is already in use; stop the dev server before starting the service" >&2
  echo "installed $unit (not started)" >&2
  exit 2
fi
systemctl --user enable --now jarvis.service
systemctl --user --no-pager status jarvis.service | sed -n '1,12p'
echo
echo "Jarvis user service installed. Logs: journalctl --user -u jarvis -f"
