#!/usr/bin/env bash
# Install Jarvis' local-first runtime without sudo. Everything lands under
# ~/.local/share/jarvis or the user Python / npm prefixes.
set -euo pipefail

# This optional legacy local-model installer selects Linux x86_64 binaries.
# Refuse other hosts before creating directories, installing packages or downloading.
if [ "$(uname -s)" != "Linux" ] || [ "$(uname -m)" != "x86_64" ]; then
  printf '%s\n' 'This optional installer supports Linux x86_64 only. Use the native Jarvis package and configure model/voice providers in Settings.' >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${JARVIS_DATA_DIR:-$HOME/.local/share/jarvis}"
MODELS="$DATA/models"
SRC="$DATA/src"
RUN="$DATA/run"
OLLAMA_BIN="${OLLAMA_BIN:-$HOME/.local/ollama/bin/ollama}"
OLLAMA_HOST="${OLLAMA_HOST:-127.0.0.1:11434}"
PIPER_VERSION="${PIPER_VERSION:-2023.11.14-2}"
mkdir -p "$MODELS" "$SRC" "$RUN" "$DATA/ollama-models"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }
need() { command -v "$1" >/dev/null 2>&1 || { warn "missing command: $1"; return 1; }; }

say "Node dependencies"
cd "$ROOT"
if [ -f package-lock.json ]; then npm ci; else npm install; fi

say "Python speech / OCR dependencies"
python3 -m pip install --user --upgrade faster-whisper rapidocr-onnxruntime

say "Ollama"
if [ ! -x "$OLLAMA_BIN" ]; then
  case "$(uname -m)" in
    x86_64) asset="ollama-linux-amd64.tar.zst" ;;
    aarch64|arm64) asset="ollama-linux-arm64.tar.zst" ;;
    *) warn "unsupported architecture: $(uname -m)"; exit 1 ;;
  esac
  mkdir -p "$HOME/.local/ollama"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -L --fail --progress-bar -o "$tmp/ollama.tar.zst" \
    "https://github.com/ollama/ollama/releases/download/v0.40.11/$asset"
  tar --zstd -xf "$tmp/ollama.tar.zst" -C "$HOME/.local/ollama"
  OLLAMA_BIN="$HOME/.local/ollama/bin/ollama"
fi

if ! curl -fsS --noproxy '*' "http://$OLLAMA_HOST/api/tags" >/dev/null 2>&1; then
  say "Starting Ollama in the background"
  OLLAMA_HOST="$OLLAMA_HOST" OLLAMA_MODELS="$DATA/ollama-models" \
    nohup "$OLLAMA_BIN" serve > "$RUN/ollama.log" 2>&1 &
  for _ in $(seq 1 30); do
    curl -fsS --noproxy '*' "http://$OLLAMA_HOST/api/tags" >/dev/null 2>&1 && break
    sleep 1
  done
fi

export OLLAMA_HOST
export OLLAMA_MODELS="$DATA/ollama-models"
say "Pulling local models (this is the slow part)"
for model in qwen2.5:3b nomic-embed-text; do
  if ! "$OLLAMA_BIN" list | awk '{print $1}' | grep -qx "$model"; then
    "$OLLAMA_BIN" pull "$model" | tee "$RUN/pull-$(echo "$model" | tr ':/' '--').log"
  else
    echo "already present: $model"
  fi
done
if [ "${JARVIS_SKIP_VISION:-0}" != "1" ]; then
  if ! "$OLLAMA_BIN" list | awk '{print $1}' | grep -qx "qwen2.5vl:3b"; then
    "$OLLAMA_BIN" pull qwen2.5vl:3b | tee "$RUN/pull-qwen2.5vl-3b.log"
  else
    echo "already present: qwen2.5vl:3b"
  fi
fi

say "Piper voice"
PIPER_DIR="$SRC/piper/piper"
if [ ! -x "$PIPER_DIR/piper" ]; then
  tmp="$(mktemp -d)"
  curl -L --fail --progress-bar -o "$tmp/piper.tar.gz" \
    "https://github.com/rhasspy/piper/releases/download/$PIPER_VERSION/piper_linux_x86_64.tar.gz"
  tar -xzf "$tmp/piper.tar.gz" -C "$SRC"
  rm -rf "$tmp"
fi
if [ ! -f "$MODELS/zh_CN-huayan-medium.onnx" ]; then
  base="https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/zh/zh_CN/huayan/medium"
  curl -L --fail --progress-bar -o "$MODELS/zh_CN-huayan-medium.onnx" "$base/zh_CN-huayan-medium.onnx"
  curl -L --fail --progress-bar -o "$MODELS/zh_CN-huayan-medium.onnx.json" "$base/zh_CN-huayan-medium.onnx.json"
fi

say "Checking the host"
if ! python3 -c 'import gi; gi.require_version("Gio", "2.0")' 2>/dev/null; then
  warn "Python Gio is missing; screen capture through the XDG portal will not work."
  warn "Install python3-gi with your package manager if needed (this script avoids sudo)."
fi
[ -e /dev/video0 ] || warn "No /dev/video0; camera look will be unavailable."

say "Doctor"
npm run doctor || true

cat <<EOF

Jarvis is installed under $DATA.
Start it with:
  cd $ROOT && npm start
Then open http://127.0.0.1:3081
For a desktop app window:
  bash scripts/install-desktop.sh
EOF
