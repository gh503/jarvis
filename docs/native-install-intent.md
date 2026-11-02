# Native install intent codec (unreleased source)

The source [native-install-intent.ts](../scripts/native-install-intent.ts) defines a pure, bounded intent format as a prerequisite for future installer transaction work. It describes a proposed binding and expected fixed-location artifacts. It performs no filesystem I/O, persists nothing, acquires no locks, and is not called by the installer. There is no CLI. This addition is unreleased; native Windows validation remains pending. Existing release recommendations are unchanged.

An intent is caller-supplied metadata, not an ownership receipt, publisher signature, record of operation progress, or permission to execute, replay, delete, or automatically clean up anything. Even a complete set of expected hashes does not prove that any output was created. The format adds no journal writer, crash reconciliation, rollback, activation, or recoverable multi-file transaction.

## Source API

```ts
createNativeInstallIntent({
  integration,
  binding,
  expectedArtifacts?,
  expectedReceipt?,
}): NativeInstallIntent

encodeNativeInstallIntent(intent, integration): Buffer
decodeNativeInstallIntent(bytes, integration): NativeInstallIntent
```

`integration` uses the installer's `InstallOptions`; layout comes from the existing pure `describeNativeIntegration` helper. Supply explicit `platform`, `root`, and `home`, plus `appData` and `localAppData` for Windows layout. Paths pass the existing option-path preflight. Layout is not discovered from the environment or filesystem, and platform selection does not prove that native artifacts work on that platform. Architecture is not an intent field or binary identity proof.

`binding` contains `root` and boolean `autostart`, with `configFile` and `dataDir` either both present or both absent. Binding validation reuses the strict receipt parser's rules. The supplied `integration.root` is intentionally not required to equal `binding.root`: the former is an option used to describe layout, while the latter records the proposed package binding. Neither path is inspected. Any future operation must separately protect and verify the actual receipt-bound root and other source/destination boundaries before acting.

`expectedArtifacts` is an optional path-keyed object whose only allowed keys are the fixed artifact paths. Each value is `null` or `{ sha256, bytes, mode }`. An omitted entry becomes `null`. For an included slot, `null` means the expectation is unknown or pending; it does not assert that the file is absent. This allows Windows COM-generated shortcut bytes to remain unknown before creation. An excluded startup slot must have a null expectation.

`expectedReceipt` is an optional buffer containing actual ownership receipt bytes. It is validated and hashed during construction, but the bytes themselves are not stored in the intent. Creation and decoding return deeply frozen snapshots: the binding, artifact array and entries, expected metadata, receipt metadata, scope, and outer intent cannot be mutated. Caller-owned objects and buffers are not retained as mutable state. Encoding returns a separate buffer; buffers are transport bytes, not immutable intent objects.

## Exact format and bounds

The encoding is one compact UTF-8 JSON object followed by exactly one LF, with a maximum total size of **16 KiB (16,384 bytes), including the LF**. It is not padded to that size. Decoding uses fatal UTF-8 validation and requires an exact match to canonical re-encoding. Alternate whitespace, missing or additional line endings, duplicate or reordered keys, unknown fields, and noncanonical encodings are rejected.

The top-level keys appear in this order:

| Key | Value |
| --- | --- |
| `schemaVersion` | `1` |
| `kind` | `"native-install-intent"` |
| `platform` | `"darwin"` or `"win32"`, matching the supplied layout |
| `receiptPath` | The fixed ownership receipt path for that layout |
| `binding` | `root`, `autostart`, then optional `configFile`, `dataDir` |
| `artifacts` | All fixed artifact slots in the order below |
| `receipt` | `null` or `{ "sha256": "…", "bytes": N }` |
| `scope` | `{ "ownership": false, "execution": false, "automaticCleanup": false }` |

Each artifact entry has exactly `path`, `included`, and `expected`, in that order. A known expectation has exactly `sha256`, `bytes`, and `mode`, in that order. SHA-256 strings use 64 lowercase hexadecimal characters. Artifact byte lengths are safe integers from zero through 1 MiB; receipt byte lengths are safe integers from one through 64 KiB. Modes are safe integers from `0` through `0o7777` and are descriptive metadata only: they do not authorize permission changes or establish Windows ACL privacy.

On macOS the receipt is under the explicit home at `Library/Application Support/Jarvis/native-install.json`. Artifact slots are:

1. `Applications/Jarvis.app/Contents/Info.plist` under home, always included.
2. `Applications/Jarvis.app/Contents/MacOS/Jarvis` under home, always included.
3. `Library/LaunchAgents/org.jarvis.portable.plist` under home, included exactly when `binding.autostart` is true.

On Windows the receipt is `Jarvis/native-install.json` beneath explicit `localAppData`. Artifact slots are:

1. `Microsoft/Windows/Start Menu/Programs/Jarvis.lnk` beneath explicit `appData`, always included.
2. `Microsoft/Windows/Start Menu/Programs/Startup/Jarvis.lnk` beneath explicit `appData`, included exactly when `binding.autostart` is true.

Paths are serialized as the absolute strings returned by the existing layout helper. Slot order, count, paths, and inclusion must match that layout exactly. The startup slot remains in the array even when excluded. No arbitrary destination or additional artifact can be introduced through this format. All three scope flags must remain false.

## Actual receipt bytes versus decoded metadata

When construction receives `expectedReceipt`, it reuses `parseNativeIntegrationReceipt` to validate the actual receipt's bounded UTF-8 producer format, platform, fixed artifact set, and platform-specific requirements, including the Windows notification identity. Its root, autostart, and optional config/data binding must match the intent binding. Every included artifact must already have known expectation metadata, and its SHA-256 must match the corresponding receipt entry. The constructor then records the SHA-256 and length of the exact supplied receipt bytes. Receipt entries do not contain artifact lengths or modes, so this check does not independently establish those values.

Without actual receipt bytes, `receipt` is null. A decoded intent may contain non-null receipt digest/length metadata only when all included artifact expectations are known. That structural condition cannot prove that actual receipt bytes exist, that they have the recorded digest/length, or that their parsed binding and artifact hashes match the intent: the receipt bytes are absent from the format. Encoding and decoding do not reconstruct this missing evidence. A later consumer must separately read actual receipt bytes with appropriate filesystem safeguards, verify their digest and length, strictly parse them, and compare their binding and artifact hashes before relying on that relationship. Actual artifacts likewise require separate verification.

The caller must establish trust in inputs through its own channel. Canonical encoding and hashes identify bytes; they do not authenticate a publisher, prove installation ownership, or grant cleanup authority. Validating an intent is never sufficient authority to replay installation steps or delete matching paths.

## Relationship to existing installer safeguards

The [source shared install/uninstall lock](native-install.md#unreleased-shared-installuninstall-lock) is a separate unreleased operational safeguard. It coordinates cooperating installer calls and can create private control/SQLite storage; this codec does none of that and does not extend lock coverage. Inventory and integration snapshot behavior remains as documented separately. No successful native Windows result or released package inclusion is claimed for the new intent format.

The existing in-process cleanup guards still govern installer failures. A future persistent transaction design would need its own publication, locking, actual-byte verification, crash handling, ownership, and recovery contract. This format alone supplies none of those operations and does not change [the update activation boundary](native-update.md#activation-boundary).
