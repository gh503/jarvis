import { spawn } from 'node:child_process'
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import { createDeviceIdentity, type DeviceIdentity } from './pairing.js'

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
  if (value.length < 16 || value.length > 127 || /[\r\n]/.test(value)) {
    throw new TypeError('credential must be 16 to 127 characters without line breaks')
  }
  return value
}

function decodeBase64Url(value: unknown, field: string): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{40,256}$/.test(value)) {
    throw new TypeError(`stored device ${field} is invalid`)
  }
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.toString('base64url') !== value) throw new TypeError(`stored device ${field} is invalid`)
  return decoded
}

function identityFromPrivateKey(value: unknown): DeviceIdentity {
  const privateKey = decodeBase64Url(value, 'private key')
  try {
    const privateKeyObject = createPrivateKey({ key: privateKey, format: 'der', type: 'pkcs8' })
    if (privateKeyObject.asymmetricKeyType !== 'ed25519') throw new Error('unsupported key type')
    const derivedPublicKey = createPublicKey(privateKeyObject).export({ format: 'der', type: 'spki' })
    return {
      publicKey: Buffer.from(derivedPublicKey).toString('base64url'),
      privateKey: value as string,
      fingerprint: createHash('sha256').update(derivedPublicKey).digest('hex'),
    }
  } catch {
    throw new TypeError('stored device identity failed cryptographic validation')
  }
}

function validateDeviceIdentity(identity: DeviceIdentity): DeviceIdentity {
  const derived = identityFromPrivateKey(identity.privateKey)
  if (derived.publicKey !== identity.publicKey || derived.fingerprint !== identity.fingerprint) {
    throw new TypeError('device identity failed cryptographic validation')
  }
  return derived
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

export class KeychainDeviceIdentityStore {
  constructor(
    private readonly service = 'ai.jarvis.node.identity',
    private readonly run: SecurityCommandRunner = runSecurityCommand,
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(service)) {
      throw new TypeError('keychain service contains unsupported characters')
    }
  }

  async read(nodeId: string): Promise<DeviceIdentity | undefined> {
    const account = validateAccount(nodeId)
    const result = await this.run([
      'find-generic-password',
      '-a', account,
      '-s', this.service,
      '-w',
    ])
    if (result.exitCode === NOT_FOUND_EXIT_CODE) return undefined
    if (result.exitCode !== 0) throw new Error('keychain device identity read failed')
    try {
      return identityFromPrivateKey(result.stdout.replace(/\r?\n$/, ''))
    } catch {
      throw new Error('keychain device identity is invalid')
    }
  }

  async write(nodeId: string, identity: DeviceIdentity): Promise<void> {
    const account = validateAccount(nodeId)
    const secret = validateDeviceIdentity(identity).privateKey
    if (secret.length > 127) throw new Error('device private key exceeds the macOS Keychain input limit')
    const result = await this.run([
      'add-generic-password',
      '-a', account,
      '-s', this.service,
      '-w',
    ], `${secret}\n${secret}\n`)
    if (result.exitCode !== 0) throw new Error('keychain device identity write failed')
  }

  async loadOrCreate(nodeId: string): Promise<DeviceIdentity> {
    const existing = await this.read(nodeId)
    if (existing !== undefined) return existing
    const identity = createDeviceIdentity()
    try {
      await this.write(nodeId, identity)
      return identity
    } catch {
      const concurrentlyCreated = await this.read(nodeId)
      if (concurrentlyCreated !== undefined) return concurrentlyCreated
      throw new Error('keychain device identity creation failed')
    }
  }

  async remove(nodeId: string): Promise<boolean> {
    const account = validateAccount(nodeId)
    const result = await this.run([
      'delete-generic-password',
      '-a', account,
      '-s', this.service,
    ])
    if (result.exitCode === NOT_FOUND_EXIT_CODE) return false
    if (result.exitCode !== 0) throw new Error('keychain device identity removal failed')
    return true
  }
}
