import assert from 'node:assert/strict'
import test from 'node:test'
import { MqttDeviceAdapter } from '../dist/device-mqtt.js'
import { readMqttRuntimeConfig } from '../dist/mqtt-runtime.js'

class FakeMqttTransport {
  connected = false
  subscriptions = []
  published = []
  messageListeners = new Set()
  connectListeners = new Set()
  closeListeners = new Set()

  async connect() {
    this.connected = true
  }

  async subscribe(topic) {
    this.subscriptions.push(topic)
  }

  async publish(topic, payload, options) {
    if (!this.connected) throw new Error('not connected')
    this.published.push({ topic, payload: JSON.parse(payload), options })
  }

  onMessage(listener) {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  onConnect(listener) {
    this.connectListeners.add(listener)
    return () => this.connectListeners.delete(listener)
  }

  onClose(listener) {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  async close() {
    this.connected = false
  }

  deliver(topic, value) {
    const payload = Buffer.from(JSON.stringify(value))
    for (const listener of this.messageListeners) listener(topic, payload)
  }

  disconnect() {
    this.connected = false
    for (const listener of this.closeListeners) listener()
  }

  reconnect() {
    this.connected = true
    for (const listener of this.connectListeners) listener()
  }
}

function createAdapter(overrides = {}) {
  const transport = new FakeMqttTransport()
  const transitions = []
  const adapter = new MqttDeviceAdapter({
    deviceId: 'sensor-node-1', transport,
    onCommand: transition => transitions.push(transition),
    ...overrides,
  })
  return { adapter, transport, transitions }
}

test('uses only the bound device topics and creates one expiring QoS command', async () => {
  const context = createAdapter()
  await context.adapter.start()
  assert.deepEqual(context.transport.subscriptions, [
    'jarvis/v1/devices/sensor-node-1/presence',
    'jarvis/v1/devices/sensor-node-1/capabilities',
    'jarvis/v1/devices/sensor-node-1/state/reported',
    'jarvis/v1/devices/sensor-node-1/acks',
    'jarvis/v1/devices/sensor-node-1/results',
  ])
  const command = { commandId: 'command-1', idempotencyKey: 'once-1', capability: 'switch.set', payload: { state: 'on' }, expectedState: 'on' }
  const first = context.adapter.sendCommand(command)
  const duplicate = context.adapter.sendCommand({ ...command, payload: { state: 'on' } })
  assert.strictEqual(first, duplicate)
  assert.equal(context.transport.published.length, 1)
  assert.equal(context.transport.published[0].topic, 'jarvis/v1/devices/sensor-node-1/commands')
  assert.equal(context.transport.published[0].options.retain, false)
  assert.equal(context.transport.published[0].payload.expiresAt > Date.now(), true)
  const conflict = await context.adapter.sendCommand({ ...command, payload: { state: 'off' } })
  assert.equal(conflict.state, 'failed')
  assert.match(conflict.error, /idempotency/)
  await context.adapter.stop()
})

test('separates acknowledgement from result and ignores duplicate delivery', async () => {
  const context = createAdapter()
  await context.adapter.start()
  const promise = context.adapter.sendCommand({ commandId: 'command-2', idempotencyKey: 'once-2', capability: 'light.set', payload: { brightness: 50 } })
  context.transport.deliver('jarvis/v1/devices/sensor-node-1/acks', { version: 1, idempotencyKey: 'once-2', accepted: true })
  assert.equal(context.transitions.at(-1).phase, 'acknowledged')
  const result = { version: 1, commandId: 'command-2', idempotencyKey: 'once-2', state: 'succeeded', acknowledged: true, observedState: 'on' }
  context.transport.deliver('jarvis/v1/devices/sensor-node-1/results', result)
  assert.deepEqual(await promise, {
    commandId: 'command-2', idempotencyKey: 'once-2', capability: 'light.set', state: 'succeeded', acknowledged: true, observedState: 'on',
  })
  context.transport.deliver('jarvis/v1/devices/sensor-node-1/results', result)
  assert.equal(context.transitions.filter(transition => transition.phase === 'succeeded').length, 1)
  await context.adapter.stop()
})

test('rejects non-allowlisted capabilities before publishing', async () => {
  const context = createAdapter()
  await context.adapter.start()
  assert.throws(() => context.adapter.sendCommand({
    commandId: 'command-lock', idempotencyKey: 'once-lock', capability: 'lock.set', payload: { state: 'unlocked' },
  }), /not allowlisted/)
  assert.equal(context.transport.published.length, 0)
  await context.adapter.stop()
})

test('remains stopped when shutdown races with initial connection', async () => {
  const transport = new FakeMqttTransport()
  let finishConnect
  transport.connect = () => new Promise(resolve => { finishConnect = resolve })
  const adapter = new MqttDeviceAdapter({ deviceId: 'sensor-node-1', transport })
  const starting = adapter.start()
  await new Promise(resolve => setImmediate(resolve))
  const stopping = adapter.stop()
  finishConnect()
  await Promise.all([starting, stopping])
  assert.equal(adapter.getStatus(), 'stopped')
  assert.equal(transport.subscriptions.length, 0)
})

test('expires commands and fails pending work when the device connection closes', async () => {
  const context = createAdapter({ commandTtlMs: 20 })
  await context.adapter.start()
  const expired = context.adapter.sendCommand({ commandId: 'command-3', idempotencyKey: 'once-3', capability: 'cover.set', payload: { position: 0 } })
  assert.equal((await expired).state, 'expired')
  const unavailable = context.adapter.sendCommand({ commandId: 'command-4', idempotencyKey: 'once-4', capability: 'cover.set', payload: { position: 50 } })
  context.transport.disconnect()
  assert.equal((await unavailable).state, 'unavailable')
  assert.equal(context.adapter.getStatus(), 'degraded')
  context.transport.reconnect()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(context.adapter.getStatus(), 'ready')
  assert.equal(context.transport.subscriptions.length, 10)
})

test('rejects malformed runtime configuration and keeps credentials out of adapter serialization', () => {
  assert.equal(readMqttRuntimeConfig({}), undefined)
  assert.throws(() => readMqttRuntimeConfig({ JARVIS_MQTT_USERNAME: 'device' }), /URL is required/)
  assert.throws(() => readMqttRuntimeConfig({ JARVIS_MQTT_URL: 'mqtt://broker', JARVIS_MQTT_USERNAME: 'device' }), /configured together/)
  assert.throws(() => readMqttRuntimeConfig({ JARVIS_MQTT_URL: 'mqtt://device:secret@broker' }), /embedded credentials/)
  const config = readMqttRuntimeConfig({
    JARVIS_MQTT_URL: 'mqtts://broker.internal:8883', JARVIS_MQTT_USERNAME: 'device-1', JARVIS_MQTT_PASSWORD: 'secret', JARVIS_MQTT_CLIENT_ID: 'jarvis-1',
  })
  assert.deepEqual(config, { url: 'mqtts://broker.internal:8883', username: 'device-1', password: 'secret', clientId: 'jarvis-1' })
  const context = createAdapter()
  assert.deepEqual(context.adapter.toJSON(), { deviceId: 'sensor-node-1', topicPrefix: 'jarvis/v1', state: 'stopped' })
  assert.doesNotMatch(JSON.stringify(context.adapter), /secret/)
})
