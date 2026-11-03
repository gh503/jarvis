# Native install intent codec, storage, and diagnosis

The pure [artifact acknowledgement codec](../scripts/native-install-transaction-ack.ts) binds one included artifact to the canonical prepared transaction SHA-256, transaction ID, fixed index/path, expected digest/length and eleven observed file identity fields. `createNativeInstallTransactionAck({ transaction, integration, artifactIndex, observation: { bytes, identity } })` checks supplied bytes and requires a regular single-link identity of matching size; receipt and excluded startup slots are rejected. Identity accepts BigIntStats or canonical decimal strings, bounded to 40 digits per field (signed timestamps allowed). Requested and observed modes may differ due to umask; neither represents Windows ACL validation. `encodeNativeInstallTransactionAck` and `decodeNativeInstallTransactionAck` require the same transaction/integration and a canonical record of at most 16 KiB. Records are deeply frozen and payload bytes discarded. Hashes bind data but do not authenticate observations. This adds no persistent acknowledgement storage, completion marker, installer integration or recovery action; all ownership/execution/cleanup/replay/atomicity/observation-authenticity/Windows-ACL authority flags remain false.

Prepared transaction source `3e7e31a` passed the macOS job in [41556555758](https://github.com/gh503/jarvis/actions/runs/41556555758). Downloaded logs confirm codec/store 44 passed/one Windows-only skip, installer 100 passed/two skips, lock 16 passed/two skips, and legacy intent store 33 passed/one skip, all zero failures. This includes retained sync failures and exclusive-storage refusal checks on macOS. The Windows job was still running at this checkpoint; this result is neither Windows ACL acceptance nor installer transaction recovery, since the new store remains unwired.

> **Archive correction — repaired archives published in v2.0.75.** The historical packaging allowlist omitted snapshot/recovery/intent/diagnosis tooling and required installer/updater dependencies; known affected archives include v2.0.65 and v2.0.68. v2.0.75 includes the repaired tooling and dependencies, with archive inventory and management-module import gates passing on all three release platforms. Later [release run 41519574051](https://github.com/gh503/jarvis/actions/runs/41519574051), at exact source `b50f196e8513d95bcbdb8d9388c6915f8b75c037`, passed all three platform builds and publication, including extracted-archive data/config/integration snapshot CLI operations and positive tagged-baseline recovery-set create/verify on Linux, Windows, and macOS. The recommended unsigned preview remains v2.0.52 while historical native failures remain unresolved; this is not an assurance of snapshot or updater completeness in v2.0.52. See the [release pipeline evidence, historical fault, and verification limits](native-release-pipeline.md).

The separate [prepared transaction codec](../scripts/native-install-transaction.ts) is a new pure prerequisite, not an extension of stored version-1 intents. `createNativeInstallTransaction({ integration, transactionId, artifacts, receipt })` requires a supplied lowercase UUIDv4, complete prepared artifact bytes in fixed layout order, and exact canonical receipt bytes. Initial scope is fresh installation without autostart; the receipt root must match the supplied integration root. Creation verifies artifact digests against receipt entries and records every fixed predecessor slot as required absent, without observing the filesystem. The immutable result retains artifact hashes/lengths/requested modes and the exact receipt as canonical base64, not artifact payloads. Requested modes are descriptive, not effective permissions or Windows ACL evidence. Encoding/decoding is bounded to 128 KiB, with a 64 KiB receipt and 1 MiB per input artifact; canonical comparison rejects ambiguous JSON/base64 forms. Decoding checks receipt consistency but cannot reverify discarded artifact bytes, authenticate a record, establish predecessor absence or prove UUID uniqueness. Ownership, execution, automatic cleanup, replay and atomicity remain false. The separate [prepared transaction store](../scripts/native-install-transaction-store.ts) now exposes `readNativeInstallTransaction({ integration })`, `writeNativeInstallTransaction({ integration, transaction })` and `writeNativeInstallTransactionUnderLock({ integration, transaction, lock })`. It uses the fixed receipt-derived `native-install-control/prepared-transaction.json`, distinct from legacy intent. Reads create nothing and acquire no lock; writes require private boundaries, exclusive creation, file sync and identity/byte-checked readback under the shared installation lock. Existing, malformed or unsafe records refuse overwrite. Failed writes/syncs/close retain output, including apparently valid bytes; retained bytes do not prove an acknowledged publication. Inputs are snapshotted before asynchronous work and scoped writes drain before unlock. No directory sync or power-loss guarantee is provided. There is still no persisted publication acknowledgement, completion record, installer wiring or recovery action; the installer neither reads nor writes this new store yet, and existing retained-intent refusal remains unchanged. The new codec is included in the source packaging allowlist and native installer acceptance test list; this does not establish published archive availability or native execution until those jobs pass.

**Historical heading retained for existing links:** the v2.0.65 source tag at `3cd70f2` contains this feature. Nine assets and successful all-platform publication in [release run 41507571921](https://github.com/gh503/jarvis/actions/runs/41507571921) establish publication only; the archive allowlist excluded the required tooling. That historical release did not verify portable feature availability; v2.0.75 now includes the repaired tooling, with the verification limits above.

The source [native-install-intent.ts](../scripts/native-install-intent.ts) defines a pure, bounded intent format as a prerequisite for future installer transaction work. It describes a proposed binding and expected fixed-location artifacts. The codec itself performs no filesystem I/O, persists nothing, and acquires no locks. The separate [native-install-intent-store.ts](../scripts/native-install-intent-store.ts) provides write-once storage and read-only inspection of that format. The separate [native-install-diagnose.ts](../scripts/native-install-diagnose.ts) observes stored intent and actual fixed integration locations under the shared install lock, then uses the unchanged pure classifier. The current source installer reads the intent store inside its existing shared lock before configuration/package observations or integration mutations. Any valid retained intent refuses both install and uninstall, even when its binding matches; malformed, partial or unsafe records also fail closed. It does not acquire a nested lock, invoke diagnosis, publish/retire intent, repair the record or grant cleanup authority. Missing intent preserves the existing installer checks and install–uninstall–reinstall behavior. This source guard is newer than the historical releases cited here; installer intent persistence and recovery are still not implemented. The diagnosis CLI is described below; it does not write intent. These additions are present in the source tag for v2.0.65. The recommended unsigned preview remains v2.0.52 because the later native CI failure described below remains unresolved; successful publication is not stable-production validation.

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

## Storage API and fixed location

The separate storage module exports these asynchronous APIs:

```ts
writeNativeInstallIntent({ integration, intent }): Promise<NativeInstallIntent>
readNativeInstallIntent({ integration }): Promise<NativeInstallIntent | undefined>
writeNativeInstallIntentUnderLock({ integration, intent, lock }): Promise<NativeInstallIntent>
```

`integration` is `InstallOptions`, and the writer's `intent` is `NativeInstallIntent`. A successful write returns the decoded stored intent, not a completion receipt. A successful read returns the deeply frozen decoded intent; a missing file returns `undefined` after boundary checks. Missing control directories or parents are not created by reading. Unsafe existing boundaries or malformed files cause rejection rather than being treated as absence.

The only storage filename is `native-install-control/install-intent.json` beneath the fixed ownership receipt parent. On macOS this is `Library/Application Support/Jarvis/native-install-control/install-intent.json` under explicit home; on Windows it is `Jarvis/native-install-control/install-intent.json` beneath explicit `localAppData`. There is no caller-selected destination. Layout uses the supplied options; the original package, config file, and data directory need not exist. Decode-time binding validation retains the codec's semantics: `integration.root` need not equal `binding.root`.

The writer encodes and validates the complete intent before any directory or lock preparation. Read-only boundary and existence preflight rejects a preexisting intent before lock preparation. It then acquires the same fixed control-directory SQLite launcher lock used by cooperating install/uninstall calls. Preparation may create private control storage, required parents, and operational SQLite files; existing control-directory permissions and ACLs are verified without resetting them. Under that lock it exclusively creates a new file with mode `0600`, writes the canonical bytes, fsyncs the file, and checks the stored bytes and identity before returning. An existing filename is always refused, even if it contains an identical valid intent. There is no overwrite, update, delete, adoption, or cleanup API.

The source `writeNativeInstallIntentUnderLock` variant composes with the opaque capability passed to a `withNativeInstallLock` callback. It uses the same exclusive publication and verification rules without acquiring a second SQLite lock. Capabilities are process-local, bound to the resolved control directory, and expire when their scope closes; fabricated, wrong-directory and expired capabilities are rejected. The scope tracks registered operations, closes registration when the callback settles, and drains already registered operations before releasing the lock, including writes the caller failed to await. A failed tracked operation makes the scope fail even if the callback returned successfully. After draining, the scope removes its capability mapping and registered-operation references before releasing the SQLite lock, so retaining an expired capability does not retain those settled operations through the lock registry. Errors returned to the caller remain available to that caller. Callers should still await every write. This is coordination for cooperating code, not protection against arbitrary same-process code or noncooperative filesystem writers, and it does not add automatic installer publication, intent retirement, atomic multi-file updates or power-loss durability.

Reading never acquires the lock, accesses SQLite, repairs permissions, or creates files or directories. It reuses the shared boundary helpers in their read-only mode. Present files must be regular, have exactly one hard link, and satisfy the strict 16 KiB bound and canonical codec validation. On POSIX the intent file must belong to the current UID with exact mode `0600`, and the control directory must belong to that UID with exact mode `0700`, including rejection of special permission bits. Ancestor checks reject unsafe or redirected paths. On Windows the unchanged private operational checker rejects reparse points, restricts allowed access to the current user, SYSTEM, and Administrators, requires current-user FullControl, and permits Administrators ownership only for an elevated current user. It checks these requirements without changing ACLs; even a read uses this operational FullControl requirement.

The writer holds the lock for its storage operation, but readers are unlocked. Keep writers quiescent for reads: bounded reads and repeated file/ancestor identity checks can reject observed changes, including a concurrent partial write, but do not provide an atomic snapshot or protection against all same-account pathname races. Failures retain partial output, including a file whose bytes happen to parse successfully after a late write, fsync, verification, or lock-release failure. Neither valid bytes nor successful reading prove that a write operation completed successfully or that any installation artifact was created. There is no completed marker, progress journal, automatic rollback, or crash reconciliation. File fsync is not a power-loss or atomic-publication guarantee; the API does not fsync the directory.

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

## Pure observation classification

The separate [native-install-reconcile.ts](../scripts/native-install-reconcile.ts) exports the synchronous pure API `reconcileNativeInstallIntent({ integration, intent, observations }): NativeInstallReconcileReport`. It validates the existing intent codec against the explicit fixed layout before comparing observations. It does not capture filesystem observations, read the intent store, acquire locks, persist anything, invoke installer operations, or expose a CLI. The current installer reads the store only to reject retained intents before mutation. It does not publish or retire intents, and it does not invoke this classifier.

`observations` contains `artifacts`, an array with every fixed slot in exactly the intent's order (including excluded startup), and `receipt`, at the exact fixed receipt path. Each observation is `{ path, state: 'absent' | 'unsafe' }` or `{ path, state: 'file', bytes: Buffer, mode?: number }`. File buffers are bounded to 1 MiB per artifact and 64 KiB for the receipt. Optional modes are integers from `0` through `0o7777`; a known artifact expectation requires an explicitly matching mode, so omitting it produces a conflict. Receipt mode does not establish permission safety. Malformed observation shapes, paths, ordering, bounds, or intent metadata throw before comparison; an observed `unsafe` state is a reportable conflict.

The report contains an overall `status`, ordered artifact entries, a receipt entry, and scope. Entries expose only the fixed path, classification, and optional bounded reason code, with no raw bytes or secrets. The report and its entries are frozen. Overall classifications are:

| Status | Meaning for supplied observations only |
| --- | --- |
| `unpublished` | All artifact slots and the receipt are absent. This does not establish operation history. |
| `consistent` | All included artifacts match known byte-length, SHA-256, and mode expectations, excluded slots are absent, and the actual receipt matches its known expectation and parsed binding/artifact hashes. |
| `incomplete` | Some required artifact or receipt is absent; present entries match known expectations. |
| `indeterminate` | A present included artifact or valid receipt has an unknown expectation, with no conflict. Missing entries may coexist. |
| `conflict` | Any unsafe state, excluded-but-present artifact, known byte/mode mismatch, malformed receipt, or receipt binding/artifact-hash mismatch. |

Conflict takes priority over unknown expectations, and unknown expectations take priority over incompleteness. All-absent observations yield `unpublished` even when intent expectations are unknown. A missing receipt with present payloads yields `incomplete`, `indeterminate`, or `conflict`, never ownership. Present receipt bytes are strictly parsed even when the expected receipt digest is unknown; malformed receipt bytes conflict. Receipt artifact hashes are compared with both known intent expectations and supplied present artifact bytes. Contradictory observed bytes conflict even when the intent's artifact expectation is unknown; matching a receipt does not fill that unknown expectation, so otherwise matching observations remain `indeterminate`. The intent binding is authoritative for receipt comparison. The layout option `integration.root` remains syntactic and need not equal that binding root; neither root is inspected.

`consistent` never means committed, owned, or safe. Report scope is exactly `{ ownership: false, execution: false, automaticCleanup: false, atomicity: false }`; the intent format's existing three scope flags are unchanged. Callers must capture observations with all writers quiescent and separately establish actual filesystem identity, permissions, and boundary safety. The classifier cannot prove that supplied observations came from real files, form an atomic snapshot, or authorize replay, execution, deletion, or cleanup. The classifier itself has no filesystem observation reader or crash recovery; the separate observer below supplies actual observations without changing these classification semantics. These additions are present in the source tag for v2.0.65. The prior reconcile/store directory fix passed all three native jobs and the overall [native CI run 41502735174](https://github.com/gh503/jarvis/actions/runs/41502735174). That run is source acceptance evidence; the historical v2.0.65 release evidence establishes publication, not archive inclusion; v2.0.75 inclusion evidence is recorded above.

## Filesystem diagnosis API

The separate [native-install-diagnose.ts](../scripts/native-install-diagnose.ts) exports:

```ts
diagnoseNativeInstallIntent({ integration }): Promise<NativeInstallDiagnosis>
```

`integration` uses the same explicit `InstallOptions` and fixed layout. The result is either the existing deeply frozen `NativeInstallReconcileReport` or a frozen `{ status: 'no-intent', scope }`, where scope is exactly `{ ownership: false, execution: false, automaticCleanup: false, atomicity: false }`. Reports expose no captured bytes. Original package/config/data paths need not exist, and the layout root need not equal the intent binding root.

Diagnosis acquires the fixed shared install lock before reading the intent store. Acquiring and releasing it can create private control storage, required parents, and operational SQLite files, even when no intent exists. Diagnosis is therefore not a wholly read-only filesystem operation. Original receipt and integration files are only read: diagnosis does not repair them, run shortcut COM, execute captured content, or launch a runtime.

The stored intent is bounded to 16 KiB, decoded canonically, and revalidated across observation using canonical bytes and bigint file identity. A missing intent returns `no-intent` after revalidation, without scanning any receipt or artifact locations. It makes no claim that integrations are absent, clean, unpublished, or safe; orphaned payloads may exist.

With an intent, diagnosis captures **every fixed location twice**, including the receipt and excluded startup slot, through the existing bounded integration reader. Missing or unsafe receipts do not short-circuit artifact capture. The receipt limit is 64 KiB and each artifact limit is 1 MiB, with at most three fixed artifact slots (three on macOS, two on Windows). Existing regular-file, single-link, owner/permission, ancestor, and bounded-read checks apply. Unsafe filesystem slots and read failures become `unsafe` observations and therefore conflicts, never absence. Changes observed between passes produce a conflict or rejection; stored-intent changes reject. Matching passes cannot prove that no intervening change occurred.

The unchanged classifier compares the stable observations. A missing receipt with present known matching payloads yields `incomplete`; unknown expectations can yield `indeterminate`, and unsafe or contradictory observations yield `conflict`. All fixed slots absent with a present intent yield `unpublished`, which still says nothing about operation history. A matching receipt and artifacts can yield `consistent`, with no commit, ownership, execution, deletion, or cleanup authority.

On Windows the original integration reader retains its legacy mode-bit checks: these **do not validate source integration ACL privacy**. The private Windows ACL checks cover the operational control boundary, not all original receipts, shortcuts, or their parents. Diagnosis does not strengthen the legacy source ACL contract.

In the v2.0.65 source tag the lock coordinates cooperating installer, intent-writer, and diagnosis calls. The capture-lock change present in the source tag for v2.0.68 also coordinates integration snapshot capture; v2.0.65 excludes it. Legacy scripts, manual edits, sync tools, and other external writers must remain stopped. Two passes and file identity checks are not an atomic OS snapshot or protection against all same-account pathname races. This standalone source API is unused by the installer and updater; the diagnosis CLI below calls it explicitly. Neither adds a persistent journal, crash recovery, automatic action, or activation. The recommended unsigned preview remains v2.0.52 despite the presence of these APIs and the CLI in the v2.0.65 source tag. The distinct diagnosis-source run [41504460541](https://github.com/gh503/jarvis/actions/runs/41504460541), for `dabafea`, completed successfully on all three native platforms. This verifies that source API's acceptance suite, not package publication or the later CLI. The CLI run [41505561419](https://github.com/gh503/jarvis/actions/runs/41505561419), for `a630e80`, completed successfully on all three platforms after rerunning its cancelled macOS job. This is source acceptance evidence; the separate v2.0.65 publication evidence above does not verify inclusion of the command; the allowlist excluded it. The bounded snapshot-diagnostics run [41507333462](https://github.com/gh503/jarvis/actions/runs/41507333462) has the separate failure described below. Separately, the earlier source `2e4afd4` passed native acceptance but its release run [41503093448](https://github.com/gh503/jarvis/actions/runs/41503093448) failed Windows snapshot CLI capture and a stop-operation private-directory check. Its failed-job rerun again failed Windows snapshot CLI capture, while the stop-operation failure did not recur. The original causes remain unproven and no permission check has been relaxed. Snapshot-diagnostics run `41507333462` passed Windows and Linux but failed macOS privacy acceptance during stop on an unsafe lifecycle journal file; source diagnostics now distinguish fixed file-type, link-count, and owner rejection reasons without accepting any previously rejected state. The newer source acceptance evidence recorded below does not explain these historical failures or establish publication of that source.

## Source diagnosis CLI

The [diagnose-native-install.ts](../scripts/diagnose-native-install.ts) exposes only `diagnose`. It is present in the source tag for v2.0.65. The examples below use a trusted source checkout with trusted Node 24. It requires explicit `--platform darwin|win32`, `--arch x64|arm64`, `--home ABS`, and `--root ABS`. Windows layout additionally requires `--app-data ABS` and `--local-app-data ABS`; macOS layout forbids both. Unknown or duplicate flags, missing values, extra positionals, unsupported actions/platforms/architectures, control characters, and nonabsolute paths are usage errors. The strict argument parser completes before the operational diagnosis module is imported; existing option-path and filesystem checks still apply during diagnosis.

There are no ambient home, package-root, AppData, platform, or architecture defaults. The CLI loads neither `.env` nor an external config file and ignores inherited Jarvis configuration selectors/settings for its layout. This does not sandbox Node or clear its inherited process environment. `--platform` selects the integration layout, not proof that the running host/runtime or artifacts are compatible with it; `--arch` is syntactic context, not binary architecture verification. Paths must be absolute in the **running host's** syntax and satisfy existing canonical path checks. The layout root need not match the stored binding root, and original package/config/data paths need not exist.

Replace every placeholder path below with the intended explicit absolute path on the same host; do not paste a Windows path into a POSIX-host invocation or use `~` or environment-derived defaults. The source-checkout path selects trusted code, while `--root` supplies layout context.

POSIX shell (macOS layout):

```sh
'/absolute/path/to/trusted-node24/bin/node' --experimental-transform-types \
  '/absolute/path/to/trusted-checkout/scripts/diagnose-native-install.ts' diagnose \
  --platform darwin --arch arm64 \
  --home '/absolute/path/to/intended-home' \
  --root '/absolute/path/to/package-root'
```

Windows PowerShell (Windows layout):

```powershell
& 'C:\absolute\trusted-node24\node.exe' --experimental-transform-types `
  'C:\absolute\trusted-checkout\scripts\diagnose-native-install.ts' diagnose `
  --platform win32 --arch x64 `
  --home 'C:\absolute\intended-home' `
  --root 'C:\absolute\package-root' `
  --app-data 'C:\absolute\intended-home\AppData\Roaming' `
  --local-app-data 'C:\absolute\intended-home\AppData\Local'
```

Standard output is one JSON serialization of the existing diagnosis report: either an object containing `status: 'no-intent'` and `scope`, or the classifier's status, ordered fixed-path artifact entries, receipt entry, and scope. Entries contain classification and optional bounded reason codes. No raw captured bytes or package/config/data binding fields are printed; fixed integration paths can still identify the local account, so handle reports privately. All four authority flags remain false: `ownership`, `execution`, `automaticCleanup`, and `atomicity`.

| Exit code | Meaning |
| --- | --- |
| `0` | Diagnosis completed and emitted a report, for **every** status: `no-intent`, `conflict`, `incomplete`, `indeterminate`, `unpublished`, or `consistent`. |
| `2` | Usage error; stderr contains the fixed bounded usage message. |
| `1` | Operational failure; stderr contains a fixed bounded nonsecret message, without raw exception text, captured contents, bindings, or stack traces. |

This is **not a health command**: exit `0`, including a `consistent` report, does not mean safely installed, committed, owned, or authorized for any action. Inspect the JSON status and reasons within their limited observation semantics. `no-intent` does not scan integrations or certify absence. The shared lock may create control directories, parents, and operational SQLite files even for `no-intent`; original intent, receipt, and integration artifacts are only read. Stop noncooperating writers throughout diagnosis. There is no CLI action to write intent, install/uninstall, recover, replay, repair, clean up, or activate. The current installer uses storage reads solely for retained-intent refusal. It does not invoke the storage writers or diagnosis API; the updater does not use these APIs.

## Relationship to existing installer safeguards

The [source shared install/uninstall lock](native-install.md#unreleased-shared-installuninstall-lock) coordinates cooperating installer calls, the separate intent writer, and diagnosis. The codec remains pure, and intent reading, inventory inspection, and integration snapshot verification remain unlocked and require quiescent writers. Integration snapshot capture in the v2.0.68 source tag and current source takes the shared lock; earlier capture source tags without that change require all source writers stopped. The prior reconcile/store directory fix has the native CI success recorded above; these intent APIs and shared installer locking are present in the source tag for v2.0.65. The later capture lock at exact source `d93f8fa73bf45c059498867f35f0bed547c41e4b` passed native acceptance on Linux, Windows, and macOS in [native CI run 41510352955](https://github.com/gh503/jarvis/actions/runs/41510352955), whose overall workflow completed successfully. Separately, [v2.0.68 release run 41510639551](https://github.com/gh503/jarvis/actions/runs/41510639551) targeting that exact source completed successfully. [v2.0.68](https://github.com/gh503/jarvis/releases/tag/v2.0.68) publication was verified with exactly nine assets: an unsigned archive, SHA256 sidecar, and provenance JSON for each of Linux x64, Windows x64, and macOS arm64. The capture lock and fixed lifecycle rejection-reason enum are present in the source tag for v2.0.68, as source changes only; the archive allowlist excluded the capture tooling. The v2.0.65 source tag contains bounded snapshot-diagnostics tests but excludes both changes. This success does not establish the historical failures' root causes or change the recommended v2.0.52 preview.

The existing in-process cleanup guards still govern installer failures; they do not clean up intent-store output. Persisting a proposed intent does not connect it to installer execution. A future persistent transaction design still needs an installer publication, actual-byte verification, crash handling, ownership, and recovery contract. These APIs do not change [the update activation boundary](native-update.md#activation-boundary).
