import fs from 'node:fs/promises'
import { writeSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { basename } from 'node:path'
import { uninstallCompletedNativeInstallTransaction } from '../../scripts/native-install-completed-uninstall.ts'

const [stage, encoded] = process.argv.slice(2)
const options = JSON.parse(encoded!) as Parameters<typeof uninstallCompletedNativeInstallTransaction>[0]
const stop = () => { writeSync(1, 'INTERRUPTING\n'); process.kill(process.pid, 'SIGKILL'); throw new Error('Interruption did not terminate process') }
const unlink = fs.unlink
fs.unlink = async path => {
  await unlink(path)
  if (stage === 'artifact' && basename(String(path)) !== 'native-install.json') stop()
  if (stage === 'receipt' && basename(String(path)) === 'native-install.json') stop()
}
const rename = fs.rename
fs.rename = async (source, destination) => {
  await rename(source, destination)
  if (stage === 'archive-move' && basename(String(source)) === 'prepared-completion.json') stop()
  if (stage === 'commit' && basename(String(source)).startsWith('prepared-uninstalling-')) stop()
}
syncBuiltinESMExports()
await uninstallCompletedNativeInstallTransaction(options)
throw new Error('Expected interruption was not reached')
