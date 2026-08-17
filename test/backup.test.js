import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createBackup, restoreBackup } from '../dist/backup.js'
import { acquireRuntimeLease } from '../dist/runtime-lease.js'

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

async function privateFile(path, content) {
  await privateDirectory(join(path, '..'))
  await writeFile(path, content, { mode: 0o600 })
  await chmod(path, 0o600)
}

async function seedState(root) {
  const dshHome = join(root, '.dsh')
  const dataDir = join(root, 'data')
  const sessionPath = join(dshHome, 'sessions', 'workspace-one', 'session-one', 'session.jsonl.zstd')
  await privateDirectory(join(dshHome, 'sessions'))
  await privateFile(sessionPath, Buffer.from('one committed conversation'))
  await privateFile(join(dshHome, 'storages', 'workspace.json'), JSON.stringify({ workspace: 'one conversation' }))
  await privateFile(join(dshHome, 'storages', 'session_projcache.json'), JSON.stringify({ session: 'projection' }))
  await privateFile(join(dshHome, 'settings.yaml'), 'settings-canary-must-not-be-backed-up\n')
  await privateFile(join(dshHome, '.credentials.yaml'), 'credential-canary-must-not-be-backed-up\n')
  await privateFile(join(dataDir, 'reminders.json'), `${JSON.stringify([{ id: 'reminder-one', text: 'one reminder' }])}\n`)
  await privateFile(join(dataDir, 'memory.json'), `${JSON.stringify({
    version: 1,
    items: [{
      id: 'memory-one', ownerId: 'local-owner', class: 'profile', content: 'Preferred language is Chinese',
      sensitivity: 'standard', confidence: 1, source: { kind: 'explicit-user', reference: 'message-one' },
      retention: { kind: 'until-deleted', expiresAt: null }, status: 'confirmed',
      createdAt: '2030-01-01T00:00:00.000Z', updatedAt: '2030-01-01T00:00:00.000Z',
      confirmedAt: '2030-01-01T00:00:00.000Z', supersedesId: null,
    }],
  })}\n`)
  await privateFile(join(dataDir, 'audit.jsonl'), '{"id":"audit-one","phase":"policy"}\n{"id":"audit-two","phase":"result"}\n')
  await privateFile(join(root, '.env'), 'DEEPSEEK_API_KEY=environment-canary-must-not-be-backed-up\n')
  return { dshHome, dataDir, sessionPath }
}

test('backs up and restores one conversation, reminder, memory, and audit chain without secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-backup-'))
  try {
    const source = await seedState(join(root, 'source'))
    const archivePath = join(root, 'backup.jarvis')
    const runtimeDir = join(root, 'runtime')
    const backup = await createBackup({ outputPath: archivePath, dshHome: source.dshHome, dataDir: source.dataDir, runtimeDir })
    assert.ok(backup.fileCount >= 5)
    assert.equal((await stat(archivePath)).mode & 0o777, 0o600)
    const archiveText = await readFile(archivePath, 'utf8')
    assert.doesNotMatch(archiveText, /credential-canary|environment-canary|settings-canary|\.credentials\.yaml|settings\.yaml|DEEPSEEK_API_KEY/)

    const restoredDsh = join(root, 'restored', '.dsh')
    const restoredData = join(root, 'restored', 'data')
    await privateFile(join(restoredDsh, '.credentials.yaml'), 'destination-credential-remains-local\n')
    await privateFile(join(restoredDsh, 'settings.yaml'), 'destination-settings-remain-local\n')
    await privateFile(join(restoredData, 'service.log'), 'unmanaged log remains local\n')
    const restored = await restoreBackup({ archivePath, dshHome: restoredDsh, dataDir: restoredData, runtimeDir })
    assert.equal(restored.fileCount, backup.fileCount)
    assert.deepEqual(restored.cleanupWarnings, [])
    assert.equal(
      await readFile(join(restoredDsh, 'sessions', 'workspace-one', 'session-one', 'session.jsonl.zstd'), 'utf8'),
      'one committed conversation',
    )
    assert.deepEqual(JSON.parse(await readFile(join(restoredData, 'reminders.json'), 'utf8')), [{ id: 'reminder-one', text: 'one reminder' }])
    assert.deepEqual(
      JSON.parse(await readFile(join(restoredData, 'memory.json'), 'utf8')),
      JSON.parse(await readFile(join(source.dataDir, 'memory.json'), 'utf8')),
    )
    assert.equal((await readFile(join(restoredData, 'audit.jsonl'), 'utf8')).trim().split('\n').length, 2)
    assert.equal(await readFile(join(restoredDsh, '.credentials.yaml'), 'utf8'), 'destination-credential-remains-local\n')
    assert.equal(await readFile(join(restoredDsh, 'settings.yaml'), 'utf8'), 'destination-settings-remain-local\n')
    assert.equal(await readFile(join(restoredData, 'service.log'), 'utf8'), 'unmanaged log remains local\n')
    assert.equal((await stat(join(restoredDsh, 'sessions'))).mode & 0o777, 0o700)
    assert.equal((await stat(join(restoredData, 'reminders.json'))).mode & 0o777, 0o600)
    assert.equal((await stat(join(restoredData, 'memory.json'))).mode & 0o777, 0o600)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('backs up legacy state before the memory store is first initialized', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-backup-legacy-'))
  try {
    const source = await seedState(join(root, 'source'))
    await rm(join(source.dataDir, 'memory.json'))
    const archivePath = join(root, 'legacy-backup.jarvis')
    await createBackup({ outputPath: archivePath, dshHome: source.dshHome, dataDir: source.dataDir, runtimeDir: join(root, 'runtime') })
    const archive = JSON.parse(await readFile(archivePath, 'utf8'))
    assert.equal(archive.files.some(file => file.path === 'data/memory.json'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects corrupted or unsafe archives before replacing existing state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-backup-invalid-'))
  try {
    const source = await seedState(join(root, 'source'))
    const archivePath = join(root, 'backup.jarvis')
    const runtimeDir = join(root, 'runtime')
    await createBackup({ outputPath: archivePath, dshHome: source.dshHome, dataDir: source.dataDir, runtimeDir })

    const targetDsh = join(root, 'target', '.dsh')
    const targetData = join(root, 'target', 'data')
    await privateFile(join(targetDsh, 'sessions', 'old', 'session.jsonl.zstd'), 'existing conversation')
    await privateFile(join(targetDsh, 'storages', 'workspace.json'), '{"existing":true}\n')
    await privateFile(join(targetData, 'reminders.json'), '[{"existing":true}]\n')
    await privateFile(join(targetData, 'audit.jsonl'), '{"existing":true}\n')

    const document = JSON.parse(await readFile(archivePath, 'utf8'))
    const corrupted = structuredClone(document)
    corrupted.files[0].contentBase64 = Buffer.from('tampered').toString('base64')
    const corruptedPath = join(root, 'corrupted.jarvis')
    await privateFile(corruptedPath, `${JSON.stringify(corrupted)}\n`)
    await assert.rejects(
      restoreBackup({ archivePath: corruptedPath, dshHome: targetDsh, dataDir: targetData, runtimeDir }),
      /checksum validation/,
    )
    assert.equal(await readFile(join(targetDsh, 'sessions', 'old', 'session.jsonl.zstd'), 'utf8'), 'existing conversation')
    assert.deepEqual(JSON.parse(await readFile(join(targetData, 'reminders.json'), 'utf8')), [{ existing: true }])

    const unsafeEntry = structuredClone(document)
    unsafeEntry.files[0].mode = 0o644
    const unsafeEntryPath = join(root, 'unsafe-entry.jarvis')
    await privateFile(unsafeEntryPath, `${JSON.stringify(unsafeEntry)}\n`)
    await assert.rejects(
      restoreBackup({ archivePath: unsafeEntryPath, dshHome: targetDsh, dataDir: targetData, runtimeDir }),
      /unsafe permissions/,
    )

    const invalidMemory = structuredClone(document)
    const memoryFile = invalidMemory.files.find(file => file.path === 'data/memory.json')
    const invalidMemoryContent = Buffer.from('{"version":1,"items":[],"unexpected":true}\n')
    memoryFile.size = invalidMemoryContent.byteLength
    memoryFile.sha256 = createHash('sha256').update(invalidMemoryContent).digest('hex')
    memoryFile.contentBase64 = invalidMemoryContent.toString('base64')
    const invalidMemoryPath = join(root, 'invalid-memory.jarvis')
    await privateFile(invalidMemoryPath, `${JSON.stringify(invalidMemory)}\n`)
    await assert.rejects(
      restoreBackup({ archivePath: invalidMemoryPath, dshHome: targetDsh, dataDir: targetData, runtimeDir }),
      /memory document is invalid/,
    )

    await chmod(archivePath, 0o644)
    await assert.rejects(
      restoreBackup({ archivePath, dshHome: targetDsh, dataDir: targetData, runtimeDir }),
      /must be private/,
    )

    await chmod(archivePath, 0o600)
    const auditTarget = join(targetData, 'audit.jsonl')
    const auditSentinel = join(root, 'audit-sentinel.jsonl')
    await privateFile(auditSentinel, '{"sentinel":true}\n')
    await rm(auditTarget)
    await symlink(auditSentinel, auditTarget)
    await assert.rejects(
      restoreBackup({ archivePath, dshHome: targetDsh, dataDir: targetData, runtimeDir }),
      /symbolic link/,
    )
    assert.equal(await readFile(join(targetDsh, 'sessions', 'old', 'session.jsonl.zstd'), 'utf8'), 'existing conversation')
    assert.deepEqual(JSON.parse(await readFile(join(targetData, 'reminders.json'), 'utf8')), [{ existing: true }])
    assert.equal(await readFile(auditSentinel, 'utf8'), '{"sentinel":true}\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('refuses backup while a Jarvis runtime lease is active', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-backup-live-'))
  try {
    const source = await seedState(join(root, 'source'))
    const runtimeDir = join(root, 'runtime')
    const runtime = await acquireRuntimeLease(runtimeDir, 'harness')
    try {
      await assert.rejects(
        createBackup({ outputPath: join(root, 'backup.jarvis'), dshHome: source.dshHome, dataDir: source.dataDir, runtimeDir }),
        /stop Jarvis before backup; active runtime roles: harness/,
      )
    } finally {
      await runtime.release()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
