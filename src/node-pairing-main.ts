import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { KeychainCredentialStore, KeychainDeviceIdentityStore } from './node-credentials.js'
import { NodePairingCoordinator } from './node-pairing.js'

function usage(): string {
  return [
    'Usage: npm run pair:node -- --node-id <id> --display-name <name>',
    '',
    'Required environment:',
    '  JARVIS_OWNER_TOKEN   Gateway owner token',
    '',
    'Optional environment:',
    '  JARVIS_GATEWAY_URL   Loopback Gateway origin (default http://127.0.0.1:3090)',
  ].join('\n')
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      help: { type: 'boolean', default: false },
      'node-id': { type: 'string' },
      'display-name': { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  })
  if (values.help) {
    stdout.write(`${usage()}\n`)
    return
  }
  if (values['node-id'] === undefined || values['display-name'] === undefined) throw new Error(usage())
  const ownerToken = process.env.JARVIS_OWNER_TOKEN
  if (ownerToken === undefined) throw new Error('JARVIS_OWNER_TOKEN is required')
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('pairing confirmation requires an interactive terminal')

  const coordinator = new NodePairingCoordinator(
    process.env.JARVIS_GATEWAY_URL ?? 'http://127.0.0.1:3090',
    ownerToken,
    new KeychainDeviceIdentityStore(),
    new KeychainCredentialStore(),
  )
  const challenge = await coordinator.begin({
    nodeId: values['node-id'],
    displayName: values['display-name'],
  })
  stdout.write([
    '',
    `Device: ${challenge.displayName} (${challenge.nodeId})`,
    `Public key fingerprint: ${challenge.fingerprint.match(/.{1,4}/g)?.join(' ') ?? challenge.fingerprint}`,
    `Verification code: ${challenge.verificationCode}`,
    `Expires at: ${new Date(challenge.expiresAt).toISOString()}`,
    '',
  ].join('\n'))

  const prompt = createInterface({ input: stdin, output: stdout })
  try {
    const enteredCode = (await prompt.question('Re-enter the verification code to confirm this device: ')).trim()
    const paired = await coordinator.confirm(challenge.requestId, enteredCode)
    stdout.write(`Paired ${paired.nodeId} with credential generation ${paired.generation}.\n`)
  } finally {
    prompt.close()
  }
}

try {
  await main()
} catch (error) {
  const message = error instanceof Error ? error.message : 'pairing failed'
  process.stderr.write(`Pairing failed: ${message}\n`)
  process.exitCode = 1
}
