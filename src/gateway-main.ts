import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { InMemoryDeviceApprovalStore } from './device-approval.js'
import { createJarvisGateway, type GatewayTlsOptions } from './gateway.js'
import { acquireRuntimeLease } from './runtime-lease.js'

const ownerToken = process.env.JARVIS_OWNER_TOKEN
if (ownerToken === undefined) throw new Error('JARVIS_OWNER_TOKEN is required')

const configuredPort = process.env.JARVIS_GATEWAY_PORT === undefined ? 3090 : Number(process.env.JARVIS_GATEWAY_PORT)
if (!Number.isInteger(configuredPort) || configuredPort < 0 || configuredPort > 65_535) {
  throw new Error('JARVIS_GATEWAY_PORT must be an integer from 0 to 65535')
}

const dataPath = process.env.JARVIS_DATA_DIR ?? join(process.cwd(), 'data')
const statePath = process.env.JARVIS_PAIRING_STATE ?? join(dataPath, 'pairing-state.json')
const sessionStatePath = process.env.JARVIS_SESSION_STATE ?? join(dataPath, 'session-state.json')
const eventStatePath = process.env.JARVIS_EVENT_STATE ?? join(dataPath, 'event-state.json')
const runtimeDir = resolve(process.env.JARVIS_RUNTIME_DIR ?? join(process.cwd(), '.jarvis-runtime'))
const bindHost = process.env.JARVIS_GATEWAY_HOST ?? '127.0.0.1'
const harnessOrigin = process.env.JARVIS_HARNESS_URL ?? 'http://127.0.0.1:3080'
const pwaRoot = resolve(process.env.JARVIS_PWA_ROOT ?? join(process.cwd(), 'web'))
const harnessRequestTimeoutMs = process.env.JARVIS_HARNESS_TIMEOUT_MS === undefined
  ? 10_000
  : Number(process.env.JARVIS_HARNESS_TIMEOUT_MS)
if (!Number.isInteger(harnessRequestTimeoutMs) || harnessRequestTimeoutMs < 1) {
  throw new Error('JARVIS_HARNESS_TIMEOUT_MS must be a positive integer')
}
const deviceCommandToken = process.env.JARVIS_DEVICE_COMMAND_TOKEN
const tlsKeyPath = process.env.JARVIS_GATEWAY_TLS_KEY
const tlsCertPath = process.env.JARVIS_GATEWAY_TLS_CERT
if ((tlsKeyPath === undefined) !== (tlsCertPath === undefined)) {
  throw new Error('JARVIS_GATEWAY_TLS_KEY and JARVIS_GATEWAY_TLS_CERT must be configured together')
}

let tls: GatewayTlsOptions | undefined
if (tlsKeyPath !== undefined && tlsCertPath !== undefined) {
  const keyStat = statSync(tlsKeyPath)
  if (!keyStat.isFile() || (keyStat.mode & 0o077) !== 0) {
    throw new Error('JARVIS_GATEWAY_TLS_KEY must be a regular file with mode 0600 or stricter')
  }
  tls = { key: readFileSync(tlsKeyPath), cert: readFileSync(tlsCertPath) }
}

const lease = await acquireRuntimeLease(runtimeDir, 'gateway')
let gateway: ReturnType<typeof createJarvisGateway>

try {
  const gatewayOptions = {
    ownerToken, pairingStatePath: statePath, sessionStatePath, eventStatePath, bindHost, harnessOrigin,
    harnessRequestTimeoutMs, pwaRoot,
    ...(deviceCommandToken === undefined ? {} : {
      deviceCommandToken,
      deviceApprovals: new InMemoryDeviceApprovalStore(),
    }),
  }
  gateway = tls === undefined
    ? createJarvisGateway(gatewayOptions)
    : createJarvisGateway({ ...gatewayOptions, tls })
  const running = await gateway.start(configuredPort)
  console.log(`Jarvis Gateway listening on ${running.origin}`)
} catch (error) {
  await lease.release()
  throw error
}

async function stop(): Promise<void> {
  try {
    await gateway.stop()
  } finally {
    await lease.release()
  }
  process.exit(0)
}

process.once('SIGINT', () => { void stop() })
process.once('SIGTERM', () => { void stop() })
