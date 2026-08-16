import { createJarvisGateway } from './gateway.js'

const ownerToken = process.env.JARVIS_OWNER_TOKEN
if (ownerToken === undefined) throw new Error('JARVIS_OWNER_TOKEN is required')

const configuredPort = process.env.JARVIS_GATEWAY_PORT === undefined ? 3090 : Number(process.env.JARVIS_GATEWAY_PORT)
if (!Number.isInteger(configuredPort) || configuredPort < 0 || configuredPort > 65_535) {
  throw new Error('JARVIS_GATEWAY_PORT must be an integer from 0 to 65535')
}

const gateway = createJarvisGateway({ ownerToken })
const running = await gateway.start(configuredPort)
console.log(`Jarvis Gateway listening on 127.0.0.1:${running.port}`)

async function stop(): Promise<void> {
  await gateway.stop()
  process.exit(0)
}

process.once('SIGINT', () => { void stop() })
process.once('SIGTERM', () => { void stop() })
