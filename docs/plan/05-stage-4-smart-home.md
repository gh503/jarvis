# Stage 4: Home Assistant and MQTT Device Integration

Status: in progress
Effort: 8-12 focused engineering days

## Objective

Give Jarvis a normalized, policy-controlled view of home devices and allow bounded actions whose acknowledgement and resulting physical state are separately observable.

## Integration Order

1. Home Assistant read-only entity discovery and state subscription.
2. Low-risk Home Assistant service calls.
3. High-risk physical actions with phone approval.
4. MQTT adapter for custom or constrained devices.
5. Device-health and unavailable-state handling.

Direct vendor cloud integrations are deferred; Home Assistant is the compatibility layer.

## Modules

### Home Assistant deployment decision

Deliver:

- Named Home Assistant host, version, backup method, and owner.
- Private-network placement.
- Dedicated Jarvis integration credential stored as a secret reference.
- Minimal entity exposure list.

Acceptance:

- Jarvis cannot access entities outside the exposed set.
- Revoking the integration credential stops access without affecting Home Assistant administration.

### `src/device-registry`

Current increment: normalized registry core only. It is provider-independent and does not connect to Home Assistant, MQTT, or physical devices.

Deliver:

- Normalized devices, capabilities, locations, reported state, availability, and source adapter.
- Stable mapping from external entity ID to Jarvis capability ID.
- Manual aliases and risk overrides.

Acceptance:

- Entity rename or disappearance does not silently target another device.
- Duplicate external identities fail visibly.

Implemented in the current increment:

- Deterministic normalized device and capability records.
- Stable source/entity/capability identifiers, aliases, and explicit risk overrides.
- Reported state timestamps and availability transitions; disappearance clears stale state.
- Serializable records exclude credentials and raw provider payloads.

Deferred to later increments:

- Home Assistant discovery/subscription and medium/high-risk service calls.
- MQTT transport and duplicate-delivery handling.
- Simulator protocol behavior and real-device acceptance.

### `src/home-assistant`

Current increment: read-only Home Assistant WebSocket protocol core tracked by [#58](https://github.com/gh503/jarvis/issues/58). It accepts an injected socket and does not require or persist a real deployment credential.

Deliver:

- Authenticated Home Assistant WebSocket connection.
- Initial snapshot and state-change subscription.
- Service-call adapter with request correlation.
- Reconnect, resubscribe, and full-resync behavior.

Implemented in the current increment:

- Authenticated `auth_required`/`auth_ok` handshake with credentials kept in memory only.
- Deterministic `get_states` normalization for the supported capability domains.
- `state_changed` filtering, monotonic source timestamps, and removed-entity unavailable callbacks.
- Degraded status plus bounded reconnect with a fresh authentication, snapshot, and subscription sequence.

Deferred to later increments:

- Owner-provided Home Assistant endpoint and credential reference.
- Real network and named-instance acceptance.
- Real Home Assistant service behavior and physical-device acceptance.

### Low-risk service reconciliation

Current increment: bounded service calls and observed-state reconciliation tracked by [#60](https://github.com/gh503/jarvis/issues/60).

Implemented in the current increment:

- Allowlisted `switch.set`, `light.set`, and ordinary `media.play_pause` calls only.
- Entity and capability binding before network dispatch, plus idempotency-key deduplication.
- Separate `submitted` and `acknowledged` transitions from terminal physical outcomes.
- `succeeded` requires a later matching `state_changed` observation; unchanged state becomes `acknowledged-unconfirmed`.
- Disconnects and entity removal produce `unavailable`; command and provider payloads are not returned.

Deferred to later increments:

- Medium/high-risk capability dispatch and phone approval.
- Real Home Assistant service behavior and physical-device evidence.

### High-risk approval gate

Current increment: exact, single-use high-risk approval contract tracked by [#62](https://github.com/gh503/jarvis/issues/62). It is a local policy core and does not dispatch a lock or alarm service.

Implemented in the current increment:

- `lock.set` and `alarm.set` remain mandatory `high` risk; registry overrides cannot lower that floor.
- Approval views expose normalized target/action metadata, digest, expiry, and risk only.
- Authorization consumes the unchanged command once; mutation, expiry, replay, and cancellation fail closed.
- The authenticated Gateway exposes pending records at `GET /v1/device-approvals` and decisions at `POST /v1/device-approvals/:id/decision`, without service payloads or credentials.

Deferred to later increments:

- Real Home Assistant deployment and owner-provided credential reference.
- Physical lock/alarm service calls and hardware acceptance.

### Approved Home Assistant high-risk dispatch

Current increment: approved high-risk Home Assistant service dispatch tracked by [#70](https://github.com/gh503/jarvis/issues/70).

Implemented in the current increment:

- `HomeAssistantAdapter.callService()` continues to reject `lock.set` and `alarm.set`.
- `callApprovedService()` requires a valid, unexpired `DeviceApprovalAuthorization` whose digest matches the complete normalized command.
- Only explicit lock and alarm service names are accepted; the existing service acknowledgement, observed-state reconciliation, timeout, unavailable, and idempotency outcomes are reused.
- Approval and provider credentials remain outside public command results and adapter serialization.

Deferred to later increments:

- Wiring a real Jarvis device command producer to this adapter.
- Named Home Assistant instance, real lock/alarm behavior, and physical acceptance evidence.

### Real-time approval events

Current increment: normalized smart-device approval lifecycle events tracked by [#68](https://github.com/gh503/jarvis/issues/68).

Implemented in the current increment:

- Approval sources can publish `device.approval.pending` and `device.approval.resolved` through the authenticated retained Gateway event stream.
- Events use an explicit public allowlist and exclude service data, provider credentials, owner tokens, and raw adapter payloads.
- PWA clients converge their smart-device approval list from live events and cursor-based replay without requiring polling.
- Notification records use fixed redacted text and never include target service data.

Deferred to later increments:

- Dispatching an approved lock or alarm command through a real adapter.
- Real Home Assistant or MQTT deployment evidence and physical-device acceptance.

### Trusted approval execution handler

Current increment: trusted in-process approval-to-adapter execution tracked by [#72](https://github.com/gh503/jarvis/issues/72).

Implemented in the current increment:

- `InMemoryDeviceApprovalStore` can invoke a trusted execution handler only after an allowed decision has passed exact digest, expiry, and idempotency checks.
- The handler receives the original command and private authorization; public receipts and retained events remain normalized.
- The Home Assistant fake-socket test covers the complete decision-to-service-call-to-observed-state path.

Deferred to later increments:

- Cross-process runtime configuration between the Harness tool producer and Gateway-owned device bridge.
- Real Home Assistant credentials, deployment, and physical-device evidence.

Acceptance:

- Reconnect does not duplicate state events or service calls.
- Unavailable Home Assistant produces degraded status, not stale success.

### Normalized capability model

Initial capability classes:

- `sensor.read`
- `switch.set`
- `light.set`
- `climate.set_target`
- `media.play_pause`
- `cover.set`
- `lock.set`
- `alarm.set`

Each capability declares input schema, units, target state, risk class, timeout, approval rule, acknowledgement evidence, and resulting-state evidence.

Default risks:

- Sensor reads: read.
- Lights and ordinary media: low.
- Climate and covers: medium.
- Locks and alarms: high and always approval-required.

### Physical command reconciliation

Deliver:

- Service-call acknowledgement captured separately from entity state.
- Expected-state predicate and observation deadline.
- Outcomes: succeeded, acknowledged-unconfirmed, failed, timed-out, unavailable.
- Idempotency behavior per capability.

Acceptance:

- A successful API response without target state never reports physical success.
- Late state updates reconcile without creating a second command.

### `packages/device-mqtt`

Deliver:

- MQTT 5 client with TLS and per-device credentials where supported.
- Versioned topics for presence, capabilities, reported state, commands, acknowledgements, and results.
- Retained presence/state policy and message expiry.
- Duplicate delivery handling.

Proposed topic family:

```text
jarvis/v1/devices/{deviceId}/presence
jarvis/v1/devices/{deviceId}/capabilities
jarvis/v1/devices/{deviceId}/state/reported
jarvis/v1/devices/{deviceId}/commands
jarvis/v1/devices/{deviceId}/acks
jarvis/v1/devices/{deviceId}/results
```

Acceptance:

- Expired retained commands never execute on reconnect.
- Device credentials cannot publish as another device.
- Duplicate QoS delivery produces at most one side effect.

### Simulation and hardware fixtures

Deliver:

- Deterministic Home Assistant fake for CI.
- MQTT fake device supporting delay, duplicate, disconnect, and contradictory state.
- Named real device list for acceptance.

Acceptance:

- CI covers protocol failures.
- Final exit evidence includes at least one real low-risk device and one real approval-required capability, or explicitly defers the latter without claiming full physical-control completion.

## Acceptance Journeys

| ID | Journey | Required observation |
|---|---|---|
| A-401 | Entity discovery | Exposed entities map once to stable capabilities |
| A-402 | Read current state | Result reflects latest subscribed state and timestamp |
| A-403 | Low-risk control | API acknowledgement plus observed target state |
| A-404 | Acknowledged but unchanged | Outcome is unconfirmed, never success |
| A-405 | High-risk control | Exact phone approval required before dispatch |
| A-406 | Adapter reconnect | Full resync without duplicate action |
| A-407 | MQTT duplicate | One side effect under duplicate delivery |
| A-408 | Offline device | Expired command does not run after return |

## Exit Gate

Stage 4 closes when A-401 through A-408 pass with the simulator suite and named real Home Assistant/device evidence.

## Explicit Non-Goals

- Direct integrations for every device vendor.
- Safety certification.
- Autonomous lock or alarm control.
- Running Harness on microcontrollers.
- Treating network acknowledgement as physical success.
