# Jarvis Module Dependency Map

Status: planned

## Dependency Direction

```text
apps -> product services -> domain packages -> protocol/utilities
                              |
                              +-> harness-adapter -> pinned Harness packages
adapters -> provider interfaces -> domain packages
```

Domain packages never import application packages or concrete adapters. Only `harness-adapter` and `harness-bundle` import DeepSeek Harness packages directly.

## Module Inventory

| Module | First stage | Runtime | Primary dependencies | Owns persistent data |
|---|---:|---|---|---|
| `protocol` | 0 | Shared | None | No |
| `identity` | 0 | Gateway | Protocol, storage | Owners, devices, credentials |
| `policy` | 0 | Gateway/node | Protocol | Policies and decisions where retained |
| `audit` | 1 | Gateway | Identity, protocol, storage | Audit events |
| `harness-adapter` | 0 | Core | Pinned Harness | No |
| `harness-bundle` | 0 | Core | Harness adapter/bridge | Profile configuration only |
| `harness-bridge` | 0 | Core | Harness adapter, protocol | No independent authority |
| `conversation` | 1 | Gateway | Identity, bridge, audit | Conversation/session mapping |
| `tools-core` | 1 | Core/gateway | Policy, audit, command | Tool configuration only |
| `gateway` | 1 | Server | Identity, conversation, command | Sessions and API cursors |
| `web` | 1 | Browser/PWA | Protocol, Gateway API | Local cache only |
| `device-registry` | 2 | Gateway | Identity, protocol | Devices and capabilities |
| `command` | 2 | Gateway/node | Policy, audit, device registry | Commands and attempts |
| `node-agent` | 2 | Computer | Protocol, local policy | Local identity and dedupe journal |
| `notifications` | 3 | Gateway | Identity, automation | Notifications and attempts |
| `device-home-assistant` | 4 | Gateway/bridge | Device registry, command | Mapping and cursor state |
| `device-mqtt` | 4 | Gateway/bridge | Device registry, command | Mapping and cursor state |
| `voice-protocol` | 5 | Shared | Protocol | No |
| `voice-gateway` | 5 | Server | Identity, voice providers, conversation | Session metadata only |
| `asr` | 5 | Voice | Voice protocol | Provider config only |
| `tts` | 5 | Voice | Voice protocol | Provider config only |
| `wake-word` | 5 | Client/node | Voice protocol | Device calibration |
| `memory` | 6 | Gateway/core | Identity, conversation, storage | Memory sources and items |
| `retrieval` | 6 | Gateway/core | Memory | Rebuildable indexes |
| `automation` | 6 | Gateway | Command, notifications, storage | Rules, schedules, occurrences |
| `testkit` | 0 | Test | Protocol and provider interfaces | Fixtures only |

## Shared Infrastructure

### Storage

- SQLite is authoritative for Jarvis product data in V1.
- Harness owns its separate session persistence.
- Object files are content-addressed and referenced from rows.
- Derivative indexes are rebuildable from authoritative rows.

### Configuration

- Environment variables carry bootstrap locations, never long-lived secrets.
- Secrets resolve from macOS Keychain or the selected host secret store.
- Every module validates configuration before publishing readiness.

### Events

- Domain mutations commit state and outbox entry in one transaction.
- An outbox dispatcher publishes versioned events.
- Consumers deduplicate by event ID and persist cursors where required.
- MQTT and external provider acknowledgements are translated into domain events, not exposed as direct authority.

### Errors

- Boundary errors use stable codes, safe messages, retryability, and correlation IDs.
- Internal exceptions are logged locally and never sent verbatim to untrusted clients.
- Unknown or unsupported versions fail closed.

## Repository Build Order

```text
protocol/utilities
  -> domain packages
  -> provider interfaces
  -> adapters and Harness integration
  -> applications
  -> acceptance fixtures and deployment artifacts
```

## Test Ownership

| Test class | Owner | Evidence scope |
|---|---|---|
| Unit/property | Package | Pure rules and state transitions |
| Contract | Adapter | External/Harness protocol compatibility |
| Integration | Application | Real processes and persistent stores |
| Browser | Web/PWA | User-visible client workflows |
| Hardware | Stage acceptance | Named computer, phone, and devices |
| Recovery | Operations | Backup, restore, migration, restart |

## Forbidden Couplings

- Model output directly writing confirmed memory.
- Gateway authorization bypassing node-local policy.
- Client UI importing Harness internal API types.
- Smart-device acknowledgement treated as observed physical success.
- Voice recognition treated as user authentication.
- Automation bypassing the ordinary command and approval lifecycle.
- Jarvis packages outside the adapter importing Harness internals.
