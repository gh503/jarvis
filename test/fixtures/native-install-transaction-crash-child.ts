import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { describeNativeIntegration, nativeIntegration, renderNativeIntegration, type InstallOptions } from '../../scripts/install-native.ts'
import { withNativeInstallLock } from '../../scripts/native-install-lock.ts'
import { createNativeInstallTransaction } from '../../scripts/native-install-transaction.ts'
import { writeNativeInstallTransactionUnderLock } from '../../scripts/native-install-transaction-store.ts'
import { createNativeInstallTransactionAck, type NativeInstallTransactionAck } from '../../scripts/native-install-transaction-ack.ts'
import { writeNativeInstallTransactionAckUnderLock } from '../../scripts/native-install-transaction-ack-store.ts'
import { createNativeInstallTransactionCompletion } from '../../scripts/native-install-transaction-completion.ts'
import { writeNativeInstallTransactionCompletionUnderLock } from '../../scripts/native-install-transaction-completion-store.ts'
import { inspectNativeInstallTransaction } from '../../scripts/native-install-transaction-inspect.ts'
import { WINDOWS_AUMID } from '../../src/windows-notification.ts'

// No paths, serialized records, exception messages or stack traces cross stdout.
async function main() {
  const [mode, root, platform, stage] = process.argv.slice(2)
  assert.ok(root && isAbsolute(root))
  assert.ok(platform === 'darwin' || platform === 'win32')
  assert.ok(['prepared', 'artifact', 'ack', 'receipt', 'completion'].includes(stage!))
  const integration: InstallOptions = {
    platform, root: join(root, 'package'), home: join(root, 'home'),
    appData: join(root, 'roaming'), localAppData: join(root, 'local'), arch: process.arch,
    runPowerShell() { throw new Error('Shortcut execution forbidden') },
  }
  if (mode === 'inspect') {
    const inspection = await inspectNativeInstallTransaction({ integration })
    for (const action of ['install', 'uninstall']) {
      await assert.rejects(nativeIntegration(integration, [`--${action}`]),
        /^Error: Retained or unsafe native install transaction residue requires review; refusing integration mutation$/)
    }
    const report = JSON.stringify({ inspection, installRefused: true, uninstallRefused: true })
    assert.ok(report.length < 4096 && !report.includes(root))
    process.stdout.write(report + '\n')
    return
  }
  assert.equal(mode, 'interrupt')
  const layout = describeNativeIntegration(integration)
  const plan = renderNativeIntegration(integration, false)
  // Windows layout coverage uses opaque shortcut bytes; it never invokes COM.
  const artifacts = plan.platform === 'darwin' ? plan.artifacts : plan.shortcuts.map(item => ({ path: item.path, bytes: Buffer.from([0, 255, 1, 10]), mode: 0o600 }))
  const receipt = Buffer.from(JSON.stringify({ schemaVersion: 1, platform, root: integration.root, autostart: false,
    ...(platform === 'win32' ? { notificationAumid: WINDOWS_AUMID } : {}),
    files: artifacts.map(item => ({ path: item.path, sha256: createHash('sha256').update(item.bytes).digest('hex') })),
  }, null, 2) + '\n')
  const transaction = createNativeInstallTransaction({ integration, artifacts, receipt, transactionId: randomUUID() })
  async function checkpoint(current: string) {
    if (stage !== current) return
    process.stdout.write('READY\n')
    // An unresolved promise alone does not keep Node alive. Hold the lock scope
    // and an event-loop handle until the parent actually terminates this process.
    await new Promise<never>(() => { setInterval(() => {}, 60_000) })
  }
  async function publish(path: string, bytes: Buffer, mode: number) {
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const file = await fs.open(path, 'wx', mode)
    try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
  }
  await withNativeInstallLock({ controlDirectory: join(dirname(layout.receiptPath), 'native-install-control') }, async lock => {
    await writeNativeInstallTransactionUnderLock({ integration, transaction, lock })
    await checkpoint('prepared')
    const acks: NativeInstallTransactionAck[] = []
    for (const [artifactIndex, artifact] of artifacts.entries()) {
      await publish(artifact.path, artifact.bytes, artifact.mode)
      if (artifactIndex === 0) await checkpoint('artifact')
      const ack = createNativeInstallTransactionAck({ integration, transaction, artifactIndex,
        observation: { bytes: await fs.readFile(artifact.path), identity: await fs.lstat(artifact.path, { bigint: true }) } })
      await writeNativeInstallTransactionAckUnderLock({ integration, transaction, ack, lock })
      acks.push(ack)
    }
    await checkpoint('ack')
    await publish(layout.receiptPath, receipt, 0o600)
    await checkpoint('receipt')
    const completion = createNativeInstallTransactionCompletion({ integration, transaction, acks,
      observation: { bytes: await fs.readFile(layout.receiptPath), identity: await fs.lstat(layout.receiptPath, { bigint: true }) } })
    await writeNativeInstallTransactionCompletionUnderLock({ integration, transaction, acks, completion, lock })
    await checkpoint('completion')
  })
}
void main().catch(() => { process.stderr.write('FIXTURE_FAILED\n'); process.exitCode = 1 })
