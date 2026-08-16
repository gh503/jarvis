import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AppRegistry } from '../dist/apps.js'
import { AuditLog } from '../dist/audit.js'

test('loads exact application allowlist', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-apps-'))
  try {
    const path = join(directory, 'apps.json')
    await writeFile(path, JSON.stringify({ notes: { displayName: 'Notes', macOSName: 'Notes' } }))
    const apps = await AppRegistry.load(path)
    assert.deepEqual(apps.keys(), ['notes'])
    assert.equal(apps.resolve('NOTES')?.displayName, 'Notes')
    assert.equal(apps.resolve('terminal'), undefined)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('writes append-only private audit events', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-audit-'))
  try {
    const audit = new AuditLog(directory)
    await audit.initialize()
    await Promise.all([
      audit.append({ tool: 'one', callId: '1', phase: 'policy' }),
      audit.append({ tool: 'two', callId: '2', phase: 'result' }),
    ])
    const lines = (await readFile(audit.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(lines.length, 2)
    assert.equal(lines[0].ownerId, 'local-owner')
    assert.equal((await stat(audit.path)).mode & 0o777, 0o600)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
