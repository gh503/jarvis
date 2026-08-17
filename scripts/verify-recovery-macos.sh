#!/bin/zsh
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  print -u2 'Recovery verification requires macOS.'
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPORARY="$(mktemp -d "${TMPDIR:-/tmp}/jarvis-recovery.XXXXXX")"
SOURCE_DSH="$TEMPORARY/source/.dsh"
SOURCE_DATA="$TEMPORARY/source/data"
RESTORED_DSH="$TEMPORARY/restored/.dsh"
RESTORED_DATA="$TEMPORARY/restored/data"
ROLLBACK_DSH="$TEMPORARY/rollback/.dsh"
ROLLBACK_DATA="$TEMPORARY/rollback/data"
ARCHIVE="$TEMPORARY/backup.jarvis"
INCOMPATIBLE="$TEMPORARY/incompatible.jarvis"
EVIDENCE="$TEMPORARY/evidence.json"

cleanup() {
  rm -rf "$TEMPORARY"
}
trap cleanup EXIT INT TERM

cd "$ROOT"
node --input-type=module - "$SOURCE_DSH" "$SOURCE_DATA" "$EVIDENCE" <<'NODE'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FileEventLogStore, RetainedEventLog } from './dist/event-log.js'
import { FilePairingStateStore, PairingAuthority, createDeviceIdentity } from './dist/pairing.js'
import { FileSessionStateStore, SessionAuthority } from './dist/sessions.js'

const [dshHome, dataDir, evidencePath] = process.argv.slice(2)
const privateFile = async (path, content) => {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
  await chmod(join(path, '..'), 0o700)
  await writeFile(path, content, { mode: 0o600 })
  await chmod(path, 0o600)
}

await privateFile(join(dshHome, 'sessions', 'qualification', 'session.jsonl.zstd'), 'qualified conversation payload')
await privateFile(join(dshHome, 'storages', 'workspace.json'), '{"workspace":"qualification"}\n')
await privateFile(join(dshHome, 'storages', 'session_projcache.json'), '{"session":"qualification"}\n')
await privateFile(join(dataDir, 'reminders.json'), '[{"id":"qualification-reminder"}]\n')
await privateFile(join(dataDir, 'memory.json'), `${JSON.stringify({
  version: 1,
  items: [{
    id: 'qualification-memory', ownerId: 'local-owner', class: 'profile', content: 'qualification preference',
    sensitivity: 'standard', confidence: 1, source: { kind: 'explicit-user', reference: 'qualification' },
    retention: { kind: 'until-deleted', expiresAt: null }, status: 'confirmed',
    createdAt: '2030-01-01T00:00:00.000Z', updatedAt: '2030-01-01T00:00:00.000Z',
    confirmedAt: '2030-01-01T00:00:00.000Z', supersedesId: null,
  }],
})}\n`)
await privateFile(join(dataDir, 'audit.jsonl'), '{"id":"qualification-audit","phase":"result"}\n')

const pairing = new PairingAuthority(Date.now, 60_000, new FilePairingStateStore(join(dataDir, 'pairing-state.json')))
const pair = nodeId => {
  const identity = createDeviceIdentity()
  const request = pairing.createRequest({ nodeId, publicKey: identity.publicKey, displayName: nodeId, platform: 'macos' })
  return pairing.confirm(request.requestId, request.verificationCode)
}
const firstActive = pair('qualification-active')
const rotatedActive = pairing.rotate(firstActive.nodeId, firstActive.credential)
const revoked = pair('qualification-revoked')
pairing.revoke(revoked.nodeId)

const sessions = new SessionAuthority({ store: new FileSessionStateStore(join(dataDir, 'session-state.json')) })
const firstSession = sessions.issue(firstActive.nodeId)
const activeSession = sessions.refresh(firstSession.refreshToken)
const revokedSession = sessions.issue(revoked.nodeId)
sessions.revokeDevice(revoked.nodeId)

const events = new RetainedEventLog({ store: new FileEventLogStore(join(dataDir, 'event-state.json')) })
const initialCursor = events.currentCursor()
events.publish({ type: 'conversation.status', conversationId: 'qualification-session', running: false })

await privateFile(evidencePath, `${JSON.stringify({
  firstActiveCredential: firstActive.credential,
  rotatedActiveCredential: rotatedActive.credential,
  revokedCredential: revoked.credential,
  activeAccessToken: activeSession.accessToken,
  revokedAccessToken: revokedSession.accessToken,
  initialCursor,
})}\n`)
NODE

node dist/backup-main.js backup \
  --output "$ARCHIVE" \
  --dsh-home "$SOURCE_DSH" \
  --data-dir "$SOURCE_DATA" \
  --runtime-dir "$TEMPORARY/source-runtime" >/dev/null

node --input-type=module - "$ARCHIVE" "$INCOMPATIBLE" <<'NODE'
import { chmod, readFile, writeFile } from 'node:fs/promises'

const [archivePath, incompatiblePath] = process.argv.slice(2)
const archive = JSON.parse(await readFile(archivePath, 'utf8'))
archive.applicationVersion = 'incompatible-version'
await writeFile(incompatiblePath, `${JSON.stringify(archive)}\n`, { mode: 0o600 })
await chmod(incompatiblePath, 0o600)
NODE

mkdir -p "$ROLLBACK_DSH/sessions" "$ROLLBACK_DSH/storages" "$ROLLBACK_DATA"
chmod 700 "$ROLLBACK_DSH/sessions" "$ROLLBACK_DSH/storages" "$ROLLBACK_DATA"
print -r -- '{"sentinel":true}' > "$ROLLBACK_DSH/storages/workspace.json"
print -r -- '[]' > "$ROLLBACK_DATA/reminders.json"
print -r -- '{"sentinel":true}' > "$ROLLBACK_DATA/audit.jsonl"
chmod 600 "$ROLLBACK_DSH/storages/workspace.json" "$ROLLBACK_DATA/reminders.json" "$ROLLBACK_DATA/audit.jsonl"
if node dist/backup-main.js restore \
  --archive "$INCOMPATIBLE" \
  --dsh-home "$ROLLBACK_DSH" \
  --data-dir "$ROLLBACK_DATA" \
  --runtime-dir "$TEMPORARY/rollback-runtime" >/dev/null 2>&1; then
  print -u2 'Incompatible recovery archive was accepted.'
  exit 1
fi
[[ "$(<"$ROLLBACK_DSH/storages/workspace.json")" == '{"sentinel":true}' ]]

node dist/backup-main.js restore \
  --archive "$ARCHIVE" \
  --dsh-home "$RESTORED_DSH" \
  --data-dir "$RESTORED_DATA" \
  --runtime-dir "$TEMPORARY/restored-runtime" >/dev/null

node --input-type=module - "$ARCHIVE" "$RESTORED_DSH" "$RESTORED_DATA" "$EVIDENCE" <<'NODE'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { FileEventLogStore, RetainedEventLog } from './dist/event-log.js'
import { FilePairingStateStore, PairingAuthority } from './dist/pairing.js'
import { FileSessionStateStore, SessionAuthority } from './dist/sessions.js'

const [archivePath, dshHome, dataDir, evidencePath] = process.argv.slice(2)
const archiveText = await readFile(archivePath, 'utf8')
const archive = JSON.parse(archiveText)
const evidence = JSON.parse(await readFile(evidencePath, 'utf8'))
for (const value of Object.values(evidence)) {
  if (typeof value === 'string' && value.length >= 22) assert.equal(archiveText.includes(value), false)
}
for (const file of archive.files) {
  const target = file.path.startsWith('.dsh/')
    ? join(dshHome, file.path.slice('.dsh/'.length))
    : join(dataDir, file.path.slice('data/'.length))
  assert.deepEqual(await readFile(target), Buffer.from(file.contentBase64, 'base64'))
  assert.equal((await stat(target)).mode & 0o077, 0)
}

const pairing = new PairingAuthority(Date.now, 60_000, new FilePairingStateStore(join(dataDir, 'pairing-state.json')))
assert.equal(pairing.authenticate('qualification-active', evidence.firstActiveCredential), false)
assert.equal(pairing.authenticate('qualification-active', evidence.rotatedActiveCredential), true)
assert.equal(pairing.authenticate('qualification-revoked', evidence.revokedCredential), false)

const sessions = new SessionAuthority({ store: new FileSessionStateStore(join(dataDir, 'session-state.json')) })
assert.equal(sessions.authenticate(evidence.activeAccessToken)?.nodeId, 'qualification-active')
assert.equal(sessions.authenticate(evidence.revokedAccessToken), undefined)

const events = new RetainedEventLog({ store: new FileEventLogStore(join(dataDir, 'event-state.json')) })
assert.equal(events.restored, true)
assert.equal(events.replay(evidence.initialCursor).events.length, 1)
NODE

echo 'isolated backup, incompatible-version rollback, credential lifecycle, and empty-root recovery verification passed'
