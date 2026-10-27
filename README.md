# Jarvis v2 runtime

Install it as an app and hand it to someone who has never opened a terminal:
[getting-started.md](docs/getting-started.md) is the five-minute path, and
[distribution.md](docs/distribution.md) explains the three delivery forms
(PWA install on every platform including phones, `npm run app` desktop window,
`npm run package` portable bundle). The in-app pages `/providers` and `/install`
do the same job without reading any docs.

Local-first ambient assistant for Linux: text/voice conversation with barge-in,
on-demand screen OCR, single-frame camera, SQLite memory with consolidation and
a regression eval, reminders/daily brief, optional read-only ICS calendar,
confirmation-gated actions, revocable device pairing, backup/restore, and a
browser/PWA UI with a Studio observability surface and a dark / light /
follow-system theme switch (topbar button, remembered per browser). LLM
providers support OpenAI Chat Completions, OpenAI Responses and Anthropic
Messages with automatic model discovery, plus a provider pool with
priority-chain failover (quota, rate-limit, auth and network failures switch
to the next provider with a persisted cooldown) and work scenarios
(chat/coding/writing/reasoning) with per-scenario chains, models, temperatures
and system prompts. ASR/TTS can
switch between local and remote independently.

## Quick start

```bash
npm install
npm run setup        # user-local models/binaries; downloads are the slow part
npm run doctor
npm run app          # starts the server and opens it as a desktop window
```

The same guide covers speech: `/providers#voice` lists nine ASR and eight TTS
presets (local, mainland, international) and hands any of them into
设置 → 语音 with the adapter, endpoint, model and voice already filled.
ASR and TTS are each an **ordered chain**: add several providers, put the local
engine last as the safety net, and a failing provider (quota, bad key, rate
limit, network) is parked and skipped automatically — the same rule the LLM
provider pool uses.

`npm run app` uses the Chromium `--app=` mode, so there is no Electron and no
installer; `npm start` alone still serves <http://127.0.0.1:3081>. First-run
users who do not want to configure anything by hand should open
<http://127.0.0.1:3081/providers>, pick a provider, and paste one API key.

Requires Node 24, Python 3.10, Ollama, ffmpeg, `arecord`, and (for screen)
`python3-gi` + an XDG Desktop Portal. The setup script installs Ollama, Piper,
faster-whisper and RapidOCR into the user's home; it does not use sudo.

## Commands

```bash
npm run typecheck
npm test
npm run acceptance   # unattended API/voice/OCR checks against the running server
npm run acceptance:full  # boots a throwaway instance and re-checks everything end to end
npm run app              # desktop window (Chromium --app), starts the server if needed
npm run package          # portable bundle for this OS (bundles the Node runtime)
npm run memory:eval  # 11-case recall/abstention/privacy regression suite
JARVIS_CDP_URL=http://127.0.0.1:9223 npm run ui:smoke  # browser smoke, Chrome CDP
JARVIS_SMOKE_UI=1 npm run acceptance:full  # also drives the real UI (needs Chrome on :9223)
npm run backup -- ~/jarvis-backup.tar.gz
npm run restore -- ~/jarvis-backup.tar.gz --yes   # stop Jarvis first; --force skips the pgrep guard
npm run memory -- list
npm run migrate-v1 -- /path/to/v1-memory.json
bash scripts/install-desktop.sh
bash scripts/install-service.sh
bash scripts/install-hotkey.sh '<Super>j'   # GNOME only
python3 scripts/tray.py                     # optional legacy tray (desktop-dependent)
bash scripts/gen-tls.sh 100.x.y.z            # optional self-signed LAN cert
```

See [operations.md](docs/operations.md) for privacy, remote/TLS, failure
modes and the actual latency measurements on this machine, and
[providers-guide.md](docs/providers-guide.md) for per-provider setup
(domestic and international, with key links and pricing notes), and
[voice-providers.md](docs/voice-providers.md) for ASR/TTS providers.
See [implementation-status.md](docs/implementation-status.md) for what is
implemented vs. deliberately deferred. Model protocols are documented in
[models.md](docs/models.md); voice transports and the WebSocket contract
are in [voice.md](docs/voice.md).

## Tests

The suite (`npm test`, 100+ cases) covers attention, memory and its
sensitive-data boundaries, server auth/CSRF/host checks, at-rest encryption,
telemetry, voice cancellation, LLM protocols/model discovery and voice routing.
`npm run memory:eval` is a separate deterministic recall/abstention/privacy
regression gate, `npm run acceptance:full` boots a throwaway instance and
exercises the running server end to end, and `npm run ui:smoke` drives the real
UI over Chrome DevTools.

## Layout

```
src/attention.ts      explicit attention FSM (no LLM gate)
src/conversation.ts   turn orchestration, intents, voice, memory grounding
src/memory/           SQLite source, FTS/vector recall, extraction
src/model/            Ollama + OpenAI Chat/Responses + Anthropic adapters, routing
src/voice/             local faster-whisper/Piper plus remote ASR HTTP/WS and TTS
src/senses/           portal screen capture, camera frame, OCR-first vision
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
  `docs/security.md` for the exact boundary.
- `npm run backup` excludes auth tokens, API keys, audio and captures by default.
- Settings → 系统 → 隐私数据 can export memory, reminders and devices as JSON,
  or erase local data with an explicit confirmation phrase. Erasing also resets
  saved providers (their API keys), closes live connections, clears in-memory
  history and rotates the encryption key.
- First launch shows a one-time model/microphone/senses checklist; Skip never
  repeats the prompt.
