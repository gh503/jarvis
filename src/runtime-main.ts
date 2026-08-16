import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { acquireRuntimeLease } from './runtime-lease.js'

const separator = process.argv.indexOf('--')
const role = process.argv[2]
if (role === undefined || separator !== 3 || process.argv.length < 5) {
  throw new Error('usage: runtime-main <role> -- <command> [arguments...]')
}

const command = process.argv[4] as string
const argumentsValue = process.argv.slice(5)
const runtimeDir = resolve(process.env.JARVIS_RUNTIME_DIR ?? '.jarvis-runtime')
const lease = await acquireRuntimeLease(runtimeDir, role)

try {
  const child = spawn(command, argumentsValue, { env: process.env, stdio: 'inherit' })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => child.kill(signal))
  }
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolveExit(code ?? (signal === null ? 1 : 128)))
  })
  process.exitCode = exitCode
} finally {
  await lease.release()
}
