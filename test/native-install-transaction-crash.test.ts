import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import test from 'node:test'
import { describeNativeIntegration } from '../scripts/install-native.ts'
import { isPublicFile } from '../scripts/packaging.ts'

const fixture = fileURLToPath(new URL('./fixtures/native-install-transaction-crash-child.ts', import.meta.url))
const stages = ['prepared', 'artifact', 'ack', 'receipt', 'completion'] as const
const deadline = 240_000 // Native Windows ACL checks spawn PowerShell; production timeouts stay unchanged.
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

function start(mode: 'interrupt' | 'inspect', root: string, platform: string, stage: string) {
  const child = spawn(process.execPath, ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', fixture, mode, root, platform, stage], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let stdout = '', stderrBytes = 0, failure: Error | undefined
  let readyResolve!: () => void, readyReject!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  void ready.catch(() => {})
  function terminate() {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      try { process.kill(child.pid, 'SIGKILL') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('Child termination failed')
      }
    }
  }
  function fail(message: string) {
    failure ??= new Error(message)
    readyReject(failure)
    terminate()
  }
  child.stdout.on('data', (chunk: Buffer) => {
    if (Buffer.byteLength(stdout) + chunk.length > 4096) { fail('Child stdout exceeded protocol bound'); return }
    stdout += chunk.toString('utf8')
    if (mode === 'interrupt') {
      if (!'READY\n'.startsWith(stdout)) fail('Invalid ready protocol')
      else if (stdout === 'READY\n') readyResolve()
    }
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length
    // Never retain or echo raw stderr, including startup errors with paths.
    fail(stderrBytes > 4096 ? 'Child stderr exceeded protocol bound' : 'Child reported an error')
  })
  const timer = setTimeout(() => fail('Child deadline exceeded'), deadline)
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('error', () => fail('Child could not start'))
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      readyReject(new Error('Child closed before readiness'))
      resolve({ code, signal })
    })
  })
  return { child, ready, closed, terminate, output: () => stdout, check: () => { if (failure) throw failure } }
}

// Permit only SQLite operational changes. Retained records/artifacts keep their
// bytes and identities; directory timestamps and access times are not evidence.
async function snapshot(path: string): Promise<unknown> {
  const stat = await fs.lstat(path, { bigint: true })
  if (stat.isDirectory()) return Promise.all((await fs.readdir(path)).sort()
    .filter(name => !['launcher.lock.sqlite', 'launcher.lock.sqlite-journal', 'launcher.lock.sqlite-wal', 'launcher.lock.sqlite-shm'].includes(name))
    .map(async name => [name, await snapshot(join(path, name))]))
  assert.ok(stat.isFile(), 'Unexpected fixture file type')
  return { bytes: await fs.readFile(path), ino: stat.ino, mode: stat.mode, nlink: stat.nlink, size: stat.size, mtime: stat.mtimeNs, ctime: stat.ctimeNs }
}

for (const platform of ['darwin', 'win32'] as const) {
  for (const stage of platform === 'darwin' ? stages : ['prepared', 'ack'] as const) {
    test(`${platform}: real interruption after ${stage} retains evidence and refuses mutation on restart`, { timeout: 300_000 }, async t => {
      const temporary = await fs.realpath(tmpdir())
      const root = await fs.mkdtemp(join(temporary, 'transaction-crash-'))
      const children: ReturnType<typeof start>[] = []
      t.after(async () => {
        for (const child of children) child.terminate()
        await Promise.all(children.map(child => child.closed))
        // Never remove a fixture while a subprocess can still write to it.
        assert.equal(dirname(root), temporary)
        assert.ok(root.startsWith(join(temporary, 'transaction-crash-')))
        assert.equal(await fs.realpath(root), root)
        await fs.rm(root, { recursive: true, force: true })
      })
      const writer = start('interrupt', root, platform, stage); children.push(writer)
      await writer.ready
      writer.check()
      assert.equal(writer.child.exitCode, null)
      assert.equal(writer.child.signalCode, null)
      assert.ok(writer.child.pid)
      // This is an actual OS termination while the shared SQLite lock is held.
      process.kill(writer.child.pid, 'SIGKILL')
      const exit = await writer.closed
      writer.check()
      assert.equal(writer.output(), 'READY\n')
      if (process.platform !== 'win32') assert.equal(exit.signal, 'SIGKILL')
      else assert.ok(exit.signal === 'SIGKILL' || (exit.code !== null && exit.code !== 0), 'Expected Windows termination')

      const integration = { platform, root: join(root, 'package'), home: join(root, 'home'), appData: join(root, 'roaming'), localAppData: join(root, 'local'), arch: process.arch }
      const layout = describeNativeIntegration(integration)
      const directory = join(dirname(layout.receiptPath), 'native-install-control')
      const prepared = JSON.parse(await fs.readFile(join(directory, 'prepared-transaction.json'), 'utf8'))
      assert.equal(prepared.scope.ownership, false)
      const present = prepared.artifacts.filter((item: { state: string }) => item.state === 'present')
      const acknowledged = ['ack', 'receipt', 'completion'].includes(stage)
      const publishedCount = stage === 'prepared' ? 0 : stage === 'artifact' ? 1 : present.length
      const recordNames = (await fs.readdir(directory)).filter(name => name.startsWith('prepared-')).sort()
      assert.deepEqual(recordNames, ['prepared-transaction.json',
        ...(acknowledged ? present.map((_: unknown, index: number) => `prepared-artifact-${index}.json`) : []),
        ...(stage === 'completion' ? ['prepared-completion.json'] : []),
      ].sort())
      for (const name of recordNames) {
        const record = JSON.parse(await fs.readFile(join(directory, name), 'utf8'))
        assert.equal(record.scope.ownership, false)
      }
      for (const [index, artifact] of prepared.artifacts.entries()) {
        if (index < publishedCount) {
          const bytes = await fs.readFile(artifact.path)
          assert.equal(hash(bytes), artifact.expected.sha256)
          assert.equal(bytes.length, artifact.expected.bytes)
        } else await assert.rejects(fs.lstat(artifact.path), { code: 'ENOENT' })
      }
      if (['receipt', 'completion'].includes(stage)) {
        assert.ok((await fs.readFile(layout.receiptPath)).equals(Buffer.from(prepared.receipt.base64, 'base64')))
      } else await assert.rejects(fs.lstat(layout.receiptPath), { code: 'ENOENT' })
      const before = await snapshot(root)
      const inspector = start('inspect', root, platform, stage); children.push(inspector)
      const inspectedExit = await inspector.closed
      inspector.check()
      assert.deepEqual(inspectedExit, { code: 0, signal: null })
      const output = inspector.output()
      for (const secret of [root, prepared.transactionId, prepared.receipt.sha256, prepared.receipt.base64, 'identity', 'path']) {
        assert.ok(!output.includes(secret), 'Inspector output must remain sanitized')
      }
      assert.ok(output.endsWith('\n') && output.indexOf('\n') === output.length - 1, 'Expected one bounded report')
      const report = JSON.parse(output)
      assert.equal(report.installRefused, true)
      assert.equal(report.uninstallRefused, true)
      const inspection = report.inspection
      assert.equal(inspection.status, acknowledged ? stage === 'ack' ? 'receipt-absent' : 'receipt-present' : 'blocked')
      assert.equal(inspection.declaration, stage === 'completion' ? 'matching' : acknowledged ? 'absent' : 'unavailable')
      const expectedIssues = acknowledged ? [{ reason: 'all-artifacts-match' }] : [
        ...present.map((_: unknown, artifactIndex: number) => ({ reason: 'ack-missing', artifactIndex })),
        ...present.slice(publishedCount).map((_: unknown, index: number) => ({ reason: 'artifact-missing', artifactIndex: index + publishedCount })),
      ]
      assert.deepEqual(inspection.issues, expectedIssues)
      for (const value of Object.values(inspection.scope)) assert.equal(value, false)
      assert.equal(inspection.limitations.sourceWindowsAcl, false)
      assert.ok(isDeepStrictEqual(await snapshot(root), before), 'Restart must retain all non-operational bytes and identities')
    })
  }
}

test('crash harness and child fixture are excluded from packaging', () => {
  assert.equal(isPublicFile('test/native-install-transaction-crash.test.ts'), false)
  assert.equal(isPublicFile('test/fixtures/native-install-transaction-crash-child.ts'), false)
})
