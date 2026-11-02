import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { ensurePrivateDataDirectory } from '../src/private-directory.ts'
import { acquireLifecycleLock, requestRuntime } from '../src/runtime-lifecycle.ts'

const launcher = fileURLToPath(new URL('../scripts/app.ts', import.meta.url))
function run(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ['--experimental-transform-types', launcher, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, killSignal: 'SIGKILL' })
  let output = ''
  const capture = (data: Buffer) => { output = (output + data.toString()).slice(-64 * 1024) }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => resolve({ code, output }))
  })
}

test('app rejects malformed config flags before lifecycle writes', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'jarvis config flags '))
  const dataDir = join(root, 'must not exist')
  try {
    for (const args of [['--config'], ['--config', 'relative'], ['--config', join(root, 'a'), '--config', join(root, 'b')], [`--config=${join(root, 'a')}`]]) {
      const result = await run(['--stop', ...args], { JARVIS_DATA_DIR: dataDir })
      assert.equal(result.code, 1, result.output)
      assert.match(result.output, /Usage: app.ts/)
      assert.equal(existsSync(dataDir), false)
    }
  } finally {
    assert.equal(root.startsWith(join(await realpath(tmpdir()), 'jarvis config flags ')), true)
    await rm(root, { recursive: true, force: true })
  }
})

test('app external config controls real child startup and stop despite inherited settings', { timeout: 150_000 }, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'jarvis config launch '))
  await ensurePrivateDataDirectory(root)
  const dataDir = join(root, 'selected data')
  const inheritedDir = join(root, 'inherited data')
  const file = join(root, 'selected config.env')
  const probe = createServer()
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as { port: number }).port
  await new Promise<void>(resolve => probe.close(() => resolve()))
  await writeFile(file, `JARVIS_DATA_DIR="${dataDir}"\nJARVIS_HOST=127.0.0.1\nJARVIS_PORT=${port}\nJARVIS_OLLAMA_URL=http://127.0.0.1:1\nJARVIS_PYTHON="${join(root, 'missing python')}"\nJARVIS_PIPER_BIN="${join(root, 'missing piper')}"\n`, { mode: 0o600 })
  const env = { JARVIS_CONFIG_FILE: join(root, 'wrong inherited config'), JARVIS_DATA_DIR: inheritedDir, JARVIS_PORT: 'invalid', JARVIS_TLS_CERT: join(root, 'missing cert') }
  try {
    const started = await run(['--no-open', '--config', file], env)
    assert.equal(started.code, 0, started.output)
    assert.match(started.output, new RegExp(`http://127\\.0\\.0\\.1:${port}/`))
    assert.equal((await requestRuntime(dataDir))?.state, 'ready')
    assert.equal(existsSync(inheritedDir), false)
    const stopped = await run(['--stop', '--config', file], env)
    assert.equal(stopped.code, 0, stopped.output)
    assert.equal(await requestRuntime(dataDir), null)
  } finally {
    if (existsSync(dataDir)) {
      await requestRuntime(dataDir, 'shutdown')
      const release = await acquireLifecycleLock(dataDir, 'runtime', 10_000)
      release()
    }
    assert.equal(root.startsWith(join(await realpath(tmpdir()), 'jarvis config launch ')), true)
    await rm(root, { recursive: true, force: true })
  }
})
