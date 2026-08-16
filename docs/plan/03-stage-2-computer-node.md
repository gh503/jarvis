# Stage 2: Safe Computer Node

Status: planned
Effort: 10-15 focused engineering days

## Objective

Separate computer capabilities from Jarvis Core through a paired node agent that maintains an outbound connection, reports capabilities, applies local policy, and returns observable command outcomes.

## Modules

### `apps/node-agent`

Deliver:

- Native macOS background process supervised by `launchd`.
- Outbound authenticated WebSocket to Jarvis Gateway.
- Device key generation and secure Keychain storage.
- Capability discovery and versioned registration.
- Command execution worker with bounded concurrency.
- Local health and diagnostic command.

Acceptance:

- No inbound listening port is required.
- Restart reconnects without creating a duplicate device.
- Revoked credential cannot reconnect.

### Device registry

Deliver:

- Device identity, display name, platform, software version, last seen, and trust state.
- Capability instances with schema version and local policy metadata.
- Pair, approve, revoke, rename, and rotate credential operations.

Acceptance:

- A device cannot claim another device's identity.
- Capability removal is reflected before new commands dispatch.

### Pairing protocol

Deliver:

- Short-lived pairing request.
- Device-generated asymmetric key pair.
- Human-verifiable code and existing-client confirmation.
- Revocable device certificate or signed token bound to the public key.

Acceptance:

- Expired and reused pairing requests reject.
- Wrong verification code cannot produce a credential.
- Revocation terminates active and future sessions.

### Command service

Deliver:

- Command state machine.
- Idempotency key and attempt tracking.
- Expiration, cancellation, acknowledgement, progress, and terminal results.
- Offline queue policy per capability; side effects default to no offline queue.

Acceptance:

- Duplicate delivery executes at most once.
- Acknowledgement is not reported as business completion.
- Expired command never executes after reconnect.

### Local policy

Deliver:

- Node-side allowlist independent of gateway policy.
- User-visible policy file or settings UI.
- Capability-specific path, application, and argument constraints.
- Local emergency pause.

Acceptance:

- Gateway approval cannot bypass a local deny.
- Policy reload affects new commands without corrupting active work.

### Initial macOS capabilities

Deliver in order:

1. System status read.
2. User notification.
3. Clipboard read/write with separate permissions.
4. Open allowlisted application or URL.
5. Read/write files inside user-selected roots with observation checks.

Do not add arbitrary shell execution in this stage.

Acceptance:

- Each capability declares input/output schema, risk, timeout, cancellation support, and result evidence.
- Filesystem writes require an observed version or explicit create-if-absent state.

### Node observability

Deliver:

- Connection state, queue depth, active commands, last failure, and version.
- Bounded local logs with secret redaction.
- Gateway-visible liveness distinct from readiness.

Acceptance:

- Offline, connected-but-unready, ready, and degraded states are distinguishable.

## Acceptance Journeys

| ID | Journey | Required observation |
|---|---|---|
| A-201 | Pair node | One approved device with bound public key |
| A-202 | Reconnect | Same identity and no duplicate execution |
| A-203 | Revoke | Active connection closes and reconnect rejects |
| A-204 | Duplicate command | One side effect and one terminal command |
| A-205 | Expired offline command | No execution after reconnect |
| A-206 | Local deny | Gateway-approved command denied by node policy |
| A-207 | File race | Changed file rejects stale write |
| A-208 | Node crash | Command settles unknown/failed, never fabricated success |

## Exit Gate

Stage 2 closes when A-201 through A-208 pass on the named Mac hardware and macOS version. Simulator-only results do not establish host integration.

## Explicit Non-Goals

- Windows and Linux node support.
- Arbitrary terminal commands.
- Screen control or computer vision.
- Remote desktop streaming.
- Mobile client.
- Smart-home devices.
