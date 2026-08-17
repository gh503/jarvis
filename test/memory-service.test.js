import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { MemoryService, MemoryServiceClient } from '../dist/memory-service.js'

const retention = { kind: 'until-deleted', expiresAt: null }
const cli = join(process.cwd(), 'dist', 'memory-main.js')

function runCli(args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => resolve({ code, stdout, stderr }))
    child.stdin.end(input)
  })
}

test('owns memory writes, authenticates commands, and preserves concurrent state across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-memory-service-'))
  const service = new MemoryService(directory)
  try {
    const info = await service.start()
    assert.match(info.url, /^http:\/\/127\.0\.0\.1:/)
    assert.equal((await stat(join(directory, 'memory-service.json'))).mode & 0o777, 0o600)
    const client = await MemoryServiceClient.discover(directory)
    assert.ok(client)

    const items = await Promise.all(Array.from({ length: 20 }, (_, index) => client.propose({
      class: 'profile', content: `Concurrent fact ${index}`, sensitivity: 'standard', confidence: 1,
      source: { kind: 'explicit-user', reference: `test-${index}` }, retention,
    })))
    assert.equal(new Set(items.map(item => item.id)).size, 20)
    assert.equal((await client.list()).length, 20)
    await assert.rejects(new MemoryService(directory).start(), /writer is already active/)

    const unauthorized = await fetch(`${info.url}/v1/memory/commands`, {
      method: 'POST', headers: { authorization: 'Bearer invalid', 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, command: 'list' }),
    })
    assert.equal(unauthorized.status, 401)
    const browser = await fetch(`${info.url}/v1/memory/commands`, {
      method: 'POST', headers: { authorization: `Bearer ${info.token}`, origin: 'http://127.0.0.1' },
      body: JSON.stringify({ version: 1, command: 'list' }),
    })
    assert.equal(browser.status, 404)

    const viaCli = await runCli(['propose', '--class', 'episodic', '--data-dir', directory], 'CLI through service')
    assert.equal(viaCli.code, 0, viaCli.stderr)
    assert.equal((await client.list()).length, 21)
    const audit = await readFile(join(directory, 'memory-audit.jsonl'), 'utf8')
    assert.doesNotMatch(audit, /Concurrent fact|CLI through service/)
    assert.doesNotMatch(audit, new RegExp(info.token))

    await service.stop()
    const restarted = new MemoryService(directory)
    await restarted.start()
    try {
      const restartedClient = await MemoryServiceClient.discover(directory)
      assert.equal((await restartedClient.list()).length, 21)
    } finally {
      await restarted.stop()
    }
  } finally {
    await service.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects malformed commands and fails closed on stale active service discovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-memory-service-invalid-'))
  const service = new MemoryService(directory)
  try {
    const info = await service.start()
    const malformed = await fetch(`${info.url}/v1/memory/commands`, {
      method: 'POST', headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, command: 'delete', id: '../memory' }),
    })
    assert.equal(malformed.status, 400)
    assert.equal((await (await MemoryServiceClient.discover(directory)).list()).length, 0)

    await writeFile(join(directory, 'memory-service.json'), `${JSON.stringify({
      ...info, url: 'http://127.0.0.1:1',
    })}\n`, { mode: 0o600 })
    const unavailable = await runCli(['list', '--data-dir', directory])
    assert.notEqual(unavailable.code, 0)
    assert.match(unavailable.stderr, /active memory service is unavailable/)
    assert.doesNotMatch(unavailable.stderr, new RegExp(info.token))
    assert.equal(JSON.parse(await readFile(join(directory, 'memory.json'), 'utf8')).items.length, 0)
  } finally {
    await service.stop()
    await rm(directory, { recursive: true, force: true })
  }
})
