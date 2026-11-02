# Native data-only state snapshots

Status: **first released in [v2.0.38](https://github.com/gh503/jarvis/releases/tag/v2.0.38)**, including the offline CLI in portable packages. The current recommended preview is [v2.0.40](https://github.com/gh503/jarvis/releases/tag/v2.0.40). This is the data-filesystem snapshot prerequisite for native update recovery, not a complete installation snapshot or an automatic updater. See [Native update staging and recovery](native-update.md).

The snapshot copies the complete stopped data directory as raw files and directories, with only the nine root-level ownership/coordination files listed below excluded. It preserves empty directories, secrets, keys, tokens, and application SQLite database sidecars, including WAL. It does not export logical records, open application databases to migrate them, or promise logical/schema compatibility with another binary.

## Commands and trust

Run this offline CLI from a trusted v2.0.40 portable package using its bundled Node 24. Stop the runtime and all other writers before creation; this command does not stop them for you. On Linux/macOS, from the extracted package directory:

```sh
./runtime/node --experimental-transform-types scripts/snapshot-native.ts create --data /absolute/data --destination /absolute/new-snapshot
./runtime/node --experimental-transform-types scripts/snapshot-native.ts verify --snapshot /absolute/new-snapshot --manifest-sha256 TRUSTED_MANIFEST_SHA256
./runtime/node --experimental-transform-types scripts/snapshot-native.ts restore --snapshot /absolute/new-snapshot --manifest-sha256 TRUSTED_MANIFEST_SHA256 --destination /absolute/new-restored-data
```

Windows PowerShell uses the same commands and options with the bundled executable, for example:

```powershell
& '.\runtime\node.exe' --experimental-transform-types '.\scripts\snapshot-native.ts' create --data 'C:\private\data' --destination 'C:\private\new-snapshot'
& '.\runtime\node.exe' --experimental-transform-types '.\scripts\snapshot-native.ts' verify --snapshot 'C:\private\new-snapshot' --manifest-sha256 TRUSTED_MANIFEST_SHA256
& '.\runtime\node.exe' --experimental-transform-types '.\scripts\snapshot-native.ts' restore --snapshot 'C:\private\new-snapshot' --manifest-sha256 TRUSTED_MANIFEST_SHA256 --destination 'C:\private\new-restored-data'
```

Source checkout users can substitute a trusted `node` 24 executable for the bundled runtime.

On Windows use absolute Windows paths and quote paths containing spaces. Paths must be canonical absolute paths without linked ancestors. Destination parents must already exist; destinations must not exist, even as empty directories. Create requires a destination separate from the source data tree. Restore requires a destination separate from both the snapshot tree and the original source data tree recorded in the manifest. There is no implicit configuration discovery, overwrite, merge, or default destination. Unknown, repeated, or missing options are rejected.

`TRUSTED_MANIFEST_SHA256` must be the lowercase 64-character SHA256 digest of the exact manifest bytes, obtained from a trusted source and kept separately from the snapshot. Create prints JSON containing `snapshot` and `manifestSha256`; retain that digest in a private trusted record. Verify prints `verified: true`, `snapshot`, and `manifestSha256`; restore prints `destination` and `manifestSha256`. Successful stdout contains paths and hashes, not copied file contents or secrets. Invalid arguments exit with status 2; operation failures exit with status 1.

Verify and restore require the external digest; they never adopt a digest from inside the snapshot as their trust anchor. Hashing an untrusted manifest and then supplying its hash does not establish authenticity. The snapshot directory contains `snapshot-manifest.json` and `payload/`. The manifest records the source data path, creation time, scope, exact exclusions, all directories, and file sizes and SHA256 digests. Protect the manifest too: paths and filenames can be sensitive.

## Stop writers before creating a snapshot

Stop the runtime normally before invoking create. Create acquires the launcher lifecycle lock first and the runtime lifecycle lock second, with no wait for an active owner. An active runtime causes failure; create does not request shutdown or kill processes. Both locks are held while copying and checking the stopped tree.

In v2.0.40, the shared lifecycle-lock guard checks the SQLite main database and journal/WAL/SHM sidecars, rejecting hardlinks, symlinks and nonregular entries before SQLite mutation. The main database identity must stay stable, while normal SQLite sidecar removal and recreation are allowed. These checks do not guarantee protection against hostile same-user filesystem races.

The current offline memory/reminder/migration CLI participates in runtime locking. Older binaries and legacy Linux shell helpers, including `gen-tls`, `setup-models`, and `launch`, can bypass these locks. Stop all such helpers, external database tools, sync programs, and other writers before create, and keep the snapshot and restore destination protected against concurrent modification during verification and restore. Lifecycle locks coordinate participating programs only. Repeated tree inventories, file identity checks, and content hashes detect unstable trees; they are not an OS sandbox or a guarantee against hostile same-account writers racing filesystem operations.

## Exact data scope

Only these exact names at the **data root** are excluded:

```text
launcher.lock.sqlite
launcher.lock.sqlite-journal
launcher.lock.sqlite-shm
launcher.lock.sqlite-wal
runtime-instance.json
runtime.lock.sqlite
runtime.lock.sqlite-journal
runtime.lock.sqlite-shm
runtime.lock.sqlite-wal
```

These are ownership locks, their SQLite sidecars, and the runtime descriptor. The exclusion is not a wildcard: the same names in nested directories remain part of the snapshot. All other supported files and directories are included, including hidden files, empty directories, credentials, application database WAL/journal/SHM files, and local TLS material inside the data tree. Unsafe or unsupported entries cause failure rather than silent omission. This is a byte/content inventory, not a preservation promise for original ownership, timestamps, or all filesystem metadata.

External configuration files, installer ownership/integration receipts, and TLS keys or certificates referenced by external paths are **not captured**. Neither are other files outside the selected data directory. Relocation does not rewrite embedded absolute paths in configuration or database contents. A restored tree may still refer to old or external locations; resolving those bindings is a separate operator and future activation concern.

A copied SQLite WAL can contain committed state absent from the main database file. Preserve the complete restored database and its sidecars with the intended compatible binary. Do not discard WAL/journal/SHM files as cleanup or treat a successful byte verification as proof of database compatibility. Snapshot creation and restoration do not establish whether an old binary can read data modified by a new binary.

## Validation and resource bounds

Verification checks the trusted manifest digest and canonical manifest encoding, then checks exact directory and file inventories, sizes, and content hashes. Missing or extra files, extra directories (including empty ones), changed contents, and tampered metadata fail verification. The snapshot root may contain only the manifest and payload directory.

Unsafe cross-platform paths, traversal, reserved Windows names, duplicate or case/Unicode-colliding paths, symbolic links, hard-linked files, Windows reparse points, and special files are rejected. Path ancestors are checked as well. These conservative restrictions can reject trees that a particular host filesystem otherwise accepts.

Operations use bounded streaming and finite limits:

| Resource | Limit |
| --- | --- |
| File read/copy chunk | 1 MiB |
| Individual file | 16 GiB |
| Total payload bytes | 64 GiB |
| Tree inventory | 100,000 entries, including directories |
| Relative path depth | 64 components |
| UTF-8 path length | 4,096 bytes total; 255 bytes per component |
| Manifest | 16 MiB |
| Operation deadline | 5 minutes |

The deadline is checked during filesystem work; it is not a guarantee that the OS can interrupt every stalled filesystem call. Manifest parsing is bounded separately from streamed payload reads.

## Privacy, restoration, and failures

A snapshot contains usable secrets, keys, tokens, and private application state. Keep it private; do not upload it to an issue, public artifact store, or diagnostic service. Create and restore establish private destination permissions before copying payload bytes (private directory/file modes on POSIX and the native private-directory ACL preparation on Windows). Select a private parent location and protect any separate digest record.

Restore verifies the snapshot before creating a fresh destination, copies the full inventory, and checks the restored contents. It never overwrites current data or activates the restored tree. It does not change shortcuts, autostart, configuration bindings, or the selected runtime binary. Choosing a compatible binary and explicitly selecting a restored data directory are separate steps; full transactional activation remains unimplemented.

Failures retain partial destination directories for manual inspection. A manifest is published only after the payload copy and verification succeed; interrupted work can leave a pending manifest or incomplete private payload. A failure during final publication/durability work can still leave published files: rely on a successful command and later verification, not mere manifest presence. Restore failures likewise leave partial restored data. There is no automatic pruning or deletion, and retries require a different fresh destination. Inspect retained files before manually removing them; never discard the original database sidecars as part of snapshot cleanup.

Copied files and the manifest are flushed before successful publication. Directory entries are not flushed by this implementation on either POSIX or Windows. These operations do not promise power-loss durability or atomic recovery across an entire multi-file tree. Keep the original stopped data and compatible binary as the recovery baseline until a separately designed activation/recovery contract exists.

## Source API

The source module [native-state-snapshot.ts](../scripts/native-state-snapshot.ts) exports:

```ts
createStateSnapshot({ dataDir, destination })
verifyStateSnapshot({ snapshot, manifestSha256 })
restoreStateSnapshot({ snapshot, manifestSha256, destination })
```

All three are asynchronous. Create and verify return `{ snapshot, manifestSha256, manifest }`; restore returns `{ destination, manifestSha256, manifest }`. The module also exports `StateSnapshotManifest` and `STATE_SNAPSHOT_LIMITS`. The CLI exposes only the path/hash results described above. The API has the same explicit trust, stopped-writer, fresh-destination, data-only, and compatibility boundaries as the CLI.
