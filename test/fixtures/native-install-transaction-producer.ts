import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describeNativeIntegration, type InstallOptions } from '../../scripts/install-native.ts'

/** Real package validation inputs; only Windows COM generation is mocked locally. */
export async function producerFixture(directory: string, platform: 'darwin' | 'win32') {
  const root = join(directory, 'package')
  const files = []
  for (const path of [`runtime/${platform === 'win32' ? 'node.exe' : 'node'}`, 'scripts/app.ts', 'scripts/install-native.ts', 'src/main.ts']) {
    const bytes = Buffer.from('fixture payload: ' + path)
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), bytes)
    files.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ schemaVersion: 1, platform, arch: process.arch, runtime: { version: 'v24.14.0', platform, arch: process.arch }, files }))
  const integration: InstallOptions = { platform, root, arch: process.arch, home: join(directory, 'home'), appData: join(directory, 'roaming'), localAppData: join(directory, 'local'), runPowerShell: (_script, env) => writeFileSync(env.JARVIS_LINK_PATH!, Buffer.from(JSON.stringify(env)), { mode: 0o600 }) }
  const layout = describeNativeIntegration(integration)
  return { integration, layout, control: join(dirname(layout.receiptPath), 'native-install-control') }
}
