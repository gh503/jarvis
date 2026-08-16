import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { BrowserPairingApprovalCoordinator } from './pairing-approval.js'

function usage(): string {
  return [
    'Usage: npm run pair:approve -- [--code <six-digit-code>]',
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
      code: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  })
  if (values.help) {
    stdout.write(`${usage()}\n`)
    return
  }
  const ownerToken = process.env.JARVIS_OWNER_TOKEN
  if (ownerToken === undefined) throw new Error('JARVIS_OWNER_TOKEN is required')
  let verificationCode = values.code?.trim()
  if (verificationCode === undefined) {
    if (!stdin.isTTY || !stdout.isTTY) throw new Error('pairing approval requires --code or an interactive terminal')
    const prompt = createInterface({ input: stdin, output: stdout })
    try {
      verificationCode = (await prompt.question('Enter the six-digit code shown on the phone: ')).trim()
    } finally {
      prompt.close()
    }
  }
  const coordinator = new BrowserPairingApprovalCoordinator(
    process.env.JARVIS_GATEWAY_URL ?? 'http://127.0.0.1:3090',
    ownerToken,
  )
  const approved = await coordinator.approve(verificationCode)
  stdout.write(`Approved ${approved.displayName} (${approved.nodeId}) until ${new Date(approved.expiresAt).toISOString()}.\n`)
}

try {
  await main()
} catch (error) {
  const message = error instanceof Error ? error.message : 'pairing approval failed'
  process.stderr.write(`Pairing approval failed: ${message}\n`)
  process.exitCode = 1
}
