import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { nativeIntegration, describeNativeIntegration, type InstallOptions } from '../../scripts/install-native.ts'
import { inspectNativeInstallTransaction } from '../../scripts/native-install-transaction-inspect.ts'
import { producerFixture } from './native-install-transaction-producer.ts'
const [mode, directory, platform, phase] = process.argv.slice(2)
assert.ok(directory && (platform === 'darwin' || platform === 'win32'))
if (mode === 'inspect') {
  const integration: InstallOptions = { platform, root: join(directory, 'package'), home: join(directory, 'home'), appData: join(directory, 'roaming'), localAppData: join(directory, 'local'), arch: process.arch }
  console.log(JSON.stringify(await inspectNativeInstallTransaction({ integration })))
} else {
  const f = await producerFixture(directory, platform)
  const target = phase === 'prepared' ? join(f.control, 'prepared-transaction.json') : phase === 'artifact' ? f.layout.artifactPaths[0]! : phase === 'receipt' ? f.layout.receiptPath : join(f.control, 'prepared-completion.json')
  const original = fs.open
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args)
    if (String(args[0]) === target && (args[1] === 'wx' || (typeof args[1] === 'number' && (args[1] & constants.O_CREAT)))) {
      const close = handle.close.bind(handle)
      handle.close = async () => {
        await close()
        process.stdout.write('READY\n')
        await new Promise<never>(() => { setInterval(() => {}, 60_000) })
      }
    }
    return handle
  }) as typeof fs.open
  syncBuiltinESMExports()
  await nativeIntegration(f.integration, ['--install-transaction'])
  throw new Error('checkpoint not reached')
}
