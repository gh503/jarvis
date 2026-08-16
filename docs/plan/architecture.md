# Jarvis Technical Design

Status: accepted baseline for the Mac MVP; later-stage choices remain gated

## 1. Objective

Build a local-first personal Jarvis that uses DeepSeek Harness as its agent runtime, serves computers and phones, and controls smart devices through explicit adapters. The project remains independently releasable and does not maintain a fork of DeepSeek Harness.

## 2. Current Evidence

- DeepSeek Harness is an ESM TypeScript monorepo running on Node.js 22.19+ or 24+.
- The checked source revision is `47f9438`, package version `0.1.0-rc.5`.
- Dependency installation, repository typecheck, and full build passed locally.
- An out-of-tree plugin was loaded through a patch without modifying Harness.
- The plugin registered `/jarvis/health`; a live request returned HTTP 200 and an unsupported method returned HTTP 405.
- The Gateway now reaches Harness through a loopback-only HTTP bridge with a fixed five-method session allowlist; real-process verification created, listed, and read an empty session without invoking a model.
- Gateway conversation responses expose only normalized session metadata and append-origin user/assistant text; Harness paths, presets, projections, tools, reasoning, and raw events remain internal.
- Harness provides sessions, tools, model adapters, plugins, skills, MCP, subagents, jobs, workflows, schedules, workspaces, persistence, approvals, sandbox abstractions, Web UI, and host/client APIs.
- The shipped Web server has no TLS, authentication, or origin policy. It must stay on loopback behind a Jarvis-owned security gateway.
- The current SDK transport is subprocess stdio JSON-RPC. It is not a remote mobile API and lacks per-session close and prompt cancellation.
- ACP is automation-oriented, text-first, unauthenticated, and has limited session lifecycle support.
- Core audio transport, durable audio attachments, wake-word detection, ASR, TTS, mobile clients, device identities, and smart-home adapters are not shipped by Harness.

## 3. Proposed Product Boundary

### V1

- One human owner for the Mac MVP.
- Every Jarvis-owned row includes `owner_id` from the first migration.
- Text-first interaction on the primary computer and a mobile Web client.
- One always-on Jarvis Core host.
- Explicit computer actions with policy checks and approval for risky operations.
- Home Assistant as the first smart-home integration; direct vendor integrations are deferred.
- Push-to-talk voice after text workflows are reliable.

### Deferred

- Household multi-user access and voice identification.
- Always-listening mobile wake word.
- Direct support for individual smart-home vendors.
- Multi-region or cloud-scale deployment.
- Autonomous financial, physical-access, or safety-critical actions.

## 4. Architectural Decisions

### AD-01: Harness integration

Use an out-of-tree Jarvis bundle and plugins. Pin an exact Harness version or commit. Do not copy packages into the Jarvis repository and do not maintain a long-lived fork.

Rationale:

- The plugin route spike proved independent loading and host service injection.
- Harness is pre-release and warns of breaking changes.
- A compatibility package can isolate upstream changes from Jarvis domain code.

### AD-02: Network exposure

Harness listens only on `127.0.0.1`. Jarvis Gateway is the only network-facing process.

The gateway owns:

- TLS termination or private-overlay ingress.
- User and device authentication.
- Authorization and request limits.
- Versioned Jarvis APIs.
- WebSocket lifecycle and push coordination.
- Audit correlation identifiers.

The gateway uses an explicit Harness RPC allowlist and never acts as a generic reverse proxy. Mobile and device clients depend only on normalized Jarvis APIs.

### AD-03: Deployment shape

Start as a modular monolith on one always-on computer. Split services only when a measured operational requirement appears.

Initial processes:

1. `jarvis-core`: Harness profile plus Jarvis plugins.
2. `jarvis-gateway`: authenticated HTTP/WebSocket control plane.
3. `jarvis-node-agent`: computer-local capability daemon; initially co-located with the core host.

Optional later processes:

- `jarvis-voice`: streaming ASR/TTS orchestration.
- `jarvis-device-bridge`: Home Assistant and MQTT adapters.
- Additional `jarvis-node-agent` instances on other computers.

### AD-04: Client strategy

- Desktop V1: responsive Web application plus local node agent.
- Mobile V1: installable PWA for text, push-to-talk, status, and approvals.
- Mobile V2: React Native client only when background push, audio routing, Bluetooth, or native sensors justify it.
- Smart devices: MQTT/Home Assistant endpoints, not Harness runtimes.
- Voice satellites: constrained audio clients that send wake/push-to-talk utterances and play responses.

### AD-05: Internal communication

- External clients: HTTPS plus versioned WebSocket events.
- Gateway to Harness bridge: loopback HTTP/WebSocket initially; Unix domain socket is preferred when the bridge becomes independent of the Web carrier.
- Device events: Home Assistant WebSocket API and MQTT 5.
- Internal durable work: SQLite transactional outbox in V1. Do not add Redis, NATS, or Kafka until one-process delivery is insufficient.

### AD-06: Data ownership

Harness remains authoritative for agent sessions and session event logs. Jarvis owns product-domain data in a separate SQLite database.

Jarvis domain tables:

- `owners`
- `devices`
- `device_credentials`
- `capabilities`
- `commands`
- `command_attempts`
- `approvals`
- `automations`
- `memory_items`
- `memory_sources`
- `notifications`
- `audit_events`
- `outbox_events`

Jarvis stores a mapping from product conversation IDs to Harness session IDs. It does not duplicate full Harness transcripts.

### AD-07: Security posture

- Default deny for device and computer capabilities.
- Every command names actor, owner, target device, capability, arguments, risk class, expiration, and idempotency key.
- Commands expire and cannot be replayed after acknowledgement.
- High-risk actions require a current approval tied to the exact normalized command.
- Node agents make a second local policy decision; gateway authorization alone is insufficient.
- Secrets are references, never model-visible plaintext.
- Remote access starts through a private overlay network such as Tailscale; public ingress is deferred until application authentication and recovery are proven.
- Door locks, alarms, payments, credential changes, and destructive file operations remain approval-required.

### AD-08: Memory model

Use four separate memory classes:

1. Session memory: Harness event log and compaction.
2. Profile facts: user-confirmed preferences and stable personal facts.
3. Episodic memory: summaries of completed interactions with provenance.
4. Operational state: tasks, schedules, device state, and approvals in structured tables.

Memory writes are proposed by the agent but committed by deterministic policy. Sensitive classes can require user confirmation. Every memory item has provenance, confidence, timestamps, retention policy, and a delete path.

### AD-09: Voice architecture

Audio remains outside Harness until transcription completes.

Voice flow:

1. Client performs push-to-talk or local wake detection.
2. Client streams audio to the Jarvis voice endpoint.
3. VAD segments the utterance; ASR emits partial and final text.
4. Final text becomes a normal Jarvis message and then a Harness user message.
5. Committed assistant text streams to TTS.
6. A new utterance stops playback and requests turn cancellation through the in-process Jarvis Harness plugin.

Provider interfaces isolate local and cloud implementations:

- `WakeWordProvider`
- `SpeechToTextProvider`
- `TextToSpeechProvider`
- `VoiceActivityProvider`

### AD-10: Upstream compatibility

- Pin exact Harness versions.
- Keep all imports from Harness inside `packages/harness-adapter` and `packages/harness-bundle`.
- Add contract tests for session creation, prompt admission, cancellation, approval, route registration, event projection, and restart persistence.
- Upgrade Harness in dedicated pull requests only.
- Record the last verified upstream commit and migration notes.

### AD-11: Host deployment

Use the current Apple Silicon MacBook Air as the development and V1 qualification host. Run the core processes natively under `launchd`; do not place the primary Harness runtime in Docker because host file, application, notification, microphone, and approval integrations need explicit macOS access.

Development host facts verified on 2026-08-16:

- Apple Silicon with 16 GB memory.
- Supported Node.js and pnpm versions installed.
- Harness dependencies, typecheck, and full build pass.
- AC power policy disables system sleep.
- Docker CLI is installed but its daemon is not running; Docker is not required by the proposed V1.
- Tailscale, Mosquitto, and Home Assistant were not detected.

Native locations:

- Application data: `~/Library/Application Support/Jarvis/`
- Logs: `~/Library/Logs/Jarvis/`
- User launch agents: `~/Library/LaunchAgents/`
- Secrets: macOS Keychain references, never plaintext configuration values

Use separate `launchd` jobs for gateway, core, and node agent so failures and restarts remain observable. A later household deployment should move Jarvis Core to a dedicated always-on Mac mini, Linux mini PC, or home server; the MacBook then becomes an ordinary node agent and client.

Auxiliary services may use containers when they have no host-control responsibility. The core process stays native until a separate node agent proves that all host capabilities can be delegated safely.

## 5. Module Map

```text
apps/
  gateway/              Network-facing Jarvis API
  web/                  Responsive desktop/mobile client
  node-agent/           Computer capability daemon
  mobile/               Deferred native application
packages/
  protocol/             Versioned commands and events
  identity/             Owner, device pairing, sessions
  policy/               Authorization and risk classification
  audit/                Append-only audit records
  harness-adapter/      Upstream compatibility boundary
  harness-bundle/       Installable dsh bundle
  harness-bridge/       Session and event bridge plugin
  tools-core/           Jarvis-native agent tools
  memory/               Curated long-term memory
  automation/           Schedules and deterministic triggers
  device-registry/      Devices and capabilities
  device-home-assistant/Home Assistant adapter
  device-mqtt/          MQTT adapter
  voice-protocol/       Audio session state and messages
  asr/                  ASR provider interface
  tts/                  TTS provider interface
  wake-word/            Wake provider interface
  testkit/              Fake Harness, device, voice providers
infra/
  launchd/
  systemd/
  tailscale/
docs/
  decisions/
  phases/
  operations/
```

## 6. Core Protocols

### Command lifecycle

```text
requested -> policy_checked -> approval_pending? -> dispatched
          -> acknowledged -> running -> succeeded | failed | expired | cancelled
```

Required invariants:

- One terminal state per command.
- Dispatch requires an unexpired policy decision.
- Retry reuses the idempotency key and increments attempt number.
- Device acknowledgement does not imply business success.
- Completion includes target-observed evidence where the capability supports it.

### Client event envelope

```json
{
  "version": 1,
  "eventId": "...",
  "ownerId": "...",
  "deviceId": "...",
  "occurredAt": "...",
  "type": "command.succeeded",
  "correlationId": "...",
  "payload": {}
}
```

### Device pairing

1. Authenticated owner creates a short-lived pairing request.
2. New device generates a local key pair.
3. Owner verifies a displayed code on an existing trusted client.
4. Gateway issues a revocable device credential bound to the public key.
5. Device opens an outbound authenticated connection.

## 7. Delivery Stages

### Stage 0: Architecture and Harness qualification

Exit criteria:

- Exact upstream revision pinned.
- Out-of-tree plugin loads and unloads.
- Health, session, prompt, event, cancel, approval, and persistence spikes pass.
- Threat model and data classification reviewed.
- Repository skeleton and CI commands agreed.

### Stage 1: Local text Jarvis

Exit criteria:

- One owner can create and resume a conversation.
- Jarvis calls a read-only information tool and one safe local action.
- Session restart preserves conversation mapping.
- Every action produces an audit record.
- Denied and approval-required actions are visibly distinct.

### Stage 2: Computer node

Exit criteria:

- Node agent pairs with the gateway using an outbound connection.
- Capability inventory is reported and policy-filtered.
- Application launch, notification, clipboard, and bounded file operations work.
- Offline, timeout, duplicate command, and reconnect paths are tested.

### Stage 3: Mobile companion

Exit criteria:

- Installable PWA supports conversations, status, and approvals.
- Device pairing and revocation work.
- Remote access uses a private network and application device credentials.
- Push notifications do not contain sensitive plaintext by default.

### Stage 4: Smart-home integration

Exit criteria:

- Home Assistant entities map to normalized Jarvis capabilities.
- Read-state and low-risk control actions work.
- Physical-security actions require explicit approval.
- Commands expose acknowledgement and observed resulting state separately.

### Stage 5: Voice

Exit criteria:

- Push-to-talk works on desktop and phone.
- Partial transcription, final transcript, TTS playback, and interruption work.
- Audio is not retained unless the owner enables retention.
- Text fallback survives unavailable ASR or TTS providers.

### Stage 6: Memory and proactive service

Exit criteria:

- Profile facts are viewable, editable, and deletable.
- Memory retrieval includes source and confidence.
- Deterministic triggers can create notifications or proposed actions.
- No proactive high-risk action bypasses approval.

### Stage 7: Hardening and release

Exit criteria:

- Backup, restore, migration, key rotation, and device revocation are rehearsed.
- Dependency, secret, and network exposure checks run in CI.
- Upgrade compatibility tests pass against the pinned Harness revision.
- Installation and recovery documentation is executable on a clean machine.

## 8. Open Decisions

1. Select the first phone platform and confirm whether a PWA is sufficient.
2. Confirm Home Assistant availability before Stage 4.
3. Choose local, cloud, or hybrid ASR/TTS privacy posture before Stage 5.
4. Define the permanent never-autonomous action list before remote actions.
5. Decide when the service moves from the development MacBook to a dedicated always-on host.

## 9. Rejected Initial Alternatives

### Maintain a Harness fork

Rejected because the project is pre-release, changes rapidly, and explicitly encourages ecosystem plugins. A fork would make every upstream update a merge project.

### Expose Harness Web directly

Rejected because the current server has no TLS, authentication, or origin policy.

### Install Harness on phones and microcontrollers

Rejected because Harness is a Node-based host runtime. Phones and constrained devices should be authenticated clients or capability endpoints.

### Begin with always-listening voice

Rejected because it combines platform background limits, streaming audio, wake word, cancellation, privacy, and UX before the action and permission model is proven.

### Start with microservices

Rejected because a single-owner local deployment does not justify distributed consistency and operations overhead. Module boundaries remain explicit so measured splits stay possible.
