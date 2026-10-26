#!/usr/bin/env bash
# Generate a self-signed certificate for private-LAN / Tailscale testing.
# Production should use a real certificate (Tailscale cert, Caddy, Let's Encrypt).
set -euo pipefail

host="${1:-127.0.0.1}"
data="${JARVIS_DATA_DIR:-$HOME/.local/share/jarvis/data}"
out="${2:-$data}"
mkdir -p "$out"
chmod 700 "$out"
if [[ -e "$out/tls-cert.pem" || -e "$out/tls-key.pem" ]]; then
  echo "Refusing to overwrite existing $out/tls-cert.pem or tls-key.pem" >&2
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required." >&2
  exit 1
fi
san="DNS:localhost,IP:127.0.0.1,IP:::1"
if [[ "$host" =~ ^[0-9.]+$ ]]; then
  san="$san,IP:$host"
elif [[ "$host" == *:* ]]; then
  san="$san,IP:$host"
else
  san="$san,DNS:$host"
fi
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 825 \
  -keyout "$out/tls-key.pem" -out "$out/tls-cert.pem" \
  -subj "/CN=jarvis.local" -addext "subjectAltName=$san" >/dev/null 2>&1
chmod 600 "$out/tls-key.pem" "$out/tls-cert.pem"
echo "Wrote $out/tls-cert.pem and tls-key.pem (self-signed; trust it on the phone)"
echo "  JARVIS_TLS_CERT=$out/tls-cert.pem"
echo "  JARVIS_TLS_KEY=$out/tls-key.pem"
