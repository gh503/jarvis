# Native integration snapshots

Status: **upcoming source feature; no verified release yet**. The recommended release remains the [v2.0.49 unsigned preview](https://github.com/gh503/jarvis/releases/tag/v2.0.49), which does not include this API. The source module [native-integration-snapshot.ts](../scripts/native-integration-snapshot.ts) captures and verifies receipt-backed macOS or Windows native integration bytes. It provides no CLI, restore, activation, or writeback to installed integration locations.

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

This primitive adds no restore command, permission/ACL restoration, installation transaction, activation, or automatic rollback. It does not establish compatibility between package code, configuration, and database schemas. Keep the original compatible bundle and private config/data recovery material separately, and follow the operator-controlled boundaries in [native update staging and recovery](native-update.md).
