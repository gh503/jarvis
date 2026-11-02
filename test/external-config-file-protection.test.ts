import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, linkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalToolSettings } from '../src/local-tools/settings.ts'
import { FileTools } from '../src/local-tools/files.ts'
import { nativeFileDefinitions } from '../src/local-tools/native-file-tools.ts'
import { nativeFilesystemExecutable } from '../src/local-tools/native-filesystem.ts'
import type { ToolDefinition } from '../src/tools.ts'

const sentinel = 'EXTERNAL_CONFIG_VALUE_8462'
const nativePlatform = process.platform === 'win32' ? 'win32' : 'darwin'
async function fixture(t: TestContext, overlap = false, alias = false) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'jarvis-external-files-')))
  const previous = process.env.JARVIS_CONFIG_FILE
  t.after(() => {
    if (previous === undefined) delete process.env.JARVIS_CONFIG_FILE
    else process.env.JARVIS_CONFIG_FILE = previous
    rmSync(base, { recursive: true, force: true })
  })
  const privateDir = join(base, 'personal'), app = join(base, 'app'), output = overlap ? privateDir : join(base, 'output')
  for (const dir of new Set([privateDir, app, output])) mkdirSync(dir)
  const config = join(privateDir, 'settings.env'), other = join(privateDir, 'notes.txt'), publicFile = join(base, 'ordinary.txt')
  writeFileSync(config, sentinel); writeFileSync(other, sentinel); writeFileSync(publicFile, 'public text')
  const lexical = join(base, 'alias')
  if (alias) symlinkSync(privateDir, lexical, process.platform === 'win32' ? 'junction' : 'dir')
  process.env.JARVIS_CONFIG_FILE = alias ? join(lexical, 'settings.env') : config
  const settings = new LocalToolSettings(join(app, 'settings.json'), output)
  await settings.load()
  await settings.update({ expectedRevision: 0, readRoots: [base], ...(process.platform === 'linux' ? { writeRoots: [base] } : {}) })
  const run = (defs: ToolDefinition[], name: string, args: Record<string, unknown>) => defs.find(d => d.name === name)!.execute(args, { signal: t.signal, sessionId: 's', turnId: 't', callId: 'c' })
  // Linux throws authorization failures; native definitions return structured errors.
  const denied = async (defs: ToolDefinition[], name: string, args: Record<string, unknown>, pattern = /Protected|hard links|selection changed|directory changed|unavailable|unsafe/i) => {
    let message: string
    try { const result = await run(defs, name, args); assert.equal(result.isError, true, result.content); message = result.content }
    catch (error) { if (error instanceof assert.AssertionError) throw error; message = String(error) }
    assert.match(message, pattern); assert.ok(!message.includes(sentinel))
  }
  return { base, privateDir, config, other, publicFile, lexical, settings, run, denied }
}

for (const backend of ['linux', 'native'] as const) {
  test(`${backend}: selected arbitrary config and entire parent stay private under outer grants`, async t => {
    if (backend === 'linux' && process.platform !== 'linux') return t.skip('Linux scoped backend')
    if (backend === 'native' && !existsSync(nativeFilesystemExecutable())) {
      assert.notEqual(process.env.JARVIS_NATIVE_HELPER_REQUIRED, '1', 'Native helper required')
      return t.skip('Build native helper before acceptance')
    }
    const f = await fixture(t, false, true)
    let visionCalls = 0
    const tools = new FileTools({ settings: f.settings, localVision: async () => { visionCalls++; return 'image' } })
    const defs = backend === 'linux' ? tools.definitions() : nativeFileDefinitions({ settings: f.settings }, nativePlatform)
    assert.equal(JSON.parse((await f.run(defs, 'file_read', { path: f.publicFile })).content).content, 'public text')
    for (const path of [f.config, f.other, join(f.lexical, 'settings.env')]) await f.denied(defs, 'file_read', { path })
    for (const path of [f.privateDir, f.lexical]) {
      await f.denied(defs, 'file_list', { path, recursive: true })
      await f.denied(defs, 'file_search', { path, query: sentinel, mode: 'contents' })
    }
    const listing = await f.run(defs, 'file_list', { path: f.base, recursive: true, includeHidden: true })
    assert.equal(listing.isError, undefined, listing.content)
    assert.ok(!listing.content.includes('settings.env')); assert.ok(!listing.content.includes('notes.txt'))
    assert.ok(!JSON.parse(listing.content).results.some((r: {path: string}) => r.path === f.privateDir))
    for (const [query, mode] of [[sentinel, 'contents'], ['settings.env', 'name']]) {
      const search = await f.run(defs, 'file_search', { path: f.base, query, mode, includeHidden: true })
      assert.equal(search.isError, undefined, search.content); assert.deepEqual(JSON.parse(search.content).results, [])
    }
    const hard = join(f.base, 'copy.txt'); linkSync(f.config, hard)
    await f.denied(defs, 'file_read', { path: hard }, /hard|link/i)
    if (backend === 'linux') {
      for (const path of [f.config, f.other, join(f.privateDir, 'new.txt')]) {
        await f.denied(defs, 'file_write', { path, content: 'overwrite' })
        await f.denied(defs, 'file_edit', { path, oldString: sentinel, newString: 'overwrite', expectedVersion: 'x' })
        await f.denied(defs, 'artifact_present', { path })
        await f.denied(defs, 'image_inspect', { path, prompt: 'read' })
      }
      assert.equal(visionCalls, 0)
      assert.equal(readFileSync(f.config, 'utf8'), sentinel)
    }
    const hash = defs[0]!.definitionHash
    process.env.JARVIS_CONFIG_FILE = join(f.privateDir, 'notes.txt')
    await f.denied(defs, 'file_read', { path: f.publicFile })
    const fresh = backend === 'linux' ? new FileTools({ settings: f.settings }).definitions() : nativeFileDefinitions({ settings: f.settings }, nativePlatform)
    assert.notEqual(fresh[0]!.definitionHash, hash)
    delete process.env.JARVIS_CONFIG_FILE
    await f.denied(defs, 'file_read', { path: f.config })
  })

  test(`${backend}: external config directory identity is bound and unavailable directories fail closed`, async t => {
    if (backend === 'linux' && process.platform !== 'linux') return t.skip('Linux scoped backend')
    if (backend === 'native' && !existsSync(nativeFilesystemExecutable())) return t.skip('Native helper unavailable')
    const f = await fixture(t)
    const definitions = () => backend === 'linux' ? new FileTools({ settings: f.settings }).definitions() : nativeFileDefinitions({ settings: f.settings }, nativePlatform)
    const defs = definitions()
    renameSync(f.privateDir, join(f.base, 'relocated')); mkdirSync(f.privateDir)
    await f.denied(defs, 'file_read', { path: f.publicFile })
    process.env.JARVIS_CONFIG_FILE = join(f.base, 'missing', 'settings.env')
    await f.denied(definitions(), 'file_read', { path: f.publicFile })
  })
}

test('Linux output exception never overrides external config protection', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t, true)
  const tools = new FileTools({ settings: f.settings }), defs = tools.definitions()
  await f.denied(defs, 'file_read', { path: f.config })
  await f.denied(defs, 'file_write', { path: f.config, content: 'overwrite' })
  await f.denied(defs, 'artifact_create', { name: 'result.txt', content: 'overwrite' })
  assert.throws(() => tools.clearAll(), /Unsafe generated workspace/)
  assert.equal(readFileSync(f.config, 'utf8'), sentinel)
  assert.equal(JSON.parse((await f.run(defs, 'file_read', { path: f.publicFile })).content).content, 'public text')
})
