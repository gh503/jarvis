import { spawn } from 'node:child_process'
import { access, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

export class ProcessError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message)
    this.name = 'ProcessError'
  }
}

export interface RunOptions {
  input?: string | Buffer
  timeoutMs?: number
  cwd?: string
  env?: NodeJS.ProcessEnv
  maxOutputBytes?: number
}

export interface RunResult {
  stdout: string
  stderr: string
  code: number
}

export async function runProcess(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? 60_000
  const maxOutput = options.maxOutputBytes ?? 2_000_000

  return await new Promise<RunResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      if (!settled) {
        settled = true
        reject(new ProcessError(`process timed out after ${timeoutMs}ms`, command, null, stderr))
      }
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < maxOutput) stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < maxOutput) stderr += chunk
    })
    child.on('error', error => {
      clearTimeout(timer)
      if (!settled) {
        settled = true
        reject(new ProcessError(`${command} failed to start: ${error.message}`, command, null, stderr))
      }
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      if (code !== 0) {
        reject(new ProcessError(`${command} exited with ${code}: ${stderr.trim().slice(0, 500)}`, command, code, stderr))
        return
      }
      resolve({ stdout, stderr, code: code ?? 0 })
    })

    if (options.input !== undefined) child.stdin.end(options.input)
    else child.stdin.end()
  })
}

export async function commandExists(command: string): Promise<boolean> {
  if (!command || command.includes('\0')) return false
  const paths = isAbsolute(command) || /[\\/]/.test(command)
    ? [command]
    : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => join(dir.replace(/^"|"$/g, ''), command))
  const extensions = process.platform === 'win32' ? ['', '.exe', '.com'] : ['']
  for (const path of paths) for (const extension of extensions) {
    try {
      const target = `${path}${extension}`
      if (!(await stat(target)).isFile()) continue
      await access(target, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
      return true
    } catch { /* Continue searching executable PATH entries. */ }
  }
  return false
}