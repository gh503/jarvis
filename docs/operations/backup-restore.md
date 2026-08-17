# Backup and Restore

Jarvis `v0.1` creates an offline, integrity-checked backup of the local Harness
and Jarvis state. The archive is private but not encrypted.

## Included state

- Harness sessions under `.dsh/sessions/`.
- Harness workspace and projection stores under `.dsh/storages/`.
- Jarvis reminders, owner-controlled memory, and append-only audit records.
- Gateway pairing, access-session, and retained-event state when present.

The archive never includes `.env`, Harness root settings or credentials,
macOS Keychain items, the Gateway Owner Token, TLS keys, dependency caches,
service logs, or Git data. A restore keeps settings, credentials, and unmanaged
logs already present at the destination. A clean machine requires separate
settings and credential configuration.

## Create a backup

1. Stop every foreground Harness and Gateway process. If the Harness is managed
   by the LaunchAgent, run `./scripts/uninstall-launch-agent.sh`; it keeps data.
2. Create a new archive path. Existing archives are never overwritten.

```bash
npm run backup -- --output backups/jarvis-backup.jarvis
```

The command acquires an exclusive maintenance lease, reads every source twice,
and fails if supported Jarvis processes are active or state changes during the
snapshot. The resulting archive and every payload entry must have private
owner-only permissions.

Store the archive on an encrypted volume or in another encrypted backup system.
The `0600` file mode prevents other local accounts from reading it but does not
encrypt its conversations, reminders, memory, or audit history.

## Restore a backup

1. Stop Harness and Gateway processes.
2. Keep a separate copy of the current state until the restore is verified.
3. Restore the archive.

```bash
npm run restore -- --archive backups/jarvis-backup.jarvis
```

Before replacement, Jarvis validates the archive format and application
version, allowlisted relative paths, entry count and size limits, JSON state,
private permissions, decoded sizes, and every SHA-256 digest. It writes all
replacement files to private temporary paths before atomically renaming managed
state into place. A failed validation or replacement rolls back existing managed
state.

Restart with `npm start` or reinstall the LaunchAgent. Reconfigure Harness
settings, model credentials, Keychain, Owner Token, and TLS credentials
separately on a new Mac, then verify one restored conversation, reminder, and memory item
before deleting the pre-restore copy.

## Alternate state directories

Development and recovery rehearsals can target isolated directories without
touching the normal state:

```bash
npm run backup -- \
  --output /private/path/jarvis-backup.jarvis \
  --dsh-home /private/path/source/.dsh \
  --data-dir /private/path/source/data \
  --runtime-dir /private/path/source/.jarvis-runtime

npm run restore -- \
  --archive /private/path/jarvis-backup.jarvis \
  --dsh-home /private/path/restored/.dsh \
  --data-dir /private/path/restored/data \
  --runtime-dir /private/path/restored/.jarvis-runtime
```

The archive must remain outside both data directories. Harness and Jarvis data
directories must also be separate and must not contain one another.
