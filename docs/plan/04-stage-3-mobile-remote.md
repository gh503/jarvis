# Stage 3: Mobile Companion and Private Remote Access

Status: in progress
Effort: 8-12 focused engineering days

## Objective

Allow the owner to converse with Jarvis, observe status, and approve actions from a paired phone over a private network without exposing DeepSeek Harness directly.

## Platform Baseline

- V1 client is an installable responsive PWA.
- First acceptance device must be named before platform-specific adaptation or physical installation qualification.
- Native mobile development remains deferred until a required capability fails the PWA gate.
- Background always-listening voice is explicitly outside this stage.

The platform-independent increments tracked in [#42](https://github.com/gh503/jarvis/issues/42), [#44](https://github.com/gh503/jarvis/issues/44), [#46](https://github.com/gh503/jarvis/issues/46), and [#48](https://github.com/gh503/jarvis/issues/48) serve a scoped responsive PWA shell, owner-approved browser pairing, authenticated text conversations with cursor-based live synchronization, and a Harness-backed approval inbox. The browser keeps an origin-bound private key, claims an encrypted device credential without receiving the Owner Token, and obtains a short-lived Gateway session. Approval allows require the exact live `jarvis_open_app` call, matching audit/request evidence, the existing normalized digest, and its original 60-second expiry; unsupported or replay-only requests cannot be remotely allowed. The upstream response uses the stable private `rpcId` through `POST /api/respond`, while the public Gateway API exposes only the normalized approval id. Offline startup renders only a bounded normalized conversation snapshot marked stale, clears approval details from memory, and disables mutations. Physical installation remains unqualified until the owner names the first iPhone or Android device.

## Modules

### Private ingress

Deliver:

- Tailscale or an equivalent private overlay between the phone and Jarvis Gateway.
- Gateway remains the only network-facing Jarvis application process.
- TLS and authority validation on every remote request.
- Documented network recovery path.

Acceptance:

- Harness remains bound to loopback.
- A device outside the private network cannot reach Jarvis.
- An authenticated private-network device without Jarvis credentials still rejects.

### Application authentication

Deliver:

- Short-lived access sessions backed by a paired device credential.
- Refresh rotation with reuse detection.
- Device-bound session inventory and remote sign-out.
- CSRF and WebSocket origin protections appropriate to the selected credential transport.

Acceptance:

- Stolen expired access material cannot refresh.
- Reusing an old refresh token revokes the credential family.
- Revoking a phone closes active event streams and rejects new requests.

### PWA application

Deliver:

- Installable manifest and offline application shell.
- Conversation list, message composer, event stream, action timeline, approvals, and device status.
- Responsive layouts for phone and desktop.
- Clear offline and stale-state indicators.

Acceptance:

- Offline UI never presents cached device state as current.
- Reconnect resumes events from a cursor or performs an authoritative refresh.
- Long action names and errors fit supported phone sizes without overlap.

### Approval inbox

Deliver:

- Pending approval list with normalized action, target, arguments, risk, expiry, and requesting conversation.
- Allow once, reject, and cancel choices.
- Optional local biometric confirmation only after a native capability decision.

Acceptance:

- Expired approval cannot be acted upon.
- UI cannot approve a changed command digest.
- Approval response is idempotent across retry and reconnect.

### Notifications

Deliver:

- In-app notifications first.
- Web Push feasibility probe on the named phone platform.
- Notification preferences, quiet hours, and per-category rate limits.
- Redacted lock-screen content by default.

Acceptance:

- Notification tap opens the exact current resource after authentication.
- Revoked devices stop receiving pushes.
- Sensitive command arguments are absent from default notification payloads.

### API synchronization

Deliver:

- Monotonic event cursor per owner/device.
- Snapshot plus incremental event synchronization.
- Bounded replay retention and explicit resync response.
- Client-generated idempotency keys for mutations.

Acceptance:

- Duplicate, delayed, and out-of-order frames converge to authoritative state.
- A replay gap triggers full refresh rather than silent omission.

## PWA-to-Native Decision Gate

Build a native mobile application only when one or more validated requirements cannot be met acceptably by the PWA:

- Reliable push behavior on the target platform.
- Background audio or Bluetooth routing.
- Native biometric confirmation.
- Camera, contacts, calendar, or location access with required background semantics.
- App-store distribution or managed-device policy.

If triggered, reuse `packages/protocol` and the Gateway API. Do not embed Harness in the mobile application.

## Acceptance Journeys

| ID | Journey | Required observation |
|---|---|---|
| A-301 | Pair phone | One trusted phone with revocable credential |
| A-302 | Remote conversation | Message and response observed on phone and core |
| A-303 | Remote approval | Exact pending command executes once after approval |
| A-304 | Token reuse | Credential family revoked and event stream closed |
| A-305 | Offline/reconnect | Stale marker shown, then cursor catch-up or full refresh |
| A-306 | Phone revocation | Requests and pushes stop immediately |
| A-307 | Private-network loss | No fallback to insecure public access |
| A-308 | Push privacy | Locked phone shows no sensitive argument text |

## Exit Gate

Stage 3 closes when A-301 through A-308 pass on the named physical phone over both local Wi-Fi and a remote mobile network.

## Explicit Non-Goals

- Public Internet exposure without a private overlay.
- Household accounts.
- Background always-on microphone.
- Native app unless the decision gate triggers.
- Phone-hosted Harness runtime.
