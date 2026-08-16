import { spawn } from 'node:child_process'

const SECURITY_COMMAND = '/usr/bin/security'
const NOT_FOUND_EXIT_CODE = 44

export interface SecurityCommandResult {
  exitCode: number
  stdout: string
}

export type SecurityCommandRunner = (
  argumentsValue: readonly string[],
  stdin?: string,
) => Promise<SecurityCommandResult>

function runSecurityCommand(
  argumentsValue: readonly string[],
  stdin = '',
): Promise<SecurityCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(SECURITY_COMMAND, [...argumentsValue], {
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.once('error', reject)
    child.once('close', exitCode => resolve({ exitCode: exitCode ?? 1, stdout }))
    child.stdin.end(stdin)
  })
}

function validateAccount(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new TypeError('nodeId must contain only letters, numbers, dot, underscore, or hyphen')
  }
  return value
}

function validateCredential(value: string): string {
  if (value.length < 16 || value.length > 4096 || /[\r\n]/.test(value)) {
    throw new TypeError('credential must be 16 to 4096 characters without line breaks')
  }
  return value
}

export class KeychainCredentialStore {
  constructor(
    private readonly service = 'ai.jarvis.node',
    private readonly run: SecurityCommandRunner = runSecurityCommand,
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(service)) {
      throw new TypeError('keychain service contains unsupported characters')
    }
  }

  async read(nodeId: string): Promise<string | undefined> {
    const account = validateAccount(nodeId)
    const result = await this.run([
      'find-generic-password',
      '-a', account,
      '-s', this.service,
      '-w',
    ])
    if (result.exitCode === NOT_FOUND_EXIT_CODE) return undefined
    if (result.exitCode !== 0) throw new Error('keychain credential read failed')
    return validateCredential(result.stdout.replace(/\r?\n$/, ''))
  }

  async write(nodeId: string, credential: string): Promise<void> {
    const account = validateAccount(nodeId)
    validateCredential(credential)
    const result = await this.run([
      'add-generic-password',
      '-a', account,
      '-s', this.service,
      '-U',
      '-w',
    ], `${credential}\n${credential}\n`)
    if (result.exitCode !== 0) throw new Error('keychain credential write failed')
  }

  async remove(nodeId: string): Promise<boolean> {
    const account = validateAccount(nodeId)
    const result = await this.run([
      'delete-generic-password',
      '-a', account,
      '-s', this.service,
    ])
    if (result.exitCode === NOT_FOUND_EXIT_CODE) return false
    if (result.exitCode !== 0) throw new Error('keychain credential removal failed')
    return true
  }
}
