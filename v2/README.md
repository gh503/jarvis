# Jarvis v2 runtime

Local-first ambient assistant for Linux: text/voice conversation with barge-in,
on-demand screen OCR, single-frame camera, SQLite memory with consolidation and
a regression eval, reminders/daily brief, optional read-only ICS calendar,
confirmation-gated actions, revocable device pairing, backup/restore, and a
browser/PWA UI with a Studio observability surface.

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
npm run memory:eval  # 11-case recall/abstention/privacy regression suite
JARVIS_CDP_URL=http://127.0.0.1:9223 npm run ui:smoke  # browser smoke, Chrome CDP
npm run backup -- ~/jarvis-backup.tar.gz
npm run restore -- ~/jarvis-backup.tar.gz --yes   # stop Jarvis first
npm run memory -- list
npm run migrate-v1 -- /path/to/v1-memory.json
bash scripts/install-desktop.sh
bash scripts/install-service.sh
bash scripts/install-hotkey.sh '<Super>j'   # GNOME only
python3 scripts/tray.py                     # optional legacy tray (desktop-dependent)
bash scripts/gen-tls.sh 100.x.y.z            # optional self-signed LAN cert
```

See [operations.md](../docs/v2/operations.md) for privacy, remote/TLS, failure
modes and the actual latency measurements on this machine.
See [implementation-status.md](../docs/v2/implementation-status.md) for what is
implemented vs. deliberately deferred.

## Tests

62 tests cover attention, memory, server auth/CSRF, at-rest encryption,
telemetry, voice cancellation and the daily brief. `npm run memory:eval` is a
separate deterministic recall/abstention/privacy regression gate.

## Layout

```
src/attention.ts      explicit attention FSM (no LLM gate)
src/conversation.ts   turn orchestration, intents, voice, memory grounding
src/memory/           SQLite source, FTS/vector recall, extraction
src/model/ollama.ts   local LLM / embedding / vision adapter
src/senses/           portal screen capture, camera frame, OCR-first vision
src/voice/            faster-whisper worker client, Piper TTS
src/proactive/        reminders, interruption policy, read-only ICS
src/brief.ts           deterministic daily brief + scheduler
src/devices.ts         hashed, revocable device tokens
src/notify.ts          optional notify-send delivery
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
- Desktop pair codes are one-use/5-minute; device tokens are stored as SHA-256
  hashes and can be revoked. They currently have full owner scope.
- Captures, TTS audio and persisted traces are AES-256-GCM encrypted at rest
  (`data/secret.key`, 0600). The memory DB is not full-disk encrypted; see
  `docs/v2/security.md` for the exact boundary.
- `npm run backup` excludes auth tokens, API keys, audio and captures by default.
- Settings → 隐私 can export all memory or erase local data with an explicit
  confirmation phrase.
- First launch shows a one-time model/microphone/senses checklist; Skip never
  repeats the prompt.
