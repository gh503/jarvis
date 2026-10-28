import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readdir, stat, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { capabilities } from '../src/platform.ts'

const doctor = resolve(import.meta.dirname, '../src/doctor.ts')
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-doctor-'))
  const web = join(root, 'web')
  await mkdir(web)
  await writeFile(join(web, 'index.html'), '<!doctype html>')
  const env = { ...process.env, HOME: root, USERPROFILE: root, PATH: '',
    JARVIS_HOST: '127.0.0.1', JARVIS_PORT: '3081', JARVIS_AUTH_TOKEN: '', JARVIS_TLS_CERT: '', JARVIS_TLS_KEY: '',
    JARVIS_DATA_DIR: join(root, 'state'), JARVIS_WEB_DIR: web, JARVIS_OLLAMA_URL: 'http://127.0.0.1:1',
    JARVIS_QUIET_START: '22:00', JARVIS_QUIET_END: '08:00', JARVIS_DAILY_SPEAK_BUDGET: '5',
    JARVIS_PYTHON: join(root, 'missing-python'), JARVIS_FFMPEG: join(root, 'missing-ffmpeg'),
    JARVIS_PIPER_BIN: join(root, 'missing-piper'), JARVIS_PIPER_VOICE: join(root, 'missing-voice'),
    JARVIS_ARECORD: join(root, 'missing-arecord'), JARVIS_ASR_SCRIPT: join(root, 'missing-worker'),
  }
  return { root, env, run: (extra = {}) => spawnSync(process.execPath, ['--experimental-transform-types', doctor], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 15000 }) }
}

test('real doctor CLI is read-only and missing optional providers are nonfatal', async () => {
  const f = await fixture()
  try {
    const result = f.run()
    assert.equal(result.status, 0, result.stderr + result.stdout)
    assert.match(result.stdout, /Core checks passed/)
    assert.match(result.stdout, /configured ffmpeg\s+installed=false/)
    assert.match(result.stdout, /permission=unknown/)
    assert.match(result.stdout, /dependencies\/model runtime readiness=unknown/)
    assert.deepEqual(await readdir(f.root), ['web'])
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('real doctor CLI fails invalid core config and absent web assets without creating state', async () => {
  const f = await fixture()
  try {
    const invalid = f.run({ JARVIS_PORT: 'secret-invalid-port' })
    assert.equal(invalid.status, 1)
    assert.match(invalid.stdout, /invalid configuration/)
    assert.doesNotMatch(invalid.stdout + invalid.stderr, /secret-invalid-port/)
    assert.equal(f.run({ JARVIS_WEB_DIR: join(f.root, 'missing-web') }).status, 1)
    assert.deepEqual(await readdir(f.root), ['web'])
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('real doctor CLI reads custom active remote profile without mutation or secrets', async () => {
  const f = await fixture()
  try {
    await mkdir(f.env.JARVIS_DATA_DIR)
    const file = join(f.env.JARVIS_DATA_DIR, 'model-config.json')
    const text = JSON.stringify({ active: 'custom', profiles: [{ id: 'custom', kind: 'openai', baseUrl: 'https://example.invalid/v1', model: 'remote-model', apiKey: 'never-print-this-secret' }] })
    await writeFile(file, text, { mode: 0o644 })
    const before = await stat(file)
    const result = f.run()
    assert.equal(result.status, 0, result.stderr + result.stdout)
    assert.match(result.stdout, /active=custom; kind=openai/)
    assert.match(result.stdout, /not probed \(remote\/authenticated provider\)/)
    assert.doesNotMatch(result.stdout + result.stderr, /never-print-this-secret|example.invalid|loopback model-list probe failed/)
    assert.equal(await readFile(file, 'utf8'), text)
    assert.equal((await stat(file)).mode, before.mode)
    assert.deepEqual(await readdir(f.env.JARVIS_DATA_DIR), ['model-config.json'])
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('doctor discovers the configured ffmpeg executable instead of a literal PATH command', async () => {
  const f = await fixture()
  try {
    const result = f.run({ JARVIS_FFMPEG: process.execPath })
    assert.equal(result.status, 0, result.stderr + result.stdout)
    assert.match(result.stdout, /configured ffmpeg\s+installed=true/)
    assert.deepEqual(await readdir(f.root), ['web'])
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('capability discovery does not equate prerequisites with voice or capture readiness', () => {
  const caps = capabilities(resolve(import.meta.dirname, '..'))
  assert.equal(caps.localAsr, false)
  assert.equal(caps.localTts, false)
  assert.match(caps.reasons.screenCapture!, /readiness=unknown; permission=unknown/)
  assert.match(caps.reasons.camera!, /readiness=unknown; permission=unknown/)
  assert.match(caps.reasons.localAsr!, /readiness=unknown/)
  assert.match(caps.reasons.scopedFilesystem!, /supported=/)
  assert.match(caps.reasons.notify!, /permission=unknown/)
})
