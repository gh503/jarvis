# Native install intent codec, storage, and diagnosis (unreleased source)

The source [native-install-intent.ts](../scripts/native-install-intent.ts) defines a pure, bounded intent format as a prerequisite for future installer transaction work. It describes a proposed binding and expected fixed-location artifacts. The codec itself performs no filesystem I/O, persists nothing, and acquires no locks. The separate [native-install-intent-store.ts](../scripts/native-install-intent-store.ts) provides write-once storage and read-only inspection of that format. The separate [native-install-diagnose.ts](../scripts/native-install-diagnose.ts) observes stored intent and actual fixed integration locations under the shared install lock, then uses the unchanged pure classifier. The installer calls neither storage nor diagnosis automatically; installer intent persistence is not implemented. There is no CLI. These additions are unreleased; native Windows validation, including the pending Windows lock fix result, remains pending. The recommended preview remains v2.0.52; no new verified release is claimed.

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
```

`integration` is `InstallOptions`, and the writer's `intent` is `NativeInstallIntent`. A successful write returns the decoded stored intent, not a completion receipt. A successful read returns the deeply frozen decoded intent; a missing file returns `undefined` after boundary checks. Missing control directories or parents are not created by reading. Unsafe existing boundaries or malformed files cause rejection rather than being treated as absence.

The only storage filename is `native-install-control/install-intent.json` beneath the fixed ownership receipt parent. On macOS this is `Library/Application Support/Jarvis/native-install-control/install-intent.json` under explicit home; on Windows it is `Jarvis/native-install-control/install-intent.json` beneath explicit `localAppData`. There is no caller-selected destination. Layout uses the supplied options; the original package, config file, and data directory need not exist. Decode-time binding validation retains the codec's semantics: `integration.root` need not equal `binding.root`.

The writer encodes and validates the complete intent before any directory or lock preparation. Read-only boundary and existence preflight rejects a preexisting intent before lock preparation. It then acquires the same fixed control-directory SQLite launcher lock used by cooperating install/uninstall calls. Preparation may create private control storage, required parents, and operational SQLite files; existing control-directory permissions and ACLs are verified without resetting them. Under that lock it exclusively creates a new file with mode `0600`, writes the canonical bytes, fsyncs the file, and checks the stored bytes and identity before returning. An existing filename is always refused, even if it contains an identical valid intent. There is no overwrite, update, delete, adoption, or cleanup API.

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

The separate unreleased [native-install-reconcile.ts](../scripts/native-install-reconcile.ts) exports the synchronous pure API `reconcileNativeInstallIntent({ integration, intent, observations }): NativeInstallReconcileReport`. It validates the existing intent codec against the explicit fixed layout before comparing observations. It does not capture filesystem observations, read the intent store, acquire locks, persist anything, invoke installer operations, or expose a CLI. The store remains standalone and unused by the installer; the classifier is standalone too.

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

`consistent` never means committed, owned, or safe. Report scope is exactly `{ ownership: false, execution: false, automaticCleanup: false, atomicity: false }`; the intent format's existing three scope flags are unchanged. Callers must capture observations with all writers quiescent and separately establish actual filesystem identity, permissions, and boundary safety. The classifier cannot prove that supplied observations came from real files, form an atomic snapshot, or authorize replay, execution, deletion, or cleanup. The classifier itself has no filesystem observation reader or crash recovery; the separate observer below supplies actual observations without changing these classification semantics. These additions remain unreleased; native Windows validation and the current Windows lock-fix result remain unverified, with no new verified release claim.

## Filesystem diagnosis API

The separate unreleased [native-install-diagnose.ts](../scripts/native-install-diagnose.ts) exports:

```ts
diagnoseNativeInstallIntent({ integration }): Promise<NativeInstallDiagnosis>
```

`integration` uses the same explicit `InstallOptions` and fixed layout. The result is either the existing deeply frozen `NativeInstallReconcileReport` or a frozen `{ status: 'no-intent', scope }`, where scope is exactly `{ ownership: false, execution: false, automaticCleanup: false, atomicity: false }`. Reports expose no captured bytes. Original package/config/data paths need not exist, and the layout root need not equal the intent binding root.

Diagnosis acquires the fixed shared install lock before reading the intent store. Acquiring and releasing it can create private control storage, required parents, and operational SQLite files, even when no intent exists. Diagnosis is therefore not a wholly read-only filesystem operation. Original receipt and integration files are only read: diagnosis does not repair them, run shortcut COM, execute captured content, or launch a runtime.

The stored intent is bounded to 16 KiB, decoded canonically, and revalidated across observation using canonical bytes and bigint file identity. A missing intent returns `no-intent` after revalidation, without scanning any receipt or artifact locations. It makes no claim that integrations are absent, clean, unpublished, or safe; orphaned payloads may exist.

With an intent, diagnosis captures **every fixed location twice**, including the receipt and excluded startup slot, through the existing bounded integration reader. Missing or unsafe receipts do not short-circuit artifact capture. The receipt limit is 64 KiB and each artifact limit is 1 MiB, with at most three fixed artifact slots (three on macOS, two on Windows). Existing regular-file, single-link, owner/permission, ancestor, and bounded-read checks apply. Unsafe filesystem slots and read failures become `unsafe` observations and therefore conflicts, never absence. Changes observed between passes produce a conflict or rejection; stored-intent changes reject. Matching passes cannot prove that no intervening change occurred.

The unchanged classifier compares the stable observations. A missing receipt with present known matching payloads yields `incomplete`; unknown expectations can yield `indeterminate`, and unsafe or contradictory observations yield `conflict`. All fixed slots absent with a present intent yield `unpublished`, which still says nothing about operation history. A matching receipt and artifacts can yield `consistent`, with no commit, ownership, execution, deletion, or cleanup authority.

On Windows the original integration reader retains its legacy mode-bit checks: these **do not validate source integration ACL privacy**. The private Windows ACL checks cover the operational control boundary, not all original receipts, shortcuts, or their parents. Diagnosis does not strengthen the legacy source ACL contract.

The lock coordinates only cooperating installer, intent-writer, and diagnosis calls. Legacy scripts, manual edits, sync tools, and other external writers must remain stopped. Two passes and file identity checks are not an atomic OS snapshot or protection against all same-account pathname races. This standalone source API is unused by the installer and updater; it adds no CLI, persistent journal, crash recovery, automatic action, or activation. Existing release evidence and the recommended v2.0.52 preview are unchanged; no new native CI success or verified release is claimed.

## Relationship to existing installer safeguards

The [source shared install/uninstall lock](native-install.md#unreleased-shared-installuninstall-lock) coordinates cooperating installer calls, the separate intent writer, and diagnosis. The codec remains pure, and intent reading, inventory inspection, and integration snapshot capture/verification remain unlocked and require quiescent writers. No successful native Windows result or released package inclusion is claimed for the new storage API.

The existing in-process cleanup guards still govern installer failures; they do not clean up intent-store output. Persisting a proposed intent does not connect it to installer execution. A future persistent transaction design still needs an installer publication, actual-byte verification, crash handling, ownership, and recovery contract. These APIs do not change [the update activation boundary](native-update.md#activation-boundary).
