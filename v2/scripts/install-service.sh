#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="$(command -v node)"
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/jarvis.service" <<SERVICE
[Unit]
Description=Jarvis local assistant
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
EnvironmentFile=-$ROOT/.env
Environment=NODE_ENV=production
ExecStart=$NODE --experimental-transform-types --enable-source-maps $ROOT/src/main.ts
Restart=on-failure
RestartSec=3
# Keep the service's data private to the user.
UMask=0077

[Install]
WantedBy=default.target
SERVICE
systemctl --user daemon-reload
systemctl --user enable --now jarvis.service
echo "Installed and started ~/.config/systemd/user/jarvis.service"
echo "Check it with: systemctl --user status jarvis.service"
echo "Logs: journalctl --user -u jarvis.service -f"
