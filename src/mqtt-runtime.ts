import { connect, type IClientOptions, type MqttClient } from 'mqtt'
import type { MqttDeviceTransport } from './device-mqtt.js'

export interface MqttRuntimeConfig {
  url: string
  username?: string
  password?: string
  clientId?: string
}

function optionalEnvironment(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = environment[name]
  if (value === undefined) return undefined
  if (value.length === 0) throw new Error(`${name} must not be empty`)
  return value
}

export function readMqttRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): MqttRuntimeConfig | undefined {
  const url = optionalEnvironment(environment, 'JARVIS_MQTT_URL')
  const username = optionalEnvironment(environment, 'JARVIS_MQTT_USERNAME')
  const password = optionalEnvironment(environment, 'JARVIS_MQTT_PASSWORD')
  const clientId = optionalEnvironment(environment, 'JARVIS_MQTT_CLIENT_ID')
  if (url === undefined && username === undefined && password === undefined && clientId === undefined) return undefined
  if (url === undefined) throw new Error('JARVIS_MQTT_URL is required when MQTT is configured')
  if ((username === undefined) !== (password === undefined)) throw new Error('JARVIS_MQTT_USERNAME and JARVIS_MQTT_PASSWORD must be configured together')
  const parsed = new URL(url)
  if (parsed.protocol !== 'mqtt:' && parsed.protocol !== 'mqtts:') throw new Error('JARVIS_MQTT_URL must use mqtt or mqtts')
  if (parsed.username !== '' || parsed.password !== '') throw new Error('JARVIS_MQTT_URL must not contain embedded credentials')
  return {
    url: parsed.toString(),
    ...(username === undefined ? {} : { username }),
    ...(password === undefined ? {} : { password }),
    ...(clientId === undefined ? {} : { clientId }),
  }
}

export function createMqttDeviceTransport(config: MqttRuntimeConfig): MqttDeviceTransport {
  let client: MqttClient | undefined
  const messageListeners = new Set<(topic: string, payload: Uint8Array) => void>()
  const connectListeners = new Set<() => void>()
  const closeListeners = new Set<() => void>()
  const options: IClientOptions = {
    ...(config.username === undefined ? {} : { username: config.username }),
    ...(config.password === undefined ? {} : { password: config.password }),
    ...(config.clientId === undefined ? {} : { clientId: config.clientId }),
    reconnectPeriod: 1_000,
    clean: true,
  }

  function currentClient(): MqttClient {
    if (client === undefined) throw new Error('MQTT client is not connected')
    return client
  }

  return {
    async connect() {
      if (client?.connected === true) return
      client = connect(config.url, options)
      client.on('message', (topic, payload) => {
        const bytes = new Uint8Array(payload)
        for (const listener of messageListeners) listener(topic, bytes)
      })
      client.on('close', () => {
        for (const listener of closeListeners) listener()
      })
      client.on('connect', () => {
        for (const listener of connectListeners) listener()
      })
      await new Promise<void>((resolve, reject) => {
        const connected = () => { cleanup(); resolve() }
        const failed = (error: Error) => { cleanup(); reject(error) }
        const cleanup = () => {
          client?.off('connect', connected)
          client?.off('error', failed)
        }
        client?.once('connect', connected)
        client?.once('error', failed)
      })
    },
    async subscribe(topic) {
      await new Promise<void>((resolve, reject) => {
        currentClient().subscribe(topic, { qos: 1 }, error => error === null ? resolve() : reject(error))
      })
    },
    async publish(topic, payload, publishOptions) {
      await new Promise<void>((resolve, reject) => {
        currentClient().publish(topic, payload, {
          qos: publishOptions.qos,
          retain: publishOptions.retain,
          properties: { messageExpiryInterval: publishOptions.messageExpiryInterval },
        }, error => error === undefined ? resolve() : reject(error))
      })
    },
    onMessage(listener) {
      messageListeners.add(listener)
      return () => messageListeners.delete(listener)
    },
    onConnect(listener) {
      connectListeners.add(listener)
      return () => connectListeners.delete(listener)
    },
    onClose(listener) {
      closeListeners.add(listener)
      return () => closeListeners.delete(listener)
    },
    async close() {
      const active = client
      client = undefined
      if (active === undefined) return
      await new Promise<void>(resolve => active.end(true, {}, () => resolve()))
    },
  }
}
