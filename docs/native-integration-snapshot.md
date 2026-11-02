# Native integration snapshots

Status: **upcoming source feature; no verified release yet**. The recommended release remains the [v2.0.52 unsigned preview](https://github.com/gh503/jarvis/releases/tag/v2.0.52), which includes neither this API nor this CLI. The source module [native-integration-snapshot.ts](../scripts/native-integration-snapshot.ts) and source CLI [snapshot-native-integration.ts](../scripts/snapshot-native-integration.ts) capture and verify receipt-backed macOS or Windows native integration bytes. They provide no restore, activation, or writeback to installed integration locations.

The read-only inventory prerequisite and in-process installation-failure cleanup are included in v2.0.52; this persistent snapshot format is separate. API source `bbaf` passed all three jobs in [native CI 41489076014](https://github.com/gh503/jarvis/actions/runs/41489076014), but [release packaging/publication 41489351802](https://github.com/gh503/jarvis/actions/runs/41489351802) was still in progress at this evidence check. CLI source `e655` had [native CI 41490813672](https://github.com/gh503/jarvis/actions/runs/41490813672) still running. Neither the snapshot API nor CLI is included in v2.0.52.

## Source CLI

Run from a current source checkout with a trusted source-development Node 24 executable. Both `create` and `verify` require all of `--platform darwin|win32`, `--arch x64|arm64`, `--home ABS`, and `--root ABS`. Windows layout additionally requires `--app-data ABS` and `--local-app-data ABS`; macOS layout rejects both AppData flags. `create` requires `--destination ABS`; `verify` requires `--snapshot ABS` and `--manifest-sha256` with exactly 64 lowercase hexadecimal characters. Unknown, duplicate, missing, or action-inappropriate options are usage errors. There is no `restore` action.

Every location is explicit: the CLI does not derive integration paths from ambient `HOME`, `USERPROFILE`, `APPDATA`, or `LOCALAPPDATA`. It parses and validates the complete argument list before importing the operational snapshot module. It does not load `.env` or external configuration, run the installer CLI, install integrations, or execute captured launchers or shortcuts. Native Windows privacy checks still use the system PowerShell program described below.

`--platform` describes the integration layout only. It does not require the running Node platform to match or execute that platform's artifacts. The source API also permits simulated layouts. Paths use the running host's absolute-path syntax and filesystem rules; layout simulation is not a cross-platform filesystem or ACL guarantee. `--arch` is a required supported label, not a check of the running Node architecture or installed binary architecture. `--root` is syntactically validated, not proof of installed package identity; the receipt-bound root remains authoritative as described below.

The following are **templates only**, using explicit placeholder user-home and temporary fixture paths. Replace every placeholder with reviewed canonical absolute paths, use a fresh destination beneath an existing private parent, and stop all source writers before capture. These examples do not prepare fixtures, install anything, or constitute real-user integration actions. `REPLACE_WITH_TRUSTED_MANIFEST_SHA256` must be replaced with the digest from successful creation, saved separately in a trusted private record; it is deliberately not a valid digest.

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
```

Success prints one minimal JSON receipt: creation returns `{ "snapshot": "…", "manifestSha256": "…" }`; verification returns `{ "verified": true, "snapshot": "…", "manifestSha256": "…" }`. Output includes the snapshot path and digest, never captured file contents or the full manifest. Keep this output private. Success exits with status `0`, usage errors with `2`, and operational failures with `1`. CLI error diagnostics are bounded to 1,024 characters and do not expose captured bytes or raw exception text; an operational failure emits a fixed generic message. A failure may leave partial output as described below.

## Source API and trust

Trusted source callers use these asynchronous APIs with the installer's [InstallOptions](../scripts/install-native.ts) shape:

```ts
createIntegrationSnapshot({ integration: InstallOptions, destination })
verifyIntegrationSnapshot({ snapshot, manifestSha256, integration: InstallOptions })
```

Both return `{ snapshot, manifestSha256, manifest }`. `destination` must be a fresh canonical absolute path with an existing canonical parent. `snapshot` is the canonical absolute snapshot directory. Verification requires a lowercase 64-character SHA-256 digest of the exact manifest bytes, saved separately in a trusted private record. Computing a digest from an untrusted snapshot does not establish trust. The receipt is mutable local ownership metadata; neither the receipt nor these hashes authenticate a publisher.

`integration.platform` and the expected `home`, `appData`, and `localAppData` options select the fixed native receipt and artifact locations. Windows callers must supply both AppData paths explicitly. Verification checks those locations against the manifest and captured receipt. `integration.root` must be a valid absolute option path, but is **not asserted equal to the installed package root**. The actual receipt's `root`, `autostart`, and optional `configFile`/`dataDir` binding are authoritative, bound to the snapshot by the externally trusted manifest digest. Do not treat the caller's `root` or `arch` option as verified baseline package identity.

Verification reads the snapshot, not the original installation. The original package, configuration, data directory, receipt, and integration artifacts need not still exist. Their recorded paths remain bindings and overlap constraints. No original package contents or release identity are verified by this API.

## Capture scope and stopped writers

Stop all writers before capture and keep them stopped for the entire operation: installer/uninstaller invocations, integration editors, sync tools, and any other process that could change the sources. The operation acquires no installer or lifecycle locks, stops no processes, and is not an atomic filesystem snapshot.

Creation requires an existing valid ownership receipt; a missing receipt fails instead of inventing an empty backup. Every fixed integration location is represented, including missing artifacts. Present artifacts must be owned by and match the receipt. A present startup artifact not listed in the receipt is rejected. Source inspection retains the installer's bounded receipt validation, safe-path checks, and applicable ownership/permission checks.

Capture performs inspection before and after copying and compares receipt/artifact content, modes, and absence. Bigint file identities are sampled across the whole capture window, including device, inode, mode, link count, owner/group, size, and nanosecond modification/change/birth times. These checks detect observed changes; equal observations cannot prove that no intervening mutation occurred or protect against hostile same-account races. Source files are opened read-only and their permissions are not repaired. OS-managed access-time updates can still occur from reading.

The destination must be disjoint in both directions from the receipt parent, every fixed artifact parent, and the **actual receipt-bound original package root**. If an external config binding exists, its parent directory and selected data directory are also protected. Existing source boundaries must be canonical and free of symlink/reparse aliases; original package/config/data paths may be absent. This rejects placing the snapshot inside a protected source or placing a protected source beneath the snapshot.

Only raw native integration bytes and the original receipt are copied. External configuration contents, data, package files, TLS material, models, and other referenced files are excluded. Embedded absolute paths remain unchanged. A captured launcher or shortcut is data: capture and verification do not execute it, invoke shortcut COM creation, or launch Jarvis. Windows privacy checks do invoke a fixed system PowerShell program.

## Exact layout and bounds

A complete snapshot contains exactly:

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

## Recovery and activation boundary

Integration snapshots are separate from [native recovery sets](native-recovery-set.md). Recovery-set v1 retains its exact existing root layout and baseline/config/data contract; do not insert an integration snapshot into it. Coupling integration capture to a recovery set requires a separately designed future format version and coordination contract.

The source API and CLI add no restore command, permission/ACL restoration, persistent recovery journal, installation transaction, activation, or automatic rollback. They do not establish compatibility between package code, configuration, and database schemas. Keep the original compatible bundle and private config/data recovery material separately, and follow the operator-controlled boundaries in [native update staging and recovery](native-update.md).
