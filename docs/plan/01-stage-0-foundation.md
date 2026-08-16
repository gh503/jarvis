# Stage 0: Foundation and Harness Qualification

Status: planned
Effort: 5-8 focused engineering days

## Objective

Create an independently versioned Jarvis repository skeleton and prove that the pinned DeepSeek Harness revision supports every integration mechanism required by later stages.

## Inputs

- Pinned Harness revision `47f9438` for the current qualification baseline.
- Node.js 24 and pnpm 11.7 toolchain.
- Apple Silicon macOS development host.
- Proposed single-owner V1 boundary.

## Modules

### Repository foundation

Deliver:

- pnpm workspace with strict ESM TypeScript.
- Root commands for build, typecheck, lint, test, acceptance, and clean.
- CI on macOS and Linux where behavior is portable.
- Changesets or an equivalent package version process.
- Conventional directory structure matching the approved module map.

Acceptance:

- Fresh checkout reaches a green `pnpm install`, typecheck, test, and build.
- The lockfile and exact Harness dependency are committed.

### `packages/protocol`

Deliver:

- Versioned event envelope.
- Branded owner, device, command, conversation, and correlation identifiers.
- Runtime validation at HTTP, WebSocket, storage, and device boundaries.
- Error code registry with retryability metadata.

Acceptance:

- Unsupported protocol versions reject before business dispatch.
- Invalid identifiers and payloads fail at parsing boundaries.
- Compatibility fixtures round-trip deterministically.

### `packages/harness-adapter`

Deliver:

- All direct imports from DeepSeek Harness.
- Adapter interfaces for session create/resume, prompt, event subscription, cancel, approval, and persistence flush.
- Upstream revision manifest.
- Error translation from Harness failures to Jarvis error codes.

Acceptance:

- No other Jarvis package imports a Harness package directly.
- Contract tests fail when an expected Harness method or event changes.

### `packages/harness-bundle`

Deliver:

- Installable `dsh.bundle` package.
- Jarvis patch rows with deterministic IDs.
- Configuration schema for local bridge paths and feature flags.
- Exact upstream compatibility check at startup.

Acceptance:

- Bundle installs into a clean Harness profile.
- `dsh --profile jarvis --dump-config` identifies the Jarvis layer.
- Unsupported Harness revisions fail with a clear diagnostic.

### `packages/harness-bridge`

Deliver:

- Health and readiness endpoints.
- Local-only session command endpoint.
- Versioned event stream.
- Lifecycle-safe route registration and disposal.
- Request correlation and bounded payload sizes.

Acceptance:

- Route is present while the plugin is active and absent after disposal.
- GET health returns process state; readiness waits for required services.
- Unsupported methods return 405 and malformed payloads return structured 400 responses.

### `packages/identity` skeleton

Deliver:

- Owner and device domain types.
- One bootstrap owner migration.
- Device credential interface without remote pairing yet.

Acceptance:

- Every Jarvis domain aggregate requires an `owner_id`.
- Cross-owner references reject even though V1 has one owner.

### `packages/policy` skeleton

Deliver:

- Risk classes: read, low, medium, high, prohibited.
- Policy decision structure.
- Default-deny evaluator.
- Normalized command digest used by approvals later.

Acceptance:

- Unknown capabilities deny.
- Prohibited actions cannot be approved through ordinary user flow.
- Same semantic command produces the same digest.

### Observability baseline

Deliver:

- Structured logger with secret redaction.
- Correlation IDs propagated gateway-to-Harness.
- Health, readiness, and build metadata.
- Local diagnostic export with bounded logs.

Acceptance:

- A scenario can be traced across gateway stub and Harness bridge.
- Known secret fields are absent from captured diagnostics.

## Qualification Scenarios

| ID | Scenario | Required evidence |
|---|---|---|
| Q-001 | Bundle install and config dump | Layer and plugin row visible |
| Q-002 | Plugin startup and disposal | Health route appears then disappears |
| Q-003 | Session create and prompt | Session event stream shows admitted message and response lifecycle |
| Q-004 | Active turn cancellation | Cancellation reaches an idle state without killing the process |
| Q-005 | Approval allow and reject | Exact command decision appears in audit stub |
| Q-006 | Restart persistence | Session resumes after process restart |
| Q-007 | Unsupported Harness revision | Startup fails before accepting requests |
| Q-008 | Secret redaction | Diagnostic fixture contains no configured secret |

## Exit Gate

Stage 0 closes only when Q-001 through Q-008 pass on the pinned revision and the repository can be recreated from its runbook on a clean machine.

## Explicit Non-Goals

- User-facing Jarvis UI.
- Real computer control.
- Public network exposure.
- Voice or smart-home integration.
- Semantic memory.
