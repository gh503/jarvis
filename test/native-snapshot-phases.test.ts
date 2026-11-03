import assert from 'node:assert/strict'
import childProcess, { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { win32 } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { decoratePermissionScript, installPermissionPhaseProbe, parsePermissionPhases, sanitizePermissionPhases } from './fixtures/native-snapshot-phases.ts'

// JavaScript template literals normalize CRLF even under a Windows checkout.
const source = readFileSync(new URL('../scripts/native-integration-snapshot.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const script = /const WINDOWS_PRIVATE = String.raw`([^`]+)`/.exec(source)![1]!
const epoch = 1_800_000_000_000
const secret = 'SECRET C:\\Users\\private SDDL=D:PAI https://private.invalid'
const marker = (phase: string, ms = 10) => `JARVIS_PHASE_V1|${phase}|${epoch + ms}\n`

test('probe pins current production script and leaves ACL policy and deadline untouched', () => {
  const decorated = decoratePermissionScript(script)
  assert.ok(decorated)
  for (const phase of ['entered', 'json-start', 'json-done', 'ancestor-start', 'ancestor-done', 'acl-start', 'acl-done', 'complete']) assert.ok(decorated.includes(`Write-JarvisPhase '${phase}'`))
  for (const line of script.split('\n').filter(line => /GetAccessControl|GetOwner|GetAccessRules|throw|trap/.test(line))) assert.ok(decorated.includes(line))
  assert.ok(source.includes('timeout: 10_000, maxBuffer: 16 * 1024'))
  assert.equal(decoratePermissionScript(script + '\n'), undefined)
  assert.equal(decoratePermissionScript(secret), undefined)
})

test('phase parser keeps bounded allowlisted timestamps and discards secrets and partial lines', () => {
  const parsed = parsePermissionPhases(secret + '\n' + marker('entered') + marker('acl-start', 22) + marker(secret) + marker('complete').trimEnd(), epoch, 10_001.2)
  assert.deepEqual(parsed, { elapsedMs: 10_001, phases: { entered: 10, 'acl-start': 22 }, truncated: true })
  assert.equal(JSON.stringify(parsed).includes('SECRET'), false)
  assert.deepEqual(parsePermissionPhases(Buffer.from(marker('json-done')), epoch, 30).phases, { 'json-done': 10 })
  assert.deepEqual(parsePermissionPhases(marker('entered', -1) + marker('complete', 120_001) + 'prefix' + marker('acl-start') + marker('acl-done').replace('\n', secret + '\n'), epoch, 30).phases, {})
  assert.equal(parsePermissionPhases(marker('entered').repeat(1000), epoch, 30).truncated, true)
  assert.deepEqual(parsePermissionPhases(secret.repeat(10000) + '\n' + marker('entered'), epoch, 30).phases, {})
  assert.deepEqual(parsePermissionPhases(undefined, epoch, 30).phases, {})
  assert.deepEqual(sanitizePermissionPhases({ elapsedMs: 10, truncated: false, phases: { entered: 2, secret, complete: secret, 'acl-start': Infinity } }), { elapsedMs: 10, truncated: false, phases: { entered: 2 } })
  for (const value of [null, secret, {}, { elapsedMs: -1, truncated: false, phases: {} }]) assert.equal(sanitizePermissionPhases(value), undefined)
  const hostile = () => { throw new Error('Accessor must not run') }
  assert.equal(sanitizePermissionPhases(Object.defineProperty({}, 'elapsedMs', { get: hostile })), undefined)
  assert.equal(sanitizePermissionPhases(new Proxy({}, { getOwnPropertyDescriptor: hostile })), undefined)
  assert.equal(sanitizePermissionPhases({ elapsedMs: 10, truncated: false, phases: new Proxy({}, { getOwnPropertyDescriptor: hostile }) }), undefined)
  const full = parsePermissionPhases(['entered', 'json-start', 'json-done', 'ancestor-start', 'ancestor-done', 'acl-start', 'acl-done', 'complete'].map(p => marker(p, 120000)).join(''), epoch, 120000)
  assert.ok(Buffer.byteLength(JSON.stringify({ ok: false, kind: 'terminated', code: 'ETIMEDOUT', killed: true, signal: 'SIGTERM', stage: 'integration-permission-check', permissionPhases: full })) <= 512)
})

test('native Windows PowerShell flushes the decorated phase protocol', { skip: process.platform !== 'win32' }, async () => {
  const probe = installPermissionPhaseProbe()
  try {
    const file = win32.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
    // Empty inventory exercises startup/parsing without exposing a user path.
    const options = { env: { ...process.env, JARVIS_INTEGRATION_PATHS: '[]' }, timeout: 10000, maxBuffer: 16384, windowsHide: true, shell: false }
    const result = await new Promise<{ failed: boolean; stderrEmpty: boolean }>(resolve => {
      execFile(file, args, options, (error, _stdout, stderr) => resolve({ failed: Boolean(error), stderrEmpty: stderr === '' }))
    })
    assert.deepEqual(result, { failed: false, stderrEmpty: true })
    for (const phase of ['entered', 'json-start', 'json-done', 'complete'] as const) assert.ok(probe.latest()?.phases[phase] !== undefined, `Missing fixed phase ${phase}`)
  } finally { probe.restore() }
})

test('late callbacks cannot overwrite evidence from a newer subprocess', () => {
  const original = childProcess.execFile
  const callbacks: Array<(error: unknown, stdout: string, stderr: string) => void> = []
  childProcess.execFile = ((...args: unknown[]) => {
    callbacks.push(args[3] as typeof callbacks[number])
    return {} as childProcess.ChildProcess
  }) as typeof childProcess.execFile
  syncBuiltinESMExports()
  const probe = installPermissionPhaseProbe()
  let completed = 0
  try {
    const file = win32.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
    const options = { env: { SystemRoot: 'C:\\Windows', JARVIS_INTEGRATION_PATHS: '[]' }, timeout: 10000, maxBuffer: 16384, windowsHide: true, shell: false }
    execFile(file, args, options, () => { completed++ })
    execFile(file, args, options, () => { completed++ })
    callbacks[1]!(null, `JARVIS_PHASE_V1|complete|${Date.now()}\n`, '')
    const newer = probe.latest()
    assert.ok(newer?.phases.complete !== undefined)
    callbacks[0]!(null, `JARVIS_PHASE_V1|entered|${Date.now()}\n`, '')
    assert.equal(probe.latest(), newer)
    assert.equal(completed, 2)
    execFile(file, args, options, () => { completed++ })
    probe.restore()
    assert.equal(probe.latest(), undefined)
    callbacks[2]!(null, `JARVIS_PHASE_V1|complete|${Date.now()}\n`, '')
    assert.equal(probe.latest(), undefined, 'retired probe cannot be repopulated by a pending callback')
    assert.equal(completed, 3)
  } finally {
    probe.restore()
    childProcess.execFile = original
    syncBuiltinESMExports()
  }
})

test('interception preserves native callbacks and return value, ignores unrelated calls, restores ESM export', async () => {
  const original = childProcess.execFile
  const sentinel = {} as childProcess.ChildProcess
  const calls: unknown[][] = []
  const nativeError = Object.assign(new Error(secret), { code: null, killed: true, signal: 'SIGTERM' })
  const fake = ((...args: unknown[]) => {
    calls.push(args)
    const callback = args[3]
    if (typeof callback === 'function') callback(nativeError, `JARVIS_PHASE_V1|entered|${Date.now()}\n${secret}`, secret)
    return sentinel
  }) as typeof childProcess.execFile
  childProcess.execFile = fake
  syncBuiltinESMExports()
  const probe = installPermissionPhaseProbe()
  try {
    const file = win32.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
    const options = { env: { SystemRoot: 'C:\\Windows', JARVIS_INTEGRATION_PATHS: JSON.stringify([secret]) }, timeout: 10000, maxBuffer: 16384, windowsHide: true, shell: false }
    let seen = false
    const returned = execFile(file, args, options, (error, stdout, stderr) => {
      seen = true
      assert.equal(error, nativeError)
      assert.equal(stdout.includes(secret), true)
      assert.equal(stderr, secret)
    })
    assert.equal(returned, sentinel)
    assert.equal(seen, true)
    assert.equal(calls[0]![2], options)
    assert.notEqual((calls[0]![1] as string[])[4], args[4])
    assert.ok(probe.latest()?.phases.entered !== undefined)
    assert.equal(JSON.stringify(probe.latest()).includes('SECRET'), false)
    await assert.rejects(promisify(execFile)(file, args, options), error => error === nativeError)
    const unrelated: unknown[][] = [
      ['other.exe', args, options], [file, [...args.slice(0, 4), Buffer.from(script + '\n', 'utf16le').toString('base64')], options],
      [file, args, { ...options, timeout: 20000 }], [file, args, { ...options, shell: true }], [file, args, { ...options, env: {} }],
    ]
    for (const call of unrelated) {
      execFile(file, args, options, () => {})
      assert.ok(probe.latest())
      const callback = () => {}
      Reflect.apply(execFile, childProcess, [...call, callback])
      const actual = calls.at(-1)!
      assert.equal(actual[1], call[1])
      assert.equal(actual[3], callback)
      assert.equal(probe.latest(), undefined, 'unmatched calls cannot retain previous permission evidence')
    }
    probe.restore()
    assert.equal(execFile, fake)
  } finally {
    probe.restore()
    childProcess.execFile = original
    syncBuiltinESMExports()
  }
})
