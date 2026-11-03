import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describeNativeIntegration, renderNativeIntegration, type InstallOptions } from '../../scripts/install-native.ts'
import { createNativeInstallTransaction } from '../../scripts/native-install-transaction.ts'
import { writeNativeInstallTransaction } from '../../scripts/native-install-transaction-store.ts'
import { createNativeInstallTransactionAck } from '../../scripts/native-install-transaction-ack.ts'
import { writeNativeInstallTransactionAck } from '../../scripts/native-install-transaction-ack-store.ts'
import { createNativeInstallTransactionCompletion } from '../../scripts/native-install-transaction-completion.ts'
import { writeNativeInstallTransactionCompletion } from '../../scripts/native-install-transaction-completion-store.ts'
import { WINDOWS_AUMID } from '../../src/windows-notification.ts'

export async function completedFixture(root: string, platform: 'darwin' | 'win32') {
  const integration: InstallOptions = { platform, root: join(root, 'package'), home: join(root, 'home'), appData: join(root, 'roaming'), localAppData: join(root, 'local'), arch: process.arch }
  const layout = describeNativeIntegration(integration)
  const directory = join(dirname(layout.receiptPath), 'native-install-control')
  const plan = renderNativeIntegration(integration, false)
  const artifacts = plan.platform === 'darwin' ? plan.artifacts : plan.shortcuts.map(item => ({ path: item.path, bytes: Buffer.from([0, 255, 1, 10]), mode: 0o600 }))
  const receipt = Buffer.from(JSON.stringify({ schemaVersion: 1, platform, root: integration.root, autostart: false, configFile: join(root, 'config'), dataDir: join(root, 'data'), ...(platform === 'win32' ? { notificationAumid: WINDOWS_AUMID } : {}), files: artifacts.map(item => ({ path: item.path, sha256: createHash('sha256').update(item.bytes).digest('hex') })) }, null, 2) + '\n')
  const transactionId = randomUUID()
  const transaction = createNativeInstallTransaction({ integration, artifacts, receipt, transactionId })
  await writeNativeInstallTransaction({ integration, transaction })
  const acks = []
  for (const [artifactIndex, artifact] of artifacts.entries()) {
    await fs.mkdir(dirname(artifact.path), { recursive: true, mode: 0o700 })
    await fs.writeFile(artifact.path, artifact.bytes, { mode: artifact.mode })
    const ack = createNativeInstallTransactionAck({ integration, transaction, artifactIndex, observation: { bytes: artifact.bytes, identity: await fs.lstat(artifact.path, { bigint: true }) } })
    await writeNativeInstallTransactionAck({ integration, transaction, ack })
    acks.push(ack)
  }
  await fs.writeFile(layout.receiptPath, receipt, { mode: 0o600 })
  const completion = createNativeInstallTransactionCompletion({ integration, transaction, acks, observation: { bytes: receipt, identity: await fs.lstat(layout.receiptPath, { bigint: true }) } })
  await writeNativeInstallTransactionCompletion({ integration, transaction, acks, completion })
  return { root, integration, transactionId, transaction, acks, directory, artifacts, receipt, barrier: join(directory, `prepared-uninstalling-${transactionId}`), ...layout }
}
