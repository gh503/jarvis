import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { acquireLifecycleLock } from '../src/runtime-lifecycle.ts'

const cli = resolve(import.meta.dirname, '../src/cli.ts')

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'jarvis cli lifecycle '))
  assert.ok(resolve(root).startsWith(join(tmpdir(), 'jarvis cli lifecycle ')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dataDir = join(root, 'data')
  const env: NodeJS.ProcessEnv = { ...process.env, JARVIS_DATA_DIR: dataDir, JARVIS_AUTH_TOKEN: '' }
  delete env.JARVIS_CONFIG_FILE
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, ['--experimental-transform-types', cli, ...args], {
      env, encoding: 'utf8', timeout: 30_000,
    })
    assert.ifError(result.error)
    assert.equal(result.signal, null, result.stderr)
    return result
  }
  return { root, dataDir, run }
}

function success(result: ReturnType<typeof spawnSync>) {
  assert.equal(result.status, 0, String(result.stderr))
  return JSON.parse(String(result.stdout))
}

test('offline CLI refuses all store commands while runtime owns data, then writes and reads after release', async t => {
  const { root, dataDir, run } = await fixture(t)
  const release = await acquireLifecycleLock(dataDir, 'runtime')
  try {
    const before = (await readdir(dataDir)).sort()
    assert.ok(before.includes('runtime.lock.sqlite'))
    assert.ok(before.every(name => ['runtime.lock.sqlite', 'runtime.lock.sqlite-journal'].includes(name)))
    for (const args of [
      ['memory', 'add', 'blocked memory'],
      ['memory', 'list'],
      ['memory', 'forget', 'missing-id'],
      ['memory', 'consolidate'],
      ['memory', 'export', join(root, 'blocked-export.json')],
      ['reminders', 'list'],
      ['migrate-v1', join(root, 'missing.json')],
    ]) {
      const result = run(...args)
      assert.equal(result.status, 1, result.stderr)
      assert.match(result.stderr, /Stop the Jarvis runtime.*offline CLI/)
      assert.equal(result.stdout, '')
      assert.deepEqual((await readdir(dataDir)).sort(), before)
    }
    assert.deepEqual((await readdir(root)).sort(), ['data'])
  } finally { release() }

  const added = success(run('memory', 'add', 'Available after runtime stops'))
  const listed = success(run('memory', 'list'))
  assert.ok(listed.some((item: { id: string; content: string }) => item.id === added.id && item.content === 'Available after runtime stops'))
  assert.deepEqual(success(run('reminders', 'list')), [])
  const output = join(root, 'explicit export.json')
  const exported = run('memory', 'export', output)
  assert.equal(exported.status, 0, exported.stderr)
  assert.equal(exported.stdout.trim(), output)
  assert.match(await readFile(output, 'utf8'), /Available after runtime stops/)
})

test('offline CLI releases ownership after migration and export failures', async t => {
  const { root, dataDir, run } = await fixture(t)
  const failed = run('migrate-v1', join(root, 'missing.json'))
  assert.equal(failed.status, 1, failed.stderr)
  assert.match(failed.stderr, /ENOENT/)
  const release = await acquireLifecycleLock(dataDir, 'runtime')
  release()
  success(run('memory', 'add', 'Survives a failed migration'))

  const failedExport = run('memory', 'export', join(root, 'missing', 'export.json'))
  assert.equal(failedExport.status, 1, failedExport.stderr)
  assert.match(failedExport.stderr, /ENOENT/)
  const listed = success(run('memory', 'list'))
  assert.ok(listed.some((item: { content: string }) => item.content === 'Survives a failed migration'))
})

test('malformed CLI arguments exit with usage status without creating data', async t => {
  const { root, run } = await fixture(t)
  for (const args of [
    [], ['unknown'], ['memory'], ['memory', 'add'], ['memory', 'add', '  '],
    ['memory', 'forget'], ['memory', 'forget', 'id', 'extra'],
    ['memory', 'consolidate', 'extra'], ['memory', 'export', 'one', 'two'],
    ['reminders'], ['reminders', 'unknown'], ['reminders', 'list', 'extra'],
    ['migrate-v1'], ['migrate-v1', 'one', 'two'],
  ]) {
    const result = run(...args)
    assert.equal(result.status, 2, result.stderr)
    assert.match(result.stderr, /Usage:/)
    assert.equal(result.stdout, '')
    assert.deepEqual(await readdir(root), [])
  }
})
