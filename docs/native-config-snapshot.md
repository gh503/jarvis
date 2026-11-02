# Native config-only snapshots

Status: **released in [v2.0.42](https://github.com/gh503/jarvis/releases/tag/v2.0.42)**, including the offline CLI in the recommended portable preview packages. This is a private external-configuration recovery primitive, not a complete installation snapshot or an automatic updater. See [Native update staging and recovery](native-update.md).

A config snapshot preserves the exact original bytes of one validated external configuration file, including secrets, comments, quotes, whitespace, and line endings. It does not serialize parsed settings or rewrite `JARVIS_DATA_DIR`. The selected data directory is checked and locked, but its data tree is **not copied**. The separate [data-only snapshot CLI](native-state-snapshot.md) captures that tree; invoking both commands does not make them an atomic coupled snapshot or bind them to a compatible baseline binary or database schema.

## Commands and trust

Run from a trusted v2.0.42 portable package using its bundled Node 24. On Linux/macOS, from the extracted package directory:

```sh
./runtime/node --experimental-transform-types scripts/snapshot-native-config.ts create --config /absolute/private-config/config.env --data /absolute/data --destination /absolute/snapshots/new-config-snapshot
./runtime/node --experimental-transform-types scripts/snapshot-native-config.ts verify --snapshot /absolute/snapshots/new-config-snapshot --manifest-sha256 TRUSTED_MANIFEST_SHA256
./runtime/node --experimental-transform-types scripts/snapshot-native-config.ts restore --snapshot /absolute/snapshots/new-config-snapshot --manifest-sha256 TRUSTED_MANIFEST_SHA256 --destination /absolute/restores/new-config-directory
```

Source checkout users can substitute a trusted `node` 24 executable for the bundled runtime. Windows PowerShell uses the bundled executable, for example:

```powershell
& '.\runtime\node.exe' --experimental-transform-types '.\scripts\snapshot-native-config.ts' create --config 'C:\private-config\config.env' --data 'C:\data' --destination 'C:\snapshots\new-config-snapshot'
& '.\runtime\node.exe' --experimental-transform-types '.\scripts\snapshot-native-config.ts' verify --snapshot 'C:\snapshots\new-config-snapshot' --manifest-sha256 TRUSTED_MANIFEST_SHA256
& '.\runtime\node.exe' --experimental-transform-types '.\scripts\snapshot-native-config.ts' restore --snapshot 'C:\snapshots\new-config-snapshot' --manifest-sha256 TRUSTED_MANIFEST_SHA256 --destination 'C:\restores\new-config-directory'
```

Use canonical absolute paths without linked ancestors, and quote paths containing spaces. Create requires an explicit existing canonical `--data` directory matching the validated `JARVIS_DATA_DIR` value exactly. There is no implicit environment/config discovery, and snapshot operations do not load settings into or mutate the process environment. Destination parents must already exist; destination directories must not exist, even as empty directories. Unknown, repeated, or missing options are rejected.

Before acquiring locks, create also rejects overlap between the original config file's **parent directory** and the data directory, in either direction, so data-root permission preflight cannot change the config parent. Create rejects a destination that overlaps either the original config parent or the selected data directory, in either direction. Restore also rejects overlap with the snapshot tree and with the original config parent and data directory recorded in the manifest. A sibling config snapshot beneath the original config parent is therefore not permitted. Use separate private locations for source configuration, snapshots, and restored configuration. This is a snapshot-specific restriction: existing explicit config binding can place a validated config inside the data root, but that layout is unsupported by config snapshot creation.

Create prints JSON containing `snapshot` and `manifestSha256`. Keep the lowercase 64-character SHA256 digest in a separate private trusted record. Verify and restore require this externally supplied digest of the exact manifest bytes; they never trust a digest stored inside the snapshot. Computing a digest from an untrusted snapshot does not authenticate it. Verify prints `verified: true`, `snapshot`, and `manifestSha256`; restore prints `destination` and `manifestSha256`. These receipts contain paths and hashes, not configuration values or secrets. Paths themselves may be sensitive. Invalid CLI arguments exit with status 2; operation failures exit with status 1.

## Stop writers and preserve the binding

Stop the runtime normally and quiesce all configuration editors, external database tools, sync programs, legacy helpers, and other writers before create. Creation acquires the launcher lifecycle lock and then the runtime lifecycle lock. An active owner causes failure; this command does not stop or kill the runtime. Both locks remain held during capture and verification. Other writers that bypass those locks must remain stopped; locks cannot make separately invoked data and config captures atomic.

Lock acquisition performs the normal operational preflight: it may create or update lifecycle SQLite files and sidecars and prepare permissions/ACLs on the selected data root. Thus create is not a promise of zero filesystem mutations in the data directory. The source config and its permissions are only read and validated, never repaired or rewritten. No application data tree is captured.

Restore creates a fresh private directory containing `config.env` with the original bytes. It never copies over the original config, changes an installer binding or receipt, launches a runtime, or selects a binary. The restored file still points at the **old `JARVIS_DATA_DIR`**. It cannot be used as automatic relocation to a separately restored data tree. Selecting and validating any new binding is an explicit operator concern outside this primitive.

## Scope, privacy, and exact verification

The snapshot root contains exactly two regular files: `manifest.json` and `config.env`. No extra entries, including empty directories, are accepted. The canonical manifest records schema version, original config filename, selected data directory, config byte length and SHA256, and the config-only scope. It contains no parsed secret values, but reveals source paths and must remain private.

The shared private configuration reader returns original bytes and parsed values from the same bounded read. It validates UTF-8, recognized settings, required `JARVIS_DATA_DIR`, and applicable absolute-path settings. It rejects unsafe ownership/permissions, nonregular or multiply linked files, symbolic links, and linked ancestors; Windows additionally checks reparse points and private ACLs. Source validation and snapshot verification are read-only: unsafe permissions fail instead of being silently repaired. On POSIX, source config and its immediate parent must be owned by the current user with no group/other access. Snapshot directories require mode `0700` and files `0600`; Windows uses the private ACL policy. Create and restore establish private destination permissions before writing config bytes.

Verification checks the trusted manifest digest, exact canonical manifest encoding and fields, scope, exact root inventory, private file validation, config size and SHA256, and agreement between parsed `JARVIS_DATA_DIR` and the manifest. Source identity and byte checks detect changes during creation. These checks trust the OS account boundary and do not provide a sandbox or protection against malicious same-account filesystem races. Keep snapshots and restore locations protected from concurrent changes.

| Resource | Limit |
| --- | --- |
| Configuration file | 64 KiB (65,536 bytes) |
| Manifest | 16 KiB (16,384 bytes) |
| Snapshot root enumeration | At most 3 entries read; any third entry fails verification |
| CLI failure message detail | 1,024 characters; control characters sanitized |
| Windows private-file ACL check | 10-second subprocess timeout; 64 KiB output bound |

Config validation errors do not quote configuration contents. CLI failures omit stacks, causes, and thrown objects. Do not publish the config payload or private path/hash receipts as diagnostics. The config-only module does not inherit the data snapshot's tree-size limits or five-minute operation deadline.

Externally referenced TLS keys/certificates, model files, executables, other referenced resources, installer integration/ownership receipts, and the data tree are outside this snapshot's scope. A reference in config is preserved as text, not followed and copied. Keep the original stopped data, original config, and compatible binary as the recovery baseline; successful byte verification establishes neither schema compatibility nor safe activation.

## Failures and source API

Restore verifies the snapshot and checks destination constraints before creating its destination; a verification or preflight rejection does not create a destination or alter an existing one. Failures after destination creation preserve partial destination directories for manual inspection. There is no pruning, overwrite, merge, or automatic retry into an existing destination. A failure can leave config bytes and possibly a manifest; manifest presence alone does not establish success. Retain the trusted digest from a successful capture and verify before restore. Use a different fresh destination for retry.

Files are flushed before successful writes complete; directory entries are not flushed. This is not a complete recovery transaction or a claim of power-loss durability or atomic coordination across configuration, data, installation bindings, and release identity.

The source module [native-config-snapshot.ts](../scripts/native-config-snapshot.ts) exports asynchronous operations:

```ts
createConfigSnapshot({ configFile, dataDir, destination })
verifyConfigSnapshot({ snapshot, manifestSha256 })
restoreConfigSnapshot({ snapshot, manifestSha256, destination })
```

Create and verify return `{ snapshot, manifestSha256, manifest }`; restore returns `{ destination, manifestSha256, manifest }`. The module exports `ConfigSnapshotManifest`. The [CLI](../scripts/snapshot-native-config.ts) exposes only the path/hash receipts described above. The API has the same explicit trust, stopped-writer, config-only, fresh-destination, and compatibility boundaries.

**Upcoming source API, not yet published:** trusted internal modules can pass `createConfigSnapshot({ configFile, dataDir, destination, scope })` inside `withStoppedDataScope(dataDir, async scope => ...)`, then optionally await data snapshot creation under the same continuously held locks. The explicit `dataDir` must still match the config and the scope's canonical root; source config and destination separation rules remain unchanged. See the [stopped-data scope contract and example](stopped-data-scope.md). Operations must be awaited sequentially; invalid or concurrent admission rejects before snapshot preflight, pending work drains before lock release, and caught operation/admission failures still fail the outer scope. Without `scope`, create retains its own lock ownership and existing manifest format. CLI behavior is unchanged; there is no `--scope` flag. This does not add an aggregate recovery manifest, installer receipt/version capture, or cross-version compatibility.
