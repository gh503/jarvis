# Native update staging and recovery

The updater implements a local **staging preflight**, not an automatic upgrade. It verifies an extracted candidate, records the exact old/new release identities, runs an explicit isolated readiness check, and abandons a failed stage. It never downloads, extracts archives, changes shortcuts, stops the production server, copies production data, or migrates databases. Keep both portable folders in place. The existing installer targets a fixed folder; activation is a separate operator decision.

Run with a trusted Node 24 executable and the updater from your trusted checkout/package. Do not execute the candidate's updater to decide whether that candidate is trusted.

```sh
node --experimental-transform-types scripts/update-native.ts verify /absolute/new-bundle EXPECTED_NEW_MANIFEST_SHA256
node --experimental-transform-types scripts/update-native.ts stage /absolute/new-transaction /absolute/old-bundle EXPECTED_OLD_MANIFEST_SHA256 /absolute/new-bundle EXPECTED_NEW_MANIFEST_SHA256
node --experimental-transform-types scripts/update-native.ts health /absolute/new-transaction
node --experimental-transform-types scripts/update-native.ts rollback /absolute/new-transaction
```

On Windows use absolute Windows paths and quote paths containing spaces. Positional hashes are lowercase 64-character SHA256 values. Each command prints JSON; failure exits nonzero. The transaction directory must not already exist and must be separate from both bundles. Choose a private local location outside production data. `health` and `rollback` serialize with the existing lifecycle lock.

## Trust and compatibility

Supply manifest hashes obtained through an independently chosen trusted channel. Computing a manifest hash from an untrusted extracted folder merely pins those bytes; it does not authenticate a publisher. Published archive SHA256 sidecars are not manifest digests. This CLI deliberately does not accept an archive digest as proof of an extracted directory. If your trust anchor is an archive checksum, verify it externally and extract using a trusted tool that rejects traversal, links and special files before establishing the manifest digest. The backup tar helper is not an application archive extractor.

Verification requires a clean stable `X.Y.Z` release, exact source tag and commit identity, the current host platform and architecture, and Node 24 runtime metadata. The new version must be strictly greater than the baseline; equal versions, prereleases and downgrades are rejected. Both baseline and candidate are pinned to their independently supplied manifest hashes. Every declared file must match size and SHA256, all regular files must be listed, and symlinks, hardlinks, special files, duplicate/case-colliding paths, unsafe paths and root `.env` files are rejected. Hashes establish byte identity, not code safety or a sandbox. Keep the folders protected from concurrent modification: verification and execution cannot defend against a malicious process running as your user. The manifest's runtime version is authenticated metadata, not an independently executed runtime identity check.

## Health and rollback behavior

Staging executes no candidate code. `health` explicitly authorizes execution of the verified candidate's bundled runtime and main module. It rechecks both folders before execution, creates fresh `health-data` under the transaction, and passes an allowlisted environment. It does not inherit `NODE_OPTIONS`, `NODE_PATH`, provider secrets, or `JARVIS_*` configuration. Home, temporary files, and data use separate private sibling directories (`health-home`, `health-temp`, `health-data`) inside the transaction, so the data root is never the account home or temporary root; HTTP binds loopback on an ephemeral selected port and Ollama points to an unavailable loopback endpoint. A port collision fails readiness. Trusted candidate code still has the user's OS privileges; this is configuration isolation, not an OS sandbox.

Readiness uses authenticated runtime IPC, checks the expected loopback URL, requests shutdown, and waits for the directly spawned child. A child that fails to exit is terminated through that invocation's ChildProcess handle, never a stored PID. Readiness establishes startup viability only: it does not establish old database migration compatibility, provider operation, or packaged UI completeness.

The journal transitions from `staged` to `checking`, then `healthy` or `failed`. It records intent before launching candidate code. A failed health attempt preserves the journal, folders, and isolated data. `rollback` marks the stage abandoned, preserving all files for diagnosis; no production restore is needed because production was never changed. After interruption, rollback refuses to proceed while an isolated runtime still responds or owns its runtime lock. Inspect and explicitly stop that isolated runtime first; the journal cannot prove executable ownership after a crash. Do not delete a transaction while its candidate is running. Health cannot be retried in an existing transaction: rollback and create a new transaction.

Journal replacement uses a temporary file and rename. This is not a claim of power-loss durability or crash-atomic coordination across files. Interrupted creation may leave a transaction requiring manual inspection. There is no automatic garbage collection.

## Activation boundary

A `healthy` result is a reviewable staged version, not a switched installation. There is intentionally no `activate` command. Current shortcuts do not encode separate old/new data directories, the installer has no transactional switch API, and runtime status does not expose executable release identity. Automatically uninstalling/reinstalling shortcuts or running the candidate on old data could create a silent irreversible migration. Do not point a candidate at production data based solely on this preflight.

A future activation implementation needs an authenticated runtime release identity (canonical bundle root, source SHA and manifest digest), an installer transaction API with recoverable integration receipts, explicit separate old/new data locations, a stopped-owner compatible state backup/copy contract, and health plus rollback tested against those contracts. Existing production instance and data remain the rollback baseline until those conditions are met.
