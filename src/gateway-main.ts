import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createJarvisGateway, type GatewayTlsOptions } from './gateway.js'

const ownerToken = process.env.JARVIS_OWNER_TOKEN
if (ownerToken === undefined) throw new Error('JARVIS_OWNER_TOKEN is required')

const configuredPort = process.env.JARVIS_GATEWAY_PORT === undefined ? 3090 : Number(process.env.JARVIS_GATEWAY_PORT)
if (!Number.isInteger(configuredPort) || configuredPort < 0 || configuredPort > 65_535) {
  throw new Error('JARVIS_GATEWAY_PORT must be an integer from 0 to 65535')
}

const statePath = process.env.JARVIS_PAIRING_STATE
  ?? join(process.env.JARVIS_DATA_DIR ?? join(process.cwd(), 'data'), 'pairing-state.json')
const bindHost = process.env.JARVIS_GATEWAY_HOST ?? '127.0.0.1'
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

const gateway = tls === undefined
  ? createJarvisGateway({ ownerToken, pairingStatePath: statePath, bindHost })
  : createJarvisGateway({ ownerToken, pairingStatePath: statePath, bindHost, tls })
const running = await gateway.start(configuredPort)
console.log(`Jarvis Gateway listening on ${running.origin}`)

async function stop(): Promise<void> {
  await gateway.stop()
  process.exit(0)
}

process.once('SIGINT', () => { void stop() })
process.once('SIGTERM', () => { void stop() })
