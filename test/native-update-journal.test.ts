import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readUpdateJournal, writeUpdateJournal } from '../scripts/native-update-journal.ts'
import { ensurePrivateDataDirectory } from '../src/private-directory.ts'

const limit = 64 * 1024
const windows = process.platform === 'win32'

async function fixture(t: TestContext) {
  const parent = await mkdtemp(join(await realpath(tmpdir()), 'jarvis-update-journal-'))
  // parent is the absolute, dedicated directory returned by mkdtemp.
  t.after(() => rm(parent, { recursive: true, force: true }))
  const root = join(parent, 'private')
  await ensurePrivateDataDirectory(root)
  const transaction = join(root, 'transaction')
  await mkdir(transaction, { mode: 0o700 })
  return { root, transaction, journal: join(transaction, 'journal.json') }
}

test('journal writes, replaces and reads real JSON without imposing a schema', async t => {
  const { transaction, journal } = await fixture(t)
  const initial = { phase: 'prepared', version: 'v1', files: ['native'], nested: { ok: true } }
  writeUpdateJournal(transaction, initial)
  assert.deepEqual(readUpdateJournal(transaction), initial)
  assert.deepEqual(JSON.parse(await readFile(journal, 'utf8')), initial)
  writeUpdateJournal(transaction, { ...initial, phase: 'installed' })
  assert.equal((readUpdateJournal(transaction) as typeof initial).phase, 'installed')
  writeUpdateJournal(transaction, null)
  assert.equal(readUpdateJournal(transaction), null)
})

test('missing journal is an explicit error', async t => {
  const { transaction } = await fixture(t)
  assert.throws(() => readUpdateJournal(transaction), /missing.*journal/i)
})

test('journal rejects truncated JSON and invalid UTF-8', async t => {
  const { transaction, journal } = await fixture(t)
  for (const bytes of [Buffer.from('{"phase":"prepared"'), Buffer.from(''), Buffer.from([0x22, 0xc3, 0x28, 0x22])]) {
    await writeFile(journal, bytes)
    assert.throws(() => readUpdateJournal(transaction))
  }
})

test('journal accepts exactly 64 KiB and rejects larger input by bytes', async t => {
  const { transaction, journal } = await fixture(t)
  const boundary = 'é'.repeat((limit - 2) / 2)
  writeUpdateJournal(transaction, boundary)
  assert.equal((await readFile(journal)).length, limit)
  assert.equal(readUpdateJournal(transaction), boundary)
  await writeFile(journal, JSON.stringify(boundary + 'a'))
  assert.throws(() => readUpdateJournal(transaction), /bounded|byte limit/)
})

test('failed oversized or unserializable writes preserve the previous journal', async t => {
  const { transaction, journal } = await fixture(t)
  const original = { phase: 'prepared', version: 'previous' }
  writeUpdateJournal(transaction, original)
  const before = await readFile(journal)
  const circular: { self?: unknown } = {}
  circular.self = circular
  for (const value of ['é'.repeat(limit / 2), undefined, circular]) {
    assert.throws(() => writeUpdateJournal(transaction, value))
    assert.deepEqual(await readFile(journal), before)
    assert.deepEqual(readUpdateJournal(transaction), original)
    assert.deepEqual(await readdir(transaction), ['journal.json'])
  }
})

test('journal rejects file symlinks without changing their target', async t => {
  const { root, transaction, journal } = await fixture(t)
  const target = join(root, 'target.json')
  await writeFile(target, '{"phase":"untouched"}')
  try {
    await symlink(target, journal, 'file')
  } catch (error) {
    if (windows && (error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('Windows file symlink privilege unavailable')
      return
    }
    throw error
  }
  assert.throws(() => readUpdateJournal(transaction), /symlink/i)
  assert.equal(await readFile(target, 'utf8'), '{"phase":"untouched"}')
})

test('journal rejects directory links including Windows junctions', async t => {
  const { root, transaction, journal } = await fixture(t)
  const target = join(root, 'target-directory')
  await mkdir(target)
  await symlink(target, journal, windows ? 'junction' : 'dir')
  assert.throws(() => readUpdateJournal(transaction), /symlink/i)
  assert.deepEqual(await readdir(target), [])
})

test('journal rejects hardlinks without changing their target', async t => {
  const { root, transaction, journal } = await fixture(t)
  const target = join(root, 'target.json')
  await writeFile(target, '{"phase":"untouched"}')
  await link(target, journal)
  assert.throws(() => readUpdateJournal(transaction), /regular|unlinked|bounded/)
  assert.equal(await readFile(target, 'utf8'), '{"phase":"untouched"}')
})
