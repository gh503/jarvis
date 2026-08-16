import assert from 'node:assert/strict'
import test from 'node:test'
import { DeviceCommandGatewayClient } from '../dist/device-command-client.js'

const command = {
  commandId: 'command-lock-client', idempotencyKey: 'once-lock-client', capability: 'lock.set',
  externalEntityId: 'lock.front_door', service: 'unlock', expectedState: 'unlocked',
  serviceData: { token: 'provider-secret' },
}

test('submits only normalized loopback device commands and returns a redacted approval', async () => {
  let request
  const client = new DeviceCommandGatewayClient({
    url: 'http://127.0.0.1:3090', token: 'device-command-token',
    fetchImpl: async (input, init) => {
      request = { input, init }
      return new Response(JSON.stringify({ approval: {
        approvalId: 'approval-client', capability: 'lock.set', externalEntityId: 'lock.front_door',
        service: 'unlock', expectedState: 'unlocked', digest: 'a'.repeat(64), risk: 'high', expiresAt: 61_000,
      } }), { status: 202, headers: { 'content-type': 'application/json' } })
    },
  })
  const approval = await client.requestApproval(command)
  assert.equal(approval.approvalId, 'approval-client')
  assert.equal('serviceData' in approval, false)
  assert.equal(request.input, 'http://127.0.0.1:3090/v1/device-commands')
  assert.equal(request.init.headers.authorization, 'DeviceCommand device-command-token')
  assert.equal(JSON.parse(request.init.body).serviceData.token, 'provider-secret')
})

test('rejects non-loopback Gateway URLs and malformed approval responses', async () => {
  assert.throws(() => new DeviceCommandGatewayClient({ url: 'http://gateway.example.test', token: 'device-command-token' }), /loopback/)
  assert.doesNotThrow(() => new DeviceCommandGatewayClient({ url: 'http://[::1]:3090', token: 'device-command-token' }))
  const client = new DeviceCommandGatewayClient({
    url: 'http://127.0.0.1:3090', token: 'device-command-token',
    fetchImpl: async () => new Response(JSON.stringify({ approval: { serviceData: { token: 'private' } } }), { status: 202 }),
  })
  await assert.rejects(client.requestApproval(command), /invalid response/)
})
