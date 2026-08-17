# v1 Release Qualification

This document defines the executable release gates and evidence boundary for
Issue #11. Passing the automated gates is necessary but does not by itself make
the current `v0.1.0` build a qualified v1.0 release.

## Supported release target

- Jarvis Core: macOS 13 or later.
- Runtime: Node.js 24.
- Harness: exact `@deepseek-ai/dsh`, host, tools, and Cordis versions pinned in
  `package-lock.json`.
- Network: Harness on loopback only; Gateway on loopback by default. Explicit
  private-network Gateway deployment requires a supported private address and
  TLS as documented in `docs/operations/private-network-recovery.md`.
- Ownership: one trusted local owner. Public internet and mutually untrusted
  multi-user deployment are unsupported.

Physical smart-home devices, a visible standalone phone launcher entry,
microphone/speaker behavior, non-macOS Core hosts, and automatic cross-version
data migration remain outside the qualified target until their separate
acceptance evidence exists.

## Automated gates

Run from a clean checkout:

```bash
npm ci
npm run check:dependencies
npm run verify
npm run verify:runtime
npm run verify:recovery
npm run verify:release
```

CI also runs Gitleaks against full Git history. The gates establish:

| Gate | Evidence |
| --- | --- |
| Dependency | Production dependency audit has no high or critical advisory. |
| Secret | Full-history Gitleaks scan passes; release and backup tests also reject seeded secret material. |
| Network | Live Harness and Gateway ports bind only to `127.0.0.1`; unsafe Gateway bindings fail closed. |
| Compatibility | Type, contract, and live no-key runtime checks pass with the pinned Harness revision. |
| Recovery | Backup and empty-root restore preserve payload parity and credential/session/event semantics. |
| Rollback | An incompatible archive fails before replacement and leaves prior destination state intact. |
| Installation | A checksum-verified release ZIP installs in an isolated home, reaches health, persists data, and uninstalls without a listener or loaded job. |

## Credential lifecycle

The recovery gate persists real digest-only pairing and session stores. It
proves that a rotated device's old credential remains invalid after restore,
the replacement credential remains valid, a revoked device remains revoked,
an active access session remains usable, and a revoked device session remains
invalid. The normal test suite separately covers refresh-token reuse detection,
active WebSocket closure, owner revocation, and device self-revocation.

Keychain items, Owner Tokens, model credentials, TLS private keys, and raw
device/session credentials are not backed up. Replacement-host recovery must
provision those secrets separately and re-pair devices when their local secret
material is unavailable.

## Migration boundary

Persisted stores reject unknown or malformed schema versions before serving
work. Pairing state supports the tested version 1 to version 2 migration and
persists version 2 on the next write. Backup restore currently requires the
archive application version to exactly match the running application.

There is no general cross-release migration command yet. A future release that
changes any persisted schema must add forward migration, preflight backup, and
failed-migration rollback evidence before Issue #11 can close. Until then,
incompatible archives are rejected and recovery uses the matching Jarvis
release.

## Manual release gates

Before a v1.0 tag, record sanitized pass/fail evidence for:

1. Owner-provided model credential and committed conversation on the release artifact.
2. Restart and login recovery on the declared macOS versions.
3. Backup transfer to a separate encrypted volume and restore on a clean macOS account or host.
4. Device credential rotation and compromised-device revocation through the owner-facing workflow.
5. Checksum verification of the published archive followed by clean installation.

Do not attach credentials, transcripts, pairing codes, tokens, private device
identifiers, archive contents, or raw logs to a public Issue.
