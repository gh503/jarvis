import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { DeviceManagementClient } from './device-management.js'

function usage(): string {
  return [
    'Usage:',
    '  npm run devices -- list',
    '  npm run devices -- revoke --id <device-id> [--yes]',
    '',
    'Required environment:',
    '  JARVIS_OWNER_TOKEN   Gateway owner token',
    '',
    'Optional environment:',
    '  JARVIS_GATEWAY_URL   Loopback Gateway origin (default http://127.0.0.1:3090)',
  ].join('\n')
}

async function confirmRevocation(displayName: string, nodeId: string): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('device revocation requires --yes or an interactive terminal')
  const prompt = createInterface({ input: stdin, output: stdout })
  try {
    const answer = (await prompt.question(`Revoke ${displayName} (${nodeId})? Type REVOKE to continue: `)).trim()
    if (answer !== 'REVOKE') throw new Error('device revocation cancelled')
  } finally {
    prompt.close()
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      help: { type: 'boolean', default: false },
      id: { type: 'string' },
      yes: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: true,
  })
  if (values.help) {
    stdout.write(`${usage()}\n`)
    return
  }
  const ownerToken = process.env.JARVIS_OWNER_TOKEN
  if (ownerToken === undefined) throw new Error('JARVIS_OWNER_TOKEN is required')
  const client = new DeviceManagementClient(
    process.env.JARVIS_GATEWAY_URL ?? 'http://127.0.0.1:3090',
    ownerToken,
  )
  const command = positionals[0]
  if (positionals.length !== 1 || (command !== 'list' && command !== 'revoke')) throw new Error(usage())
  if (command === 'list') {
    if (values.id !== undefined || values.yes) throw new Error('list does not accept --id or --yes')
    stdout.write(`${JSON.stringify({ devices: await client.list() })}\n`)
    return
  }
  const nodeId = values.id
  if (nodeId === undefined) throw new Error('revoke requires --id <device-id>')
  const device = (await client.list()).find(item => item.nodeId === nodeId && !item.revoked)
  if (device === undefined) throw new Error('device was not found or was already revoked')
  if (!values.yes) await confirmRevocation(device.displayName, device.nodeId)
  await client.revoke(device.nodeId)
  stdout.write(`${JSON.stringify({ revoked: true, device: {
    nodeId: device.nodeId,
    displayName: device.displayName,
    platform: device.platform,
    generation: device.generation,
  } })}\n`)
}

try {
  await main()
} catch (error) {
  const message = error instanceof Error ? error.message : 'device management failed'
  process.stderr.write(`Device management failed: ${message}\n`)
  process.exitCode = 1
}
