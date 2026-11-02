# Native integration snapshots

> **Archive correction — repaired archives published in v2.0.75.** The historical packaging allowlist omitted snapshot/recovery/intent/diagnosis tooling and required installer/updater dependencies; known affected archives include v2.0.65 and v2.0.68. v2.0.75 includes the repaired tooling and dependencies, with archive inventory and management-module import gates passing on all three release platforms. The expanded downloaded-archive operation checks passed on Linux; subsequent release run 41518913786 at `7c59631` also passed the integration snapshot archive stage on Windows, macOS, and Linux. The fixtures do not install or activate OS integrations. The recommended unsigned preview remains v2.0.52 pending expanded native gates; this is not an assurance of snapshot or updater completeness in v2.0.52. See the [release pipeline evidence, historical fault, and verification limits](native-release-pipeline.md).
>
> The downloaded Linux v2.0.75 archive passed actual bundled integration snapshot CLI create, verify, and restore-copy with an empty PATH, using inert synthetic artifacts in a Darwin layout simulation on Linux. Receipt/artifact bytes and manifest digest matched, original bytes/identities/modes were preserved, and no OS installation or activation occurred. That local run alone did not establish native macOS or Windows coverage; the later [three-platform release run](https://github.com/gh503/jarvis/actions/runs/41518913786) supplies native-layout execution of these same synthetic capture/verify/recovery-copy checks, with no real desktop installation or activation claim.

Status: **persistent capture/verification API in the v2.0.53 source tag; create/verify CLI in the v2.0.54/v2.0.55 source tags; recovery copy in the v2.0.56 source tag; all excluded from those historical portable archives**. The recommended release intentionally remains the [v2.0.52 unsigned preview](https://github.com/gh503/jarvis/releases/tag/v2.0.52) while the later snapshot and lifecycle failures are being investigated; it includes neither the persistent snapshot API nor CLI. The read-only inventory prerequisite and in-process installation-failure cleanup are included in v2.0.52; this persistent snapshot format is separate.

[v2.0.53](https://github.com/gh503/jarvis/releases/tag/v2.0.53) source tag contains the capture/verification API in [native-integration-snapshot.ts](../scripts/native-integration-snapshot.ts) at source `bbaf9d783b5bc145114419d903d95f0307192c81`. All three jobs in [native CI 41489076014](https://github.com/gh503/jarvis/actions/runs/41489076014) and [release run 41489351802](https://github.com/gh503/jarvis/actions/runs/41489351802) succeeded; publication was separately verified with nine assets. The [snapshot CLI](../scripts/snapshot-native-integration.ts) is present in the source tag for [v2.0.54](https://github.com/gh503/jarvis/releases/tag/v2.0.54) at exact source `e655060f21496c4b1a0539cd8548536c411a0e17`: [release run 41491135172](https://github.com/gh503/jarvis/actions/runs/41491135172) succeeded with nine verified assets, [native CI 41490813672](https://github.com/gh503/jarvis/actions/runs/41490813672) succeeded on all three platforms, and the full regression had 935 tests, 910 passed, 25 skipped, and no failures. [v2.0.55](https://github.com/gh503/jarvis/releases/tag/v2.0.55), from documentation-only source `391e965`, has a source tag containing the same code; [release run 41491889648](https://github.com/gh503/jarvis/actions/runs/41491889648) succeeded with nine verified assets.

The source recovery-copy API and explicit `restore-copy` action at `46fe7a0` passed [native CI 41493371126](https://github.com/gh503/jarvis/actions/runs/41493371126) on all three platforms. They are present in the source tag for [v2.0.56](https://github.com/gh503/jarvis/releases/tag/v2.0.56) at exact source `46fe7a00d4e3fab935449eae4607f8641e4902a7`: [release run 41493639480](https://github.com/gh503/jarvis/actions/runs/41493639480) succeeded with nine verified assets. The full regression had 947 tests, 921 passed, 26 skipped, and no failures. This source tag also contains snapshot option preflight and Windows alias guards, but excludes the later installer option-path guard at `70f804` and the new shared installer lock. They copy recovery material to a fresh private directory and provide no system installation restore, activation, or writeback to installed integration locations. The later [installer option-path preflight hardening](native-install.md#unreleased-option-path-preflight-hardening) is not covered by these v2.0.53–v2.0.56 release results. Later source and publication evidence is recorded separately in the [release pipeline document](native-release-pipeline.md).

## Source CLI

Run from a current source checkout with a trusted source-development Node 24 executable. `create`, `verify`, and the `restore-copy` action require all of `--platform darwin|win32`, `--arch x64|arm64`, `--home ABS`, and `--root ABS`. Windows layout additionally requires `--app-data ABS` and `--local-app-data ABS`; macOS layout rejects both AppData flags. `create` requires `--destination ABS`; `verify` requires `--snapshot ABS` and `--manifest-sha256` with exactly 64 lowercase hexadecimal characters. `restore-copy` requires all three of `--snapshot ABS`, `--manifest-sha256` in that same digest format, and `--destination ABS`. Unknown, duplicate, missing, or action-inappropriate options are usage errors. `restore-copy` is a recovery-material copy, not a system restore command.

Every location is explicit: the CLI does not derive integration paths from ambient `HOME`, `USERPROFILE`, `APPDATA`, or `LOCALAPPDATA`. It parses and validates the complete argument list before importing the operational snapshot module. It does not load `.env` or external configuration, run the installer CLI, install integrations, or execute captured launchers or shortcuts. Native Windows privacy checks still use the system PowerShell program described below.

`--platform` describes the integration layout only. It does not require the running Node platform to match or execute that platform's artifacts. The source API also permits simulated layouts. Paths use the running host's absolute-path syntax and filesystem rules; layout simulation is not a cross-platform filesystem or ACL guarantee. `--arch` is a required supported label, not a check of the running Node architecture or installed binary architecture. `--root` is syntactically validated, not proof of installed package identity; the receipt-bound root remains authoritative as described below.

The following are **templates only**, using explicit placeholder user-home and temporary fixture paths. Replace every placeholder with reviewed canonical absolute paths, use a fresh destination beneath an existing private parent, and stop noncooperating source writers before capture (all source writers with source tags before the capture lock). These examples do not prepare fixtures, install anything, or constitute real-user integration actions. `REPLACE_WITH_TRUSTED_MANIFEST_SHA256` must be replaced with the digest from successful creation, saved separately in a trusted private record; it is deliberately not a valid digest.

POSIX shell, with a macOS layout and source Node 24 (replace `arm64` with `x64` if appropriate):

```sh
/absolute/path/to/source-node24/bin/node --experimental-transform-types scripts/snapshot-native-integration.ts create \
  --platform darwin --arch arm64 \
  --home /Users/EXAMPLE_USER/temporary-integration-fixture/home \
  --root /Users/EXAMPLE_USER/temporary-integration-fixture/package \
  --destination /Users/EXAMPLE_USER/private-snapshots/integration-001

/absolute/path/to/source-node24/bin/node --experimental-transform-types scripts/snapshot-native-integration.ts verify \
  --platform darwin --arch arm64 \
  --home /Users/EXAMPLE_USER/temporary-integration-fixture/home \
  --root /Users/EXAMPLE_USER/temporary-integration-fixture/package \
  --snapshot /Users/EXAMPLE_USER/private-snapshots/integration-001 \
  --manifest-sha256 REPLACE_WITH_TRUSTED_MANIFEST_SHA256

# Recovery-copy action, present in the v2.0.56 source tag; excluded from its archive.
/absolute/path/to/source-node24/bin/node --experimental-transform-types scripts/snapshot-native-integration.ts restore-copy \
  --platform darwin --arch arm64 \
  --home /Users/EXAMPLE_USER/temporary-integration-fixture/home \
  --root /Users/EXAMPLE_USER/temporary-integration-fixture/package \
  --snapshot /Users/EXAMPLE_USER/private-snapshots/integration-001 \
  --manifest-sha256 REPLACE_WITH_TRUSTED_MANIFEST_SHA256 \
  --destination /Users/EXAMPLE_USER/private-snapshots/integration-recovery-001
```

Windows PowerShell, with source Node 24 (replace `x64` with `arm64` if appropriate):

```powershell
& 'C:\absolute\path\to\source-node24\node.exe' --experimental-transform-types '.\scripts\snapshot-native-integration.ts' create `
  --platform win32 --arch x64 `
  --home 'C:\Users\EXAMPLE_USER\temporary-integration-fixture\home' `
  --root 'C:\Users\EXAMPLE_USER\temporary-integration-fixture\package' `
  --app-data 'C:\Users\EXAMPLE_USER\temporary-integration-fixture\home\AppData\Roaming' `
  --local-app-data 'C:\Users\EXAMPLE_USER\temporary-integration-fixture\home\AppData\Local' `
  --destination 'C:\Users\EXAMPLE_USER\private-snapshots\integration-001'

& 'C:\absolute\path\to\source-node24\node.exe' --experimental-transform-types '.\scripts\snapshot-native-integration.ts' verify `
  --platform win32 --arch x64 `
  --home 'C:\Users\EXAMPLE_USER\temporary-integration-fixture\home' `
  --root 'C:\Users\EXAMPLE_USER\temporary-integration-fixture\package' `
  --app-data 'C:\Users\EXAMPLE_USER\temporary-integration-fixture\home\AppData\Roaming' `
  --local-app-data 'C:\Users\EXAMPLE_USER\temporary-integration-fixture\home\AppData\Local' `
  --snapshot 'C:\Users\EXAMPLE_USER\private-snapshots\integration-001' `
  --manifest-sha256 REPLACE_WITH_TRUSTED_MANIFEST_SHA256

# Recovery-copy action, present in the v2.0.56 source tag; excluded from its archive.
& 'C:\absolute\path\to\source-node24\node.exe' --experimental-transform-types '.\scripts\snapshot-native-integration.ts' restore-copy `
  --platform win32 --arch x64 `
  --home 'C:\Users\EXAMPLE_USER\temporary-integration-fixture\home' `
  --root 'C:\Users\EXAMPLE_USER\temporary-integration-fixture\package' `
  --app-data 'C:\Users\EXAMPLE_USER\temporary-integration-fixture\home\AppData\Roaming' `
  --local-app-data 'C:\Users\EXAMPLE_USER\temporary-integration-fixture\home\AppData\Local' `
  --snapshot 'C:\Users\EXAMPLE_USER\private-snapshots\integration-001' `
  --manifest-sha256 REPLACE_WITH_TRUSTED_MANIFEST_SHA256 `
  --destination 'C:\Users\EXAMPLE_USER\private-snapshots\integration-recovery-001'
```

Success prints one minimal JSON receipt: creation returns `{ "snapshot": "…", "manifestSha256": "…" }`; verification returns `{ "verified": true, "snapshot": "…", "manifestSha256": "…" }`; `restore-copy` returns `{ "destination": "…", "manifestSha256": "…" }`. Output includes the snapshot path and digest, never captured file contents or the full manifest. Keep this output private. Success exits with status `0`, usage errors with `2`, and operational failures with `1`. CLI error diagnostics are bounded to 1,024 characters and do not expose captured bytes or raw exception text; an operational failure emits a fixed generic message. A failure may leave partial output as described below.

## Source API and trust

Trusted source callers use these asynchronous APIs with the installer's [InstallOptions](../scripts/install-native.ts) shape:

```ts
createIntegrationSnapshot({ integration: InstallOptions, destination })
verifyIntegrationSnapshot({ snapshot, manifestSha256, integration: InstallOptions })
// Recovery-copy API, present in the v2.0.56 source tag; excluded from its archive.
restoreIntegrationSnapshot({ snapshot, manifestSha256, integration: InstallOptions, destination })
```

Creation and verification return `{ snapshot, manifestSha256, manifest }`; recovery copy returns `{ destination, manifestSha256, manifest }`. `destination` must be a fresh canonical absolute path with an existing canonical parent. `snapshot` is the canonical absolute snapshot directory. Verification requires a lowercase 64-character SHA-256 digest of the exact manifest bytes, saved separately in a trusted private record. Computing a digest from an untrusted snapshot does not establish trust. The receipt is mutable local ownership metadata; neither the receipt nor these hashes authenticate a publisher.

`integration.platform` and the expected `home`, `appData`, and `localAppData` options select the fixed native receipt and artifact locations. Windows callers must supply both AppData paths explicitly. Verification checks those locations against the manifest and captured receipt. `integration.root` must be a valid absolute option path, but is **not asserted equal to the installed package root**. The actual receipt's `root`, `autostart`, and optional `configFile`/`dataDir` binding are authoritative, bound to the snapshot by the externally trusted manifest digest. Do not treat the caller's `root` or `arch` option as verified baseline package identity.

Verification reads the snapshot, not the original installation. The original package, configuration, data directory, receipt, and integration artifacts need not still exist. Their recorded paths remain bindings and overlap constraints. No original package contents or release identity are verified by this API.

## Capture scope and stopped writers

In the v2.0.68 source tag and current source, `createIntegrationSnapshot` acquires the [shared install/uninstall lock](native-install.md#unreleased-shared-installuninstall-lock) after pure integration-option and destination-path syntax validation and before the first source capture. It holds the lock continuously through copying, manifest publication, final snapshot verification, and the final source inspection/identity recheck, then releases it in `finally`, including on failure. The source CLI's `create` action calls this API and inherits the lock automatically. At exact source `d93f8fa73bf45c059498867f35f0bed547c41e4b`, [native CI run 41510352955](https://github.com/gh503/jarvis/actions/runs/41510352955) completed successfully, with native acceptance passing on Linux, Windows, and macOS. Separately, [v2.0.68 release run 41510639551](https://github.com/gh503/jarvis/actions/runs/41510639551) targeting that exact source completed successfully, and [v2.0.68](https://github.com/gh503/jarvis/releases/tag/v2.0.68) publication was verified with exactly nine assets: an unsigned archive, SHA256 sidecar, and provenance JSON for each of Linux x64, Windows x64, and macOS arm64. The capture lock and fixed lifecycle rejection-reason enum are present in the source tag for v2.0.68; this is source-tag evidence, not archive-inclusion evidence. Both remain excluded from v2.0.65. The earlier capture source tags described above require all source writers stopped. This success does not establish the root causes of the historical snapshot and lifecycle failures or change the recommended v2.0.52 preview.

The lock coordinates cooperating install/uninstall calls, the intent-storage writer, diagnosis calls, and snapshot creation. It uses the existing SQLite launcher lifecycle lock at `dirname(receipt)/native-install-control`, independently of package/config/data paths, architecture, or autostart. Stop legacy scripts, manual integration editors, sync tools, and every other noncooperating source writer for the entire capture. The lock stops no processes and provides no atomic filesystem snapshot or protection against intervening same-account mutation, including ABA replacement. Standalone `inspectNativeIntegration` remains unlocked and requires quiescent writers.

Lock preparation may create the control directory, required parents, and operational SQLite files even when capture later fails or the receipt is absent. Creation is therefore not wholly read-only: original receipt/artifact contents and permissions remain read-only, while operational lock storage and the fresh snapshot destination can be written. Unsafe existing control boundaries are rejected; existing control directories are verified without resetting modes or ACLs. The Windows FullControl requirement applies to operational lock storage, not a broad ACL guarantee for captured source artifacts. OS lock release after a crash adds no persistent intent journal, ownership adoption, reconciliation, automatic rollback, or activation.

`verifyIntegrationSnapshot` and `restoreIntegrationSnapshot` do not acquire this lock or inspect original integration contents. Their CLI `verify` and `restore-copy` actions are unchanged. Keep writers to the snapshot itself stopped throughout verification or recovery copy. Recovery copy retains its original-path boundary checks, but neither operation writes original integration locations or prepares installer control storage.

Creation requires an existing valid ownership receipt; a missing receipt fails instead of inventing an empty backup. Every fixed integration location is represented, including missing artifacts. Present artifacts must be owned by and match the receipt. A present startup artifact not listed in the receipt is rejected. Source inspection retains the installer's bounded receipt validation, safe-path checks, and applicable ownership/permission checks.

Capture performs inspection before and after copying and compares receipt/artifact content, modes, and absence. Bigint file identities are sampled across the whole capture window, including device, inode, mode, link count, owner/group, size, and nanosecond modification/change/birth times. These checks detect observed changes; equal observations cannot prove that no intervening mutation occurred or protect against hostile same-account races. Source files are opened read-only and their permissions are not repaired. OS-managed access-time updates can still occur from reading.

The destination must be disjoint in both directions from the receipt parent, every fixed artifact parent, and the **actual receipt-bound original package root**. If an external config binding exists, its parent directory and selected data directory are also protected. Existing source boundaries must be canonical and free of symlink/reparse aliases; original package/config/data paths may be absent. This rejects placing the snapshot inside a protected source or placing a protected source beneath the snapshot. These overlap protections are unchanged: the entire receipt parent is protected, so a snapshot cannot be placed in its `native-install-control` child either.

Only raw native integration bytes and the original receipt are copied. External configuration contents, data, package files, TLS material, models, and other referenced files are excluded. Embedded absolute paths remain unchanged. A captured launcher or shortcut is data: capture and verification do not execute it, invoke shortcut COM creation, or launch Jarvis. Windows privacy checks do invoke a fixed system PowerShell program.

## Exact layout and bounds

The shared-lock addition preserves the existing schema, manifest bytes, and layout. A complete snapshot contains exactly:

```text
manifest.json
receipt.bin
payload/
```

The payload directory contains only `{index}.bin` for present artifacts, indexed by their position in the fixed platform inventory. macOS has at most three artifacts (app launcher, app plist, login plist); Windows has at most two (Start menu and startup shortcuts). A missing artifact has no payload file. Extra entries, including extra empty directories, are rejected.

The canonical UTF-8 JSON manifest uses the exact producer field order, ends in one LF, and is limited to 16 KiB. It records schema version 1, platform, original receipt path, receipt binding, explicit scope limitations, original receipt mode, receipt byte length and SHA-256, and the fixed ordered artifact inventory. Each artifact records its original path, mode, byte length, and SHA-256; absence is represented by explicit `null` for **all three** of `mode`, `bytes`, and `sha256`.

The exact original receipt bytes are limited to 64 KiB. Each artifact is limited to 1 MiB, with at most three artifacts. Verification checks the external manifest digest, canonical encoding and fields, receipt format and binding, fixed inventory, receipt ownership hashes, payload lengths and hashes, and exact directory contents. Linked files and unsafe file types are rejected; reads are bounded and recheck file identity. These checks establish byte consistency, not schema compatibility or safe activation.

## Private output and failure handling

Treat receipts, manifests, and payloads as private: paths and integration arguments can disclose local information. POSIX snapshot directories use `0700` and files use `0600`; verification requires these exact private modes and current-user ownership. Recorded original modes retain the `07777` permission mask as metadata only. They are never applied to the source or snapshot copies, so executable source bytes remain non-executable snapshot data.

Windows creation establishes private output using the native private-directory policy. Verification runs a read-only ACL/reparse check on the bounded known snapshot paths: only the current user, SYSTEM, and Administrators may have allowed access entries; the current user needs read access, and ownership must be the current user or Administrators when elevated. It does not repair ACLs. This snapshot-output check does not add Windows ACL migration or a privacy guarantee for the original installed integrations.

Output files are created exclusively and individually flushed with file `fsync`. Copied receipt and payload bytes are read back and checked before publication. The manifest is written last, after source rechecks; creation then verifies the result and rechecks source inspection and identities once more before returning. No directory synchronization is performed. Failure can retain a private partial destination, including a published manifest if final verification or the final source recheck fails. Preserve it for inspection; do not treat its existence as successful capture or automatically reuse it. There is no automatic cleanup, crash-atomic multi-file publication, or power-loss durability guarantee.

## Recovery copy to a fresh private directory

The `restoreIntegrationSnapshot({ snapshot, manifestSha256, integration, destination })` API and `restore-copy` CLI action copy recovery material, not an actual installation. They fully verify the source snapshot against the externally trusted manifest digest and expected integration layout before creating the fresh destination. The original receipt, artifacts, package, config, and data need not exist. Their recorded locations remain bindings and protected boundaries.

The destination must not already exist, even as an empty directory, and must have an existing canonical parent. It must be disjoint in both directions from the source snapshot, original receipt parent, every fixed artifact parent, receipt-bound original package root, and any bound config parent and selected data directory. Existing ancestors must pass canonical-path checks, including when original files are absent. Nothing is overwritten or merged.

The copy retains the exact snapshot layout: `manifest.json`, `receipt.bin`, and `payload/{index}.bin` for present artifacts only. It copies exact manifest, receipt, and payload bytes without rewriting embedded paths, retains explicit null metadata and absent payloads for missing artifacts, and keeps the **same externally trusted manifest SHA-256**. Recorded original modes remain metadata only. POSIX destination directories are `0700` and files `0600`; executable source modes are never applied. Windows uses the private-directory policy and snapshot ACL checks described above.

All writers to the source snapshot must remain stopped throughout copying. After copying, the operation fully verifies both destination and source snapshots, checks source identities across the copy window, and compares the source manifest bytes again before success. These observations do not provide locks, an atomic snapshot, or protection against hostile same-account races. Each output file is created exclusively and file-fsynced; the manifest is copied last. A later failure retains a private partial destination, which may already contain the manifest. Preserve it for inspection and use a different fresh destination for a retry. There is no automatic cleanup, persistent recovery journal, directory synchronization, crash-atomic publication, or directory power-loss durability guarantee.

Recovery copy never writes original system integration locations, runs shortcut COM creation, constructs an installed app wrapper, executes captured artifacts, launches Jarvis, or activates anything. Windows privacy checks may run the fixed system PowerShell checker. A successful copy is independently verifiable recovery material, not permission/ACL restoration or a working installation.

## Recovery and activation boundary

Integration snapshots are separate from [native recovery sets](native-recovery-set.md). Recovery-set v1 retains its exact existing root layout and baseline/config/data contract; do not insert an integration snapshot into it. Coupling integration capture to a recovery set requires a separately designed future format version and coordination contract.

The explicit recovery-copy API and CLI action add no system installation restore, permission/ACL restoration, persistent recovery journal, installation transaction, activation, or automatic rollback. They do not establish compatibility between package code, configuration, and database schemas. Keep the original compatible bundle and private config/data recovery material separately, and follow the operator-controlled boundaries in [native update staging and recovery](native-update.md).
