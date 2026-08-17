import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { InMemoryDeviceApprovalStore, type DeviceApprovalExecution } from './device-approval.js'
import { createJarvisGateway, type GatewayTlsOptions } from './gateway.js'
import { HomeAssistantAdapter } from './home-assistant.js'
import { createHomeAssistantSocketFactory, readHomeAssistantRuntimeConfig } from './home-assistant-runtime.js'
import { MqttDeviceAdapter } from './device-mqtt.js'
import { createMqttDeviceTransport, readMqttRuntimeConfig } from './mqtt-runtime.js'
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
const homeAssistantConfig = readHomeAssistantRuntimeConfig()
const mqttConfig = readMqttRuntimeConfig()
const mqttDeviceId = process.env.JARVIS_MQTT_DEVICE_ID
if (mqttConfig === undefined && mqttDeviceId !== undefined) throw new Error('JARVIS_MQTT_URL is required when JARVIS_MQTT_DEVICE_ID is configured')
if (mqttConfig !== undefined && (mqttDeviceId === undefined || mqttDeviceId.length === 0)) {
  throw new Error('JARVIS_MQTT_DEVICE_ID is required when MQTT is configured')
}
if (mqttConfig !== undefined && deviceCommandToken === undefined) {
  throw new Error('JARVIS_DEVICE_COMMAND_TOKEN is required when MQTT is configured')
}
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

const homeAssistant = homeAssistantConfig === undefined ? undefined : new HomeAssistantAdapter({
  url: homeAssistantConfig.url,
  accessToken: homeAssistantConfig.accessToken,
  socketFactory: createHomeAssistantSocketFactory(),
  onSnapshot: () => {},
  onState: () => {},
  onUnavailable: () => {},
})
const homeAssistantExecutionHandler = homeAssistant === undefined || homeAssistantConfig === undefined
  ? undefined
  : (execution: DeviceApprovalExecution) => {
      void homeAssistant.callApprovedService({ ...execution.command, timeoutMs: homeAssistantConfig.commandTimeoutMs }, execution.authorization)
    }
const deviceApprovals = deviceCommandToken === undefined
  ? undefined
  : new InMemoryDeviceApprovalStore(undefined, homeAssistantExecutionHandler)
const deviceApprovalOptions = deviceApprovals === undefined ? {} : { deviceApprovals }
const mqttDevice = mqttConfig === undefined || mqttDeviceId === undefined ? undefined : new MqttDeviceAdapter({
  deviceId: mqttDeviceId,
  transport: createMqttDeviceTransport(mqttConfig),
})
const mqttCommandOptions = mqttDevice === undefined ? {} : { mqttCommands: mqttDevice }
const lease = await acquireRuntimeLease(runtimeDir, 'gateway')
let gateway: ReturnType<typeof createJarvisGateway>

try {
  const gatewayOptions = {
    ownerToken, pairingStatePath: statePath, sessionStatePath, eventStatePath, bindHost, harnessOrigin,
    harnessRequestTimeoutMs, pwaRoot,
    ...(deviceCommandToken === undefined ? {} : { deviceCommandToken }),
    ...deviceApprovalOptions,
    ...mqttCommandOptions,
  }
  gateway = tls === undefined
    ? createJarvisGateway(gatewayOptions)
    : createJarvisGateway({ ...gatewayOptions, tls })
  homeAssistant?.start()
  void mqttDevice?.start().catch(() => undefined)
  const running = await gateway.start(configuredPort)
  console.log(`Jarvis Gateway listening on ${running.origin}`)
} catch (error) {
  homeAssistant?.stop()
  await mqttDevice?.stop()
  await lease.release()
  throw error
}

async function stop(): Promise<void> {
  try {
    homeAssistant?.stop()
    await mqttDevice?.stop()
    await gateway.stop()
  } finally {
    await lease.release()
  }
  process.exit(0)
}

process.once('SIGINT', () => { void stop() })
process.once('SIGTERM', () => { void stop() })
