import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createConnection, createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { acquireLifecycleLock, acquireRuntimeLifecycle, launcherUrl, requestRuntime } from '../src/runtime-lifecycle.ts'

import { ensurePrivateDataDirectory } from '../src/private-directory.ts'

async function temp(t: test.TestContext) {
  const container = mkdtempSync(join(tmpdir(), 'jarvis lifecycle spaces '))
  t.after(() => rmSync(container, { recursive: true, force: true }))
  const dir = join(container, 'data')
  await ensurePrivateDataDirectory(dir)
  return dir
}
const launcher = fileURLToPath(new URL('../scripts/app.ts', import.meta.url))
function run(args: string[], dataDir: string, extra: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, ['--experimental-transform-types', launcher, ...args], { env: { ...process.env, JARVIS_DATA_DIR: dataDir, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', code => resolve({ code, output }))
  })
}

test('resolved browser URL supports HTTPS, IPv6 and wildcard bind hosts', () => {
  assert.equal(launcherUrl({ host: '::', port: 4443, tlsCert: '/cert with spaces' }), 'https://[::1]:4443/')
  assert.equal(launcherUrl({ host: '0.0.0.0', port: 3010, tlsCert: '' }), 'http://127.0.0.1:3010/')
  assert.equal(launcherUrl({ host: 'localhost', port: 3010, tlsCert: '' }), 'http://localhost:3010/')
})

test('runtime owns directory exclusively; authenticated readiness and shutdown work with spaces', async t => {
  const dir = await temp(t)
  const owner = await acquireRuntimeLifecycle(dir)
  try {
    assert.equal((await requestRuntime(dir))?.state, 'starting')
    await assert.rejects(acquireRuntimeLifecycle(dir), /already owns/)
    let stopped = false
    owner.onShutdown(() => { stopped = true })
    owner.setReady('https://localhost:4443/')
    assert.equal((await requestRuntime(dir))?.url, 'https://localhost:4443/')
    assert.equal((await requestRuntime(dir, 'shutdown'))?.state, 'stopping')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(stopped, true)
  } finally { await owner.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('wrong token and instance cannot invoke shutdown', async t => {
  const dir = await temp(t)
  const owner = await acquireRuntimeLifecycle(dir)
  try {
    let stopped = false
    owner.onShutdown(() => { stopped = true })
    owner.setReady('http://localhost:3000/')
    const descriptor = JSON.parse(readFileSync(join(dir, 'runtime-instance.json'), 'utf8'))
    for (const override of [{ token: '0'.repeat(64) }, { instanceId: '0'.repeat(32) }]) {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection(descriptor.endpoint)
        socket.on('error', reject)
        socket.on('close', () => resolve())
        socket.on('connect', () => socket.write(JSON.stringify({ ...descriptor, ...override, command: 'shutdown' }) + '\n'))
      })
    }
    assert.equal(stopped, false)
  } finally { await owner.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('concurrent launchers serialize and no-open waits for actual readiness', async t => {
  const dir = await temp(t)
  const owner = await acquireRuntimeLifecycle(dir)
  try {
    owner.onShutdown(() => {})
    const first = run(['--no-open'], dir)
    const second = run(['--no-open'], dir)
    const timer = setTimeout(() => owner.setReady('https://localhost:4443/'), 600)
    const results = await Promise.all([first, second])
    clearTimeout(timer)
    for (const result of results) { assert.equal(result.code, 0, result.output); assert.match(result.output, /https:\/\/localhost:4443\//) }
  } finally { await owner.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('legacy stale PID never signals an unrelated process; invalid config fails', async t => {
  const dir = await temp(t)
  try {
    writeFileSync(join(dir, 'app.pid'), String(process.pid))
    const result = await run(['--stop'], dir)
    assert.equal(result.code, 0, result.output)
    assert.equal(readFileSync(join(dir, 'app.pid'), 'utf8'), String(process.pid))
    const invalid = await run(['--no-open'], dir, { JARVIS_PORT: 'invalid' })
    assert.equal(invalid.code, 1)
    assert.match(invalid.output, /JARVIS_PORT/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('real launcher starts without optional tools, reports readiness, and stops over IPC', { timeout: 60_000 }, async t => {
  const dir = await temp(t)
  const probe = createServer()
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as { port: number }).port
  await new Promise<void>(resolve => probe.close(() => resolve()))
  const env = { JARVIS_HOST: '127.0.0.1', JARVIS_PORT: String(port), JARVIS_TLS_CERT: '', JARVIS_TLS_KEY: '', JARVIS_OLLAMA_URL: 'http://127.0.0.1:1', JARVIS_PYTHON: join(dir, 'missing python'), JARVIS_PIPER_BIN: join(dir, 'missing piper'), JARVIS_ASR_MODEL: join(dir, 'missing model') }
  try {
    const results = await Promise.all([run(['--no-open'], dir, env), run(['--no-open'], dir, env)])
    for (const result of results) assert.equal(result.code, 0, result.output)
    assert.equal((await requestRuntime(dir))?.state, 'ready')
    const stopped = await run(['--stop'], dir, env)
    assert.equal(stopped.code, 0, stopped.output)
    assert.equal(await requestRuntime(dir), null)
  } finally {
    await requestRuntime(dir, 'shutdown')
    const release = await acquireLifecycleLock(dir, 'runtime', 10_000)
    release()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('startup failure on occupied HTTP port is surfaced, never accepted as readiness', { timeout: 60_000 }, async t => {
  const dir = await temp(t)
  const unrelated = createServer(socket => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK'))
  await new Promise<void>(resolve => unrelated.listen(0, '127.0.0.1', resolve))
  const port = (unrelated.address() as { port: number }).port
  try {
    const result = await run(['--no-open'], dir, { JARVIS_HOST: '127.0.0.1', JARVIS_PORT: String(port), JARVIS_TLS_CERT: '', JARVIS_TLS_KEY: '', JARVIS_OLLAMA_URL: 'http://127.0.0.1:1', JARVIS_PYTHON: join(dir, 'missing python'), JARVIS_PIPER_BIN: join(dir, 'missing piper') })
    assert.equal(result.code, 1, result.output)
    assert.match(result.output, /exited before readiness/)
    const release = await acquireLifecycleLock(dir, 'runtime')
    release()
  } finally {
    await new Promise<void>(resolve => unrelated.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runtime crash releases SQLite ownership without stale PID cleanup', async t => {
  const dir = await temp(t)
  const moduleUrl = new URL('../src/runtime-lifecycle.ts', import.meta.url).href
  const child = spawn(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', `import { acquireRuntimeLifecycle } from ${JSON.stringify(moduleUrl)}; await acquireRuntimeLifecycle(process.argv[1]); console.log('locked');`, dir], { stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject); child.once('exit', () => reject(new Error('fixture exited early'))) })
    await assert.rejects(acquireLifecycleLock(dir, 'runtime'), /already owns/)
    const exited = new Promise(resolve => child.once('exit', resolve))
    child.kill('SIGKILL') // Only the child we created, never a PID from disk.
    await exited
    const next = await acquireRuntimeLifecycle(dir)
    await next.close()
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); rmSync(dir, { recursive: true, force: true }) }
})
