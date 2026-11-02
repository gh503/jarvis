# Native recovery sets

Status: **released in [v2.0.47](https://github.com/gh503/jarvis/releases/tag/v2.0.47)**, including the offline CLI in portable packages. A recovery set binds a verified baseline portable package identity to private config and data snapshots captured sequentially under one continuously held [stopped-data scope](stopped-data-scope.md). It provides coordinated capture and verification, not an automatic updater or a restore/activation transaction. See [Native update staging and recovery](native-update.md).

## Commands and trust

Run from a trusted v2.0.47 portable package using its bundled Node 24. On Linux/macOS, from the extracted package directory:

```sh
./runtime/node --experimental-transform-types scripts/recovery-native.ts create --bundle /absolute/baseline-bundle --bundle-manifest-sha256 TRUSTED_BUNDLE_MANIFEST_SHA256 --config /absolute/private-config/config.env --data /absolute/data --destination /absolute/private-snapshots/new-recovery-set
./runtime/node --experimental-transform-types scripts/recovery-native.ts verify --recovery-set /absolute/private-snapshots/new-recovery-set --manifest-sha256 TRUSTED_RECOVERY_MANIFEST_SHA256
```

Windows PowerShell, from the extracted package directory:

```powershell
& '.\runtime\node.exe' --experimental-transform-types '.\scripts\recovery-native.ts' create --bundle 'C:\baseline-bundle' --bundle-manifest-sha256 TRUSTED_BUNDLE_MANIFEST_SHA256 --config 'C:\private-config\config.env' --data 'C:\data' --destination 'C:\private-snapshots\new-recovery-set'
& '.\runtime\node.exe' --experimental-transform-types '.\scripts\recovery-native.ts' verify --recovery-set 'C:\private-snapshots\new-recovery-set' --manifest-sha256 TRUSTED_RECOVERY_MANIFEST_SHA256
```

Source checkout users can substitute a trusted `node` 24 executable for the bundled runtime.

On Windows use canonical absolute Windows paths and quote paths containing spaces. Both digest arguments require lowercase 64-character SHA256 values. Unknown, repeated, missing, or malformed options fail before an operation starts. There is no implicit environment/config discovery. Existing update, config-snapshot, and data-snapshot CLI interfaces remain unchanged; no `--scope` flag is added to them.

The baseline digest must come from an independently trusted record of the extracted package manifest. An archive checksum is not that manifest digest. The baseline undergoes the [full bundle verification](native-update.md#trust-and-compatibility), including its file inventory, sizes, hashes, clean stable release/source identity, current platform and architecture, and Node 24 runtime metadata. It is a retained baseline, not a candidate version comparison or proof of database compatibility.

Create prints JSON containing only `recoverySet` and `manifestSha256`. Save this aggregate digest in a separate private trusted record protected from modification with the set. Verification requires that externally saved, immutable trust anchor; it never adopts a local checksum or computes a new trust anchor from the set being checked. Hashing an untrusted manifest does not authenticate it. Verify prints `verified: true`, `recoverySet`, and `manifestSha256`. Successful output contains paths and digests, never config contents or the aggregate manifest. Paths themselves can be sensitive. Invalid arguments exit with status 2; operation failures exit with status 1 and a bounded, control-character-sanitized diagnostic without stacks or causes.

## Sources and stopped capture

The baseline bundle and data root must be existing canonical directories, and the config must be a validated private external config file whose explicit `JARVIS_DATA_DIR` equals the selected data root. Source paths and ancestors must satisfy the existing no-link validation. The bundle root, config **parent directory**, and data root must be pairwise disjoint in both directions. The destination must be fresh, with an existing canonical parent, and separate from all three source directories in both directions. A config inside the data root, or a destination beneath the config parent, is unsupported. Choose separate private source-config and snapshot locations.

Stop the runtime normally and stop all other writers before creation, including config editors, bundle updates, external database tools, sync programs, and legacy helpers. Keep them stopped throughout capture. The operation acquires launcher then runtime lifecycle locks once for the same canonical data root; an active owner causes failure, without shutdown or killing processes. Both locks remain held across baseline verification, config capture, data capture, child verification, final checks, and aggregate publication. Lock preflight may create/update operational lock files and prepare data-root permissions/ACLs. Source config validation remains read-only; settings are not loaded into the process environment.

The baseline package is fully verified before and after capture. The original config bytes and file identity are checked across the whole interval, including after data capture, and the data-root identity is checked. Config is captured first, then data, using the same scope; both child snapshots are verified before publishing the aggregate. The data child preserves the [existing exact data scope and nine root exclusions](native-state-snapshot.md#exact-data-scope), including application database sidecars and empty directories. The config child preserves [exact original config bytes](native-config-snapshot.md), including secrets, comments, and quotes.

These checks detect changed observations; equality before and after cannot prove the absence of arbitrary intervening mutations. Lifecycle locks coordinate participating writers only. This is not an atomic filesystem/OS snapshot, an OS sandbox, or protection against hostile same-account mutation. Coherence is conditional on all other writers remaining stopped.

## Layout and verification

The recovery root contains exactly:

```text
recovery-manifest.json
config/
data/
```

`config/` is an unchanged-format config snapshot (`manifest.json` and `config.env`); `data/` is an unchanged-format data snapshot (`snapshot-manifest.json` and `payload/`). Extra root entries are rejected, including empty directories. The canonical UTF-8 JSON aggregate ends with one LF and is limited to 16 KiB. It records:

- Schema version and explicit scope/limitation fields.
- `baseline`: the verified package root, raw package manifest SHA256, stable version, source SHA, current platform/architecture, and Node 24 runtime version metadata.
- Original config filename and selected data directory.
- The exact config and data child manifest SHA256 digests.

Verification checks the externally supplied aggregate digest, canonical encoding, exact fields and scope, root inventory, both complete child snapshots, and agreement between the aggregate and child source paths. It fully verifies the retained baseline package and requires its identity to match the aggregate. The original config file and original data directory need not remain available for verification; their recorded paths are bindings, not sources to read during verification.

**The baseline bundle is not copied into the set.** Its original recorded package path must remain available and unchanged for verification. Retain and protect that package separately; the recovery directory alone is not self-contained. The baseline runtime version is authenticated manifest metadata, not an independent execution check. Successful byte verification establishes neither schema compatibility nor safe activation.

Child validators retain their existing finite bounds. Config payload and manifest limits are 64 KiB and 16 KiB. Data snapshots retain their 16 GiB per-file, 64 GiB total-payload, 100,000-entry, 64-component-depth, 16 MiB manifest, and five-minute per-operation limits; see [all data bounds](native-state-snapshot.md#validation-and-resource-bounds). Bundle verification retains its own bounded streaming and limits. The wrapper makes a fixed number of child calls; it does not add an unbounded outer tree walk or a single overall deadline.

## Privacy, failure, and recovery boundaries

Config and data payloads contain usable secrets and private application state. Keep the set, its parent location, and the separately saved digest private. Creation establishes private destinations before copying secret bytes (private POSIX modes or native Windows ACL policy). Manifests expose source paths and filenames and must also remain private. Do not publish these payloads or receipts as diagnostics.

A preflight rejection leaves the fresh destination absent, although lifecycle-lock preflight can affect operational source files and data-root permissions. Failures after destination creation retain private partial output for manual inspection; there is no failure cleanup, pruning, overwrite, merge, or retry into an existing destination. An earlier child can be complete while a later child is partial. The aggregate is written exclusively only after capture and checks, and its file is flushed with `fsync`. Child file flushing follows the existing snapshot contracts. Directory entries are not flushed; there is no directory-durability or power-loss guarantee. Manifest presence alone is not proof of successful capture: retain the digest from a successful command and verify before relying on the set. Retry with a different fresh destination.

There is no recovery-set restore command or activation command. The existing child restore APIs still restore only into fresh directories, without switching installations. Config bytes retain the old `JARVIS_DATA_DIR`; relocation does not rewrite this or other embedded absolute paths. The set does not capture installer ownership/integration receipts, external TLS material, external models, or other referenced files outside its config/data scope. References remain text rather than instructions to copy external resources.

This binding does not establish cross-version configuration or database compatibility, logical database consistency beyond the stopped-writer contract, or a recoverable installation switch. Keep the original stopped data, original config, and compatible baseline package until a separately designed activation/recovery contract exists.

## Source API

The source module [native-recovery-set.ts](../scripts/native-recovery-set.ts) exports asynchronous operations:

```ts
createRecoverySet({ bundle, bundleManifestSha256, configFile, dataDir, destination })
verifyRecoverySet({ recoverySet, manifestSha256 })
```

Both return `{ recoverySet, manifestSha256, manifest }`; the module exports `RecoverySetManifest`. The [CLI](../scripts/recovery-native.ts) emits only the minimal path/digest receipts described above. The API has the same explicit trust, baseline retention, private-destination, stopped-writer, and compatibility boundaries.
