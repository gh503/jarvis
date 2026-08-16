import assert from 'node:assert/strict'
import test from 'node:test'
import { DeviceRegistry } from '../dist/device-registry.js'

const device = (overrides = {}) => ({
  externalEntityId: 'light.living_room',
  name: 'Living room light',
  location: 'Living room',
  source: { adapter: 'home-assistant', instance: 'ha-main' },
  capabilities: ['light.set', 'sensor.read'],
  aliases: ['main light', 'living room lamp'],
  reportedState: { value: { on: false }, sourceTimestamp: 100 },
  ...overrides,
})

test('normalizes stable identity, capabilities, aliases, and deterministic ordering', () => {
  const result = new DeviceRegistry().sync([device({ capabilities: ['sensor.read', 'light.set'] })])
  assert.equal(result[0].id, 'device:home-assistant:ha-main:light.living_room')
  assert.deepEqual(result[0].aliases, ['living room lamp', 'main light'])
  assert.deepEqual(result[0].capabilities.map(capability => [capability.name, capability.risk]), [['light.set', 'low'], ['sensor.read', 'read']])
  assert.equal(result[0].capabilities[0].id, 'device:home-assistant:ha-main:light.living_room#light.set')
})

test('keeps external identities stable across discovery order and applies risk overrides', () => {
  const registry = new DeviceRegistry()
  registry.sync([
    device({ externalEntityId: 'switch.office', name: 'Office switch', capabilities: ['switch.set'], riskOverrides: { 'switch.set': 'medium' } }),
    device(),
  ])
  const result = registry.sync([device(), device({ externalEntityId: 'switch.office', name: 'Renamed office switch', capabilities: ['switch.set'], riskOverrides: { 'switch.set': 'medium' } })])
  assert.deepEqual(result.map(item => item.externalEntityId), ['light.living_room', 'switch.office'])
  assert.equal(result[1].capabilities[0].risk, 'medium')
  assert.equal(result[1].id, 'device:home-assistant:ha-main:switch.office')
})

test('marks disappeared devices unavailable and clears stale reported state', () => {
  const registry = new DeviceRegistry()
  registry.sync([device()])
  const result = registry.sync([])
  assert.equal(result[0].availability, 'unavailable')
  assert.equal('reportedState' in result[0], false)
})

test('accepts newer state, ignores older state, and restores availability', () => {
  const registry = new DeviceRegistry()
  registry.sync([device()])
  registry.sync([])
  const updated = registry.updateState({ adapter: 'home-assistant', instance: 'ha-main' }, 'light.living_room', { value: { on: true }, sourceTimestamp: 200 })
  assert.equal(updated.availability, 'available')
  assert.deepEqual(updated.reportedState, { value: { on: true }, sourceTimestamp: 200 })
  const older = registry.updateState({ adapter: 'home-assistant', instance: 'ha-main' }, 'light.living_room', { value: { on: false }, sourceTimestamp: 150 })
  assert.deepEqual(older.reportedState, updated.reportedState)
})

test('fails closed on duplicate or malformed identities and unsupported capabilities', () => {
  const registry = new DeviceRegistry()
  assert.throws(() => registry.sync([device(), device()]), /duplicate external device identity/)
  assert.throws(() => registry.sync([device({ externalEntityId: ' light.living_room' })]), /trimmed string/)
  assert.throws(() => registry.sync([device({ capabilities: ['lock.set', 'lock.set'] })]), /duplicate capability/)
  assert.throws(() => registry.sync([device({ capabilities: ['unknown.execute'] })]), /unsupported device capability/)
  assert.throws(() => registry.sync([device({ capabilities: ['lock.set'], riskOverrides: { 'lock.set': 'low' } })]), /cannot lower mandatory risk/)
  assert.throws(() => registry.sync([device({ riskOverrides: { 'unknown.execute': 'high' } })]), /unknown capability/)
})

test('serializes only normalized fields and excludes credentials or raw provider payloads', () => {
  const registry = new DeviceRegistry()
  const input = { ...device(), credentials: { token: 'secret' }, rawProviderPayload: { private: true } }
  const serialized = registry.sync([input])[0]
  assert.equal(JSON.stringify(serialized).includes('secret'), false)
  assert.equal(JSON.stringify(serialized).includes('rawProviderPayload'), false)
  assert.equal(JSON.stringify(serialized).includes('credentials'), false)
})
