# Jarvis v2 runtime

**产品官网：[Jarvis — 让日常工作少一点重复](https://gh503.github.io/jarvis/)** · 面向开发者、办公用户与一人公司，包含场景介绍与安装入门。官网通过 GitHub Pages 发布，仅展示公开产品信息，不连接用户运行实例。

官网源码位于 `site/`；修改该目录并推送到 `main` 后，`Product website` 工作流会自动发布。也可在 GitHub Actions 中手动运行该工作流。

Start with [上手指南](docs/getting-started.md) for **native preview or source** instructions,
and [分发说明](docs/distribution.md) for platform limits and release gates.
Windows, macOS and Linux have native runtime lifecycle support and Node 24 portable
package matrices. **Unsigned native portable previews are published** for Linux x64, Windows x64
and macOS arm64 at the recommended [v2.0.40](https://github.com/gh503/jarvis/releases/tag/v2.0.40). They are
not signed installers or a guarantee of stable production readiness or full feature parity.
The in-app `/providers` and `/install` pages help configure models and browser clients.

Local-first assistant with text/voice conversation with barge-in,
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

## Automatic GitHub releases

A verified push to `main` publishes a GitHub Release and an immutable
`vMAJOR.MINOR.PATCH` tag for that exact commit. Superseded, untagged commits are
skipped so a slower CI run cannot publish older code as the newest release. Pull requests and other branches
never publish. The first current-runtime release starts at `v2.0.0`; subsequent
commits increment the latest stable patch version. Raising the version in
`package.json` sets a new minimum release version for a major/minor transition.
Release tags identify individual deliveries; the application's runtime version
is maintained separately.

Re-running the same commit reuses its existing tag and release. If tag creation
succeeds but publication fails, re-run the failed CI release job to finish it;
existing tags are never moved or overwritten. Release jobs are serialized, and
publication requires the type check and test job to succeed. GitHub generates
release notes and source archive downloads. This does not publish to npm or
create platform installers. The workflow uses GitHub's built-in token, with
repository write permission limited to the release job.

## Native preview status

For the pinned v2.0.40 preview, the three-platform automated release gates passed for runtime lifecycle and
bundled Node 24 packages, including packaged privacy, backup and updater checks
and Windows Unicode shortcut activation. This covers the hosted runner targets,
not every OS/CPU pair or interactive desktop environment.

Download the archive matching your OS/CPU, its SHA256 and provenance from
[v2.0.40](https://github.com/gh503/jarvis/releases/tag/v2.0.40), verify the archive,
and extract into a stable writable folder. Each of the three targets has these
three files. Other builds may be available as conditional unsigned CI previews in
[Actions](https://github.com/gh503/jarvis/actions); source instructions remain below.
Publication is enabled but requires all three build gates; see the
[release pipeline](docs/native-release-pipeline.md).

Portable packages include `scripts/install-native.ts` for a macOS `.app` wrapper
or Windows Start menu shortcuts, with optional next-login startup and private
external configuration via `--install --config ABS`. The app launcher also accepts
`--config ABS` for launch and stop; see [configuration binding](docs/native-install.md#optional-private-external-configuration). They point to
the extracted folder and are **unsigned, not notarized**. See [native installation](docs/native-install.md).
The updater only verifies/stages candidates, runs isolated health checks and
abandons a stage on rollback: **there is no automatic activation**. Explicit
reinstallation into a separate folder is required; isolated readiness does not
prove existing-data migration compatibility. See [native updates](docs/native-update.md).
Production readiness still needs representative interactive native validation
and signing/notarization; full platform
parity and transactional update activation remain unfinished. Desktop notifications use
`notify-send` on Linux and `osascript` on macOS. Windows toast support requires
explicit native installation of Jarvis’s own identity; visible delivery remains
unverified and can be suppressed by system settings or session policy.

v2.0.40 also ships an offline [data-only snapshot CLI](docs/native-state-snapshot.md):
stop the runtime and all other writers, create a snapshot, verify it against a separately
trusted manifest digest, and restore only to a fresh directory. It preserves all supported
data, including original secrets and SQLite WAL, except documented root coordination
files. External config, external paths and installer integrations are outside its scope;
it does not activate a release or establish schema compatibility.
The shared lifecycle-lock guard rejects hardlinks, symlinks and nonregular SQLite
main/sidecar entries before SQLite mutation. Main database identity must stay stable;
normal sidecar removal and recreation are allowed. This does not guarantee protection
against hostile same-user filesystem races.

## Native tools and local work

Enable native tool calling explicitly for a supported model in 设置 → 模型.
Each tool turn stays on the selected concrete model; local results never fail
over to a remote provider. Settings → 系统 exposes the tool/MCP catalogue and
local tool settings. The application provides more than forty built-in tools, with definitions loaded according to configuration, permissions
and model context capacity; MCP adds separately configured tools.

Built-ins cover structured questions, time/unit arithmetic, daily/weekly
reminders, ordinary memory proposals/corrections, eligible conversation history,
local perception, scoped file reading/editing/restoration, artifact delivery,
plans, background jobs, anonymous DuckDuckGo search/public-page fetching and
local Markdown skills. Memory proposals remain candidates pending human
confirmation. Questions collect information and do not grant tool permissions.
See [本地工具与权限说明](docs/ui.md#本地工具任务与目录授权) for the exact names,
API routes, privacy boundaries and recurrence behavior.

The v2.0.40 preview supports `file_read`, `file_list` and `file_search` on macOS/Windows
through the native filesystem helper: explicitly authorize at most 16 read roots;
text reads are UTF-8 and limited to 1 MiB, with secret-path filtering and private-key content rejection.
Native writes, output workspace operations, artifact delivery, image inspection
and Shell remain unavailable on macOS/Windows. Linux retains its existing scoped
file writes and sandboxed Shell. Read-only Markdown skills were already supported
on all three platforms; macOS/Windows use the native filesystem helper.
External file grants are empty by default; web and Shell are disabled, and no
skill directory or external account is configured. File replacement requires
the version returned by a prior read and creates private recovery history.
Shell requires a working Linux Bubblewrap sandbox and per-call approval: it
has read-only system binaries, a writable dedicated Jarvis output directory,
no network, and no inherited host credentials. File-tool directory grants do
not grant Shell access. Background jobs expose explicit pending/running/terminal
states and bounded output; stopping does not undo writes, and a restart marks
unfinished jobs interrupted rather than replaying commands. Skills require an explicitly
configured folder in Settings → 系统, accept Markdown files up to 64 KiB, and
are untrusted guidance that cannot grant permissions. Loading executes nothing. Image inspection
requires a working local vision model. Long-term autonomous goals, subagents
and browser automation are not provided.

**Full privacy erase deletes everything in the dedicated Jarvis output
workspace**, including changed artifacts and unregistered Shell output, plus
private recovery history and task state. External originals are preserved;
previous approved edits to them are not rolled back. Artifact cards reference
live files with version checks, not immutable copies. Ordinary backups include
private local tool state, file history, output artifacts and task output;
provider/MCP credentials still require `--include-secrets`. Restored external
file grants, web, Shell and skills are disabled until reauthorized. Stop Jarvis
before a cross-file-consistent backup and before restoring; separate database
snapshots do not guarantee one shared instant with output files.

## Service connections without MCP configuration

Open **设置 → MCP** for the curated life, office, developer and
general service catalogue. Each card supplies official credential links, setup
steps, usage examples and limitations. Users enter only the required key/token
or account fields; Jarvis maintains endpoints, commands and transport settings.
**高级：自定义 MCP** remains available for custom servers, but cannot edit or
impersonate reserved preset connections.

| Service | Required fields | Current scope |
|---|---|---|
| Amap | Web Service Key | Read-only places, routes, distances and weather; hotel/scenic POIs are not live booking inventory |
| QWeather | API Key + account API Host | City lookup, current weather and daily forecast through a Jarvis adapter of the official API, not an official QWeather MCP |
| Tavily | API Key | Public search and extraction with source links; no crawl/research tools |
| Context7 | API Key | Library and technical-documentation queries; no management access required |
| GitHub | Fine-grained PAT | Selected repositories and read-only contents, issues and PRs; no commits or merges |
| Notion | Notion MCP Token | Conditional Business/Enterprise owner access; ordinary REST Integration Tokens are not interchangeable |
| Feishu documents | App ID + App Secret | Application-authorized docx content and wiki-node lookup by explicit document ID/node token; no search, personal OAuth, spreadsheet editing, uploads or messaging |
| Jira / Confluence | Account email + scoped API Token | Organization must allow MCP API-token authentication; scoped read/search only, no OAuth or generic execution |

WPS and hotel/ticket booking are explicitly **unavailable informational cards**:
no credential collection and no pretend connection. Local file tools do not imply
full Office-format support; map locations do not imply prices, availability or
orders. QWeather requires the host assigned in its console, uses latitude before
longitude, retains source attribution, and remains subject to the provider's
announced API Key limitations. Feishu uses a Jarvis adapter of official APIs and
application identity, not the user's personal permissions.

**Save → verify → manually enable.** Saving credentials disables the connection
and requires fresh verification. Verification only initializes MCP and discovers
tools; it does not execute a business query or establish account balance/resource
access. Local adapters may handshake successfully before the provider checks the
key on the first actual query. All current presets use explicit read-only tool
allowlists; unknown/new tools are denied. Results default to local-model use, and
requests are treated as remote even when the adapter runs through local stdio.

Disabling retains credentials. Disconnecting deletes local credentials but does
not revoke provider-side authorization; use the card's official revocation link
for that. Saved fields are never echoed; blank edits preserve existing values.
Private `mcp-config.json` is stored with mode `0600` and enters backups only with
`--include-secrets`. Restore disables every MCP connection and clears preset
verification, requiring verification and manual enablement again. This also
applies to retained destination credentials when the archive omits secrets;
provider-side authorization is not revoked.
No personal-account OAuth flow is currently implemented. See the
[service catalogue guide](docs/ui.md#服务连接只填写必要凭据) for official links,
minimal permissions and the exact connection lifecycle. A successful connection
check is not a claim of live credential-backed integration testing.

## Quick start

```bash
git clone https://github.com/gh503/jarvis.git
cd jarvis
npm ci
npm run app          # starts the server and opens its browser UI
```

Every preset also carries a short, curated list of model ids — chat, vision and
embedding — shown as copy-on-click chips on the guide page and offered as a
picker/autocomplete in 设置 → 模型, so you are not expected to retype ids from
memory. The lists are a convenience, not a contract: “获取模型列表” still wins.

The same guide covers speech: `/providers#voice` lists nine ASR and eight TTS
presets (local, mainland, international) and hands any of them into
设置 → 语音 with the adapter, endpoint, model and voice already filled, plus
alternative model and voice ids for each preset.
ASR and TTS are each an **ordered chain**: add several providers, put the local
engine last as the safety net, and a failing provider (quota, bad key, rate
limit, network) is parked and skipped automatically — the same rule the LLM
provider pool uses.

`npm run app` uses the Chromium `--app=` mode, so there is no Electron and no
installer; `npm start` alone still serves <http://127.0.0.1:3081>. First-run
users who do not want to configure anything by hand should open
<http://127.0.0.1:3081/providers>, pick a provider, and paste one API key.

Source requires **Node.js >=24** and Git. For optional native file reading and skills on macOS/Windows,
run `npm run native:build` with Rust 1.94+ and the platform build toolchain.
Portable builds bundle the compiled helper; users do not need a compiler to run it.
Core chat with a configured remote
model needs neither Python nor Ollama. Local models are optional; local ASR
requires Python/faster-whisper, and local TTS requires an installed engine/voice.
Cloud ASR and TTS each require provider configuration. The optional legacy
`npm run setup` installer supports Linux x64 only and downloads local components.

Browser screen/camera capture is an explicit single-frame preview on supported
browsers; image analysis requires a local vision model and stays local-only.
OS/server screen and camera capture remain Linux-only, with portal/ffmpeg and
other relevant dependencies. Browser support and permissions still apply.

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
npm run restore -- ~/jarvis-backup.tar.gz --yes   # stop Jarvis first
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

The current full regression result is **828 tests: 804 passed, 24 skips,
0 failed**. The suite (`npm test`) covers attention, memory and its
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
- Browser screen/camera preview is explicit, single-frame and local-only for vision.
  Linux OS screen capture uses the portal; no framebuffer/recording fallback on
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
