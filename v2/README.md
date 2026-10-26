# Jarvis v2 runtime

Local-first ambient assistant for Linux: text/voice conversation, on-demand
screen OCR, single-frame camera, SQLite memory, reminders and a browser/PWA UI.

## Quick start

```bash
npm install
npm run setup        # user-local models/binaries; downloads are the slow part
npm run doctor
npm start            # http://127.0.0.1:3081
```

Requires Node 24, Python 3.10, Ollama, ffmpeg, `arecord`, and (for screen)
`python3-gi` + an XDG Desktop Portal. The setup script installs Ollama, Piper,
faster-whisper and RapidOCR into the user's home; it does not use sudo.

## Commands

```bash
npm run typecheck
npm test
npm run acceptance   # unattended API/voice/OCR checks
npm run memory -- list
npm run migrate-v1 -- /path/to/v1-memory.json
bash scripts/install-desktop.sh
bash scripts/install-service.sh
```

See [operations.md](../docs/v2/operations.md) for privacy, remote/TLS, failure
modes and the actual latency measurements on this machine.
See [implementation-status.md](../docs/v2/implementation-status.md) for what is
implemented vs. deliberately deferred.

## Layout

```
src/attention.ts      explicit attention FSM (no LLM gate)
src/conversation.ts   turn orchestration, intents, voice, memory grounding
src/memory/           SQLite source, FTS/vector recall, extraction
src/model/ollama.ts   local LLM / embedding / vision adapter
src/senses/           portal screen capture, camera frame, OCR-first vision
src/voice/            faster-whisper worker client, Piper TTS
src/proactive/        reminders and interruption policy
src/server.ts         HTTP/WS auth, static PWA, APIs
web/                  dependency-free UI/PWA
scripts/              setup, workers, desktop/systemd installers, acceptance
```

## Privacy defaults

- Loopback only; remote requires both a ≥24-char token and TLS.
- Screen capture only through the portal; no framebuffer/recording fallback on
  native Wayland.
- Camera single frame only; no video retention.
- `sensitive` memories are excluded from normal model recall; `secret` too.
- Proactive speech is gated by focus, quiet hours and a daily budget.
- The vision model is an explicit slow path, not the real-time default.
