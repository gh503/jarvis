import assert from 'node:assert/strict'
import test from 'node:test'
import { MqttCommandGatewayClient } from '../dist/mqtt-command-client.js'

const command = {
  commandId: 'command-mqtt-client',
  idempotencyKey: 'once-mqtt-client',
  capability: 'light.set',
  payload: { brightness: 50, providerToken: 'private-provider-token' },
  expectedState: 'on',
}

test('submits bounded MQTT commands to the loopback Gateway and returns only the normalized result', async () => {
  let request
  const client = new MqttCommandGatewayClient({
    url: 'http://127.0.0.1:3090', token: 'device-command-token',
    fetchImpl: async (input, init) => {
      request = { input, init }
      return new Response(JSON.stringify({ result: {
        commandId: command.commandId, idempotencyKey: command.idempotencyKey, capability: command.capability,
        state: 'succeeded', acknowledged: true, observedState: 'on',
      } }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const result = await client.sendCommand(command)
  assert.equal(request.input, 'http://127.0.0.1:3090/v1/mqtt-commands')
  assert.equal(request.init.headers.authorization, 'DeviceCommand device-command-token')
  assert.equal(JSON.parse(request.init.body).payload.providerToken, 'private-provider-token')
  assert.equal('payload' in result, false)
  assert.doesNotMatch(JSON.stringify(result), /private-provider-token/)
})

test('rejects non-loopback URLs and malformed or unredacted Gateway results', async () => {
  assert.throws(() => new MqttCommandGatewayClient({ url: 'http://gateway.example.test', token: 'device-command-token' }), /loopback/)
  assert.doesNotThrow(() => new MqttCommandGatewayClient({ url: 'http://[::1]:3090', token: 'device-command-token' }))
  const client = new MqttCommandGatewayClient({
    url: 'http://127.0.0.1:3090', token: 'device-command-token',
    fetchImpl: async () => new Response(JSON.stringify({ result: {
      commandId: command.commandId, idempotencyKey: command.idempotencyKey, capability: command.capability,
      state: 'succeeded', acknowledged: true, payload: { providerToken: 'private-provider-token' },
    } }), { status: 200 }),
  })
  await assert.rejects(client.sendCommand(command), /invalid response/)

  const mismatched = new MqttCommandGatewayClient({
    url: 'http://127.0.0.1:3090', token: 'device-command-token',
    fetchImpl: async () => new Response(JSON.stringify({ result: {
      commandId: 'another-command', idempotencyKey: command.idempotencyKey, capability: command.capability,
      state: 'succeeded', acknowledged: true,
    } }), { status: 200 }),
  })
  await assert.rejects(mismatched.sendCommand(command), /invalid response/)
})
