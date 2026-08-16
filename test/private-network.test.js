import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createJarvisGateway } from '../dist/gateway.js'

const execFileAsync = promisify(execFile)
const ownerToken = 'private-network-test-owner-token'
const scriptPath = join(process.cwd(), 'scripts/check-private-gateway.sh')

async function runDiagnostic(environment) {
  try {
    const result = await execFileAsync(scriptPath, [], { env: { ...process.env, ...environment } })
    return { ok: true, ...result }
  } catch (error) {
    return { ok: false, ...error }
  }
}

async function createGateway() {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-private-network-test-'))
  const service = createJarvisGateway({
    ownerToken,
    pairingStatePath: join(directory, 'pairing.json'),
    sessionStatePath: join(directory, 'sessions.json'),
    eventStatePath: join(directory, 'events.json'),
  })
  const gateway = await service.start()
  return { service, gateway, directory }
}

test('diagnostic accepts a healthy loopback Gateway without credentials', async () => {
  const { service, gateway, directory } = await createGateway()
  try {
    const result = await runDiagnostic({ JARVIS_GATEWAY_URL: gateway.origin, JARVIS_GATEWAY_TIMEOUT_SECONDS: '2' })
    assert.equal(result.ok, true, result.stderr)
    assert.match(result.stdout, /Gateway health passed \(loopback-only, http\)/)
    assert.doesNotMatch(result.stdout + result.stderr, /private-network-test-owner-token/)
  } finally {
    await service.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('diagnostic rejects unsafe URLs and invalid timeouts before connecting', async () => {
  const httpResult = await runDiagnostic({ JARVIS_GATEWAY_URL: 'http://192.168.1.20:3090' })
  assert.equal(httpResult.ok, false)
  assert.match(httpResult.stderr, /must use HTTPS/)
  const credentialResult = await runDiagnostic({ JARVIS_GATEWAY_URL: 'https://user:secret@example.com' })
  assert.equal(credentialResult.ok, false)
  assert.doesNotMatch(credentialResult.stdout + credentialResult.stderr, /secret/)
  const timeoutResult = await runDiagnostic({ JARVIS_GATEWAY_TIMEOUT_SECONDS: '0' })
  assert.equal(timeoutResult.ok, false)
  assert.match(timeoutResult.stderr, /timeout must be an integer/)
})

test('diagnostic fails closed on an unexpected health response', async () => {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ service: 'other-service', status: 'ok', scope: 'loopback-only', transport: 'http' }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  try {
    const result = await runDiagnostic({ JARVIS_GATEWAY_URL: 'http://127.0.0.1:' + address.port })
    assert.equal(result.ok, false)
    assert.match(result.stderr, /does not match/)
    assert.doesNotMatch(result.stdout + result.stderr, /other-service/)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('private-network recovery runbook distinguishes secure failure modes', async () => {
  const runbook = await readFile(join(process.cwd(), 'docs/operations/private-network-recovery.md'), 'utf8')
  assert.match(runbook, /local Wi-Fi/)
  assert.match(runbook, /private overlay/)
  assert.match(runbook, /TLS failure/)
  assert.match(runbook, /Revoked device/)
  assert.match(runbook, /no public-internet fallback/i)
  assert.doesNotMatch(runbook, /JARVIS_OWNER_TOKEN=/)
})
