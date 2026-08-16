# Stage 7: Hardening, Recovery, and v1.0 Release

Status: planned
Effort: 10-15 focused engineering days

## Objective

Convert the qualified personal alpha into a recoverable, supportable release with explicit platform scope, security controls, migrations, operational evidence, and a clean installation path.

## Supported Scope Decision

Before release, name exact supported combinations:

- Jarvis Core operating system and minimum version.
- Node.js version range.
- DeepSeek Harness exact compatible version.
- Desktop node operating systems.
- Phone browsers or native app versions.
- Home Assistant and MQTT protocol versions.
- Selected ASR and TTS providers.

Untested combinations are documented as unsupported, not implied compatible.

## Modules and Workstreams

### Threat model and security review

Deliver:

- Data-flow and trust-boundary diagrams.
- Assets, actors, entry points, abuse cases, and controls.
- Review of gateway, device pairing, command authorization, approval binding, plugin loading, secret references, WebSocket, MQTT, backups, and update path.
- Residual-risk register.

Acceptance:

- Every external input reaches a named validation boundary.
- Every side effect reaches both gateway and target-node policy.
- Critical findings are fixed or explicitly block release.

### Secret and key lifecycle

Deliver:

- Keychain-backed secret references on macOS.
- Device-key rotation and revocation.
- Gateway signing-key rotation with overlap.
- Backup encryption and recovery-key procedure.
- Redaction tests for logs, diagnostics, errors, and crash reports.

Acceptance:

- Rotation does not require deleting user data.
- Revoked credentials fail on active and new connections.
- Secret scanning finds no seeded canary in generated artifacts.

### Backup and restore

Deliver:

- Consistent backup of Jarvis database, Harness sessions, attachments, configuration, and key metadata.
- Encrypted archive manifest with schema and software versions.
- Restore into an empty data root.
- Retention and integrity verification.

Acceptance:

- A clean-machine rehearsal restores conversations, devices, approvals, memory, automations, and audit counts with parity.
- Corrupted backup fails before replacing active data.

### Database migration

Deliver:

- Forward migration command with preflight and backup.
- Transactional schema changes where supported.
- Explicit rollback or restore path.
- Compatibility test across every released schema version retained by policy.

Acceptance:

- Failed migration preserves a recoverable prior state.
- Startup never silently initializes over an unknown newer schema.

### Process supervision

Deliver for macOS:

- `launchd` definitions for gateway, core, and node agent.
- Start, stop, restart, status, and log commands.
- Dependency-aware readiness and bounded restart policy.
- Uninstall that preserves data unless deletion is explicitly requested.

Acceptance:

- Login/reboot starts required services.
- Crash restarts do not create command duplicates.
- Uninstall leaves no running process or exposed port.

### Update and rollback

Deliver:

- Signed or checksum-verified release artifacts.
- Staged update: download, verify, backup, stop, migrate, start, readiness, commit.
- Automatic rollback before migration commit where possible.
- Manual recovery path after data migration.
- Dedicated Harness compatibility update workflow.

Acceptance:

- Broken binary and failed readiness roll back in a rehearsal.
- Harness version mismatch refuses startup before accepting work.

### Observability and service objectives

Deliver:

- Health, readiness, dependency, queue, scheduler, device, and provider metrics.
- Structured local logs with retention.
- Diagnostic bundle generation.
- Personal SLOs for request availability, command settlement, reminder lateness, and backup success.

Proposed initial SLOs:

- Gateway availability while host is awake: 99.5% monthly.
- Low-risk local command terminal result: p95 under 5 seconds excluding the action's declared long-running class.
- Reminder dispatch lateness while core is healthy: p95 under 30 seconds.
- Daily backup success: 99%, with visible failure notification.

Acceptance:

- Each SLO derives from measured events, not log text scraping alone.
- Dependency outage identifies the failing dependency and affected capabilities.

### Test and release matrix

Deliver:

- Unit and property tests for pure domain logic.
- Contract tests for Harness, Gateway, node, Home Assistant, MQTT, and voice providers.
- Process integration tests with restart and cancellation.
- Browser automation for primary Web/PWA workflows.
- Physical device checklist for phone, computer, and home devices.
- Upgrade, backup, restore, and disaster-recovery rehearsals.

Acceptance:

- Release report identifies which evidence is automated, manually observed, hardware-backed, or deferred.
- No broad release claim relies only on unit tests.

### Documentation and project governance

Deliver:

- README, architecture, security, privacy, contributing, support, and release documents.
- Executable clean-install and recovery runbooks.
- Issue templates and decision-record process.
- License and third-party notices.
- Upstream attribution and pinned compatibility statement.

Acceptance:

- A clean user account follows the installation runbook without undocumented state.
- Links and commands are checked in CI where practical.

## Release Acceptance Journeys

| ID | Journey | Required observation |
|---|---|---|
| A-701 | Clean install | Supported host reaches ready state from release artifact |
| A-702 | Reboot recovery | Services return ready without duplicate commands |
| A-703 | Encrypted backup/restore | Domain and session parity on empty data root |
| A-704 | Failed migration | Prior version remains recoverable |
| A-705 | Bad update | Verification/readiness failure rolls back |
| A-706 | Credential rotation | Existing trusted devices transition without data loss |
| A-707 | Compromised device revoke | Active and future access stops |
| A-708 | Dependency outage | Capability degrades visibly and recovers without fabricated success |
| A-709 | Disaster recovery | New host restores documented minimum service |
| A-710 | Release evidence audit | Every v1.0 claim maps to current evidence |

## Exit Gate

Stage 7 and v1.0 close only when A-701 through A-710 pass for the declared supported scope and all critical security findings are resolved.

## Explicit Non-Goals

- Enterprise high availability.
- Public multi-tenant service.
- Safety certification.
- Unsupported platform claims.
- Automatic core upgrades without backup and rollback gates.
