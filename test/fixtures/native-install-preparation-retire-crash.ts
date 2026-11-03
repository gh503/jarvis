import fs from 'node:fs/promises'
import { writeSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { basename } from 'node:path'
import { retireNativeInstallPreparation } from '../../scripts/native-install-preparation-retire.ts'

const [stage, encoded] = process.argv.slice(2)
const options = JSON.parse(encoded!) as Parameters<typeof retireNativeInstallPreparation>[0]
const rename = fs.rename
const stop = () => { writeSync(1, 'INTERRUPTING\n'); process.kill(process.pid, 'SIGKILL'); throw new Error('Interruption did not terminate process') }
fs.rename = async (source, destination) => {
  const sourceMove = basename(String(source)) === 'prepared-transaction.json'
  if (sourceMove && stage === 'before-source') stop()
  await rename(source, destination)
  if (sourceMove && stage === 'after-source') stop()
  if (!sourceMove && stage === 'after-commit') stop()
}
syncBuiltinESMExports()
await retireNativeInstallPreparation(options)
throw new Error('Expected interruption was not reached')
