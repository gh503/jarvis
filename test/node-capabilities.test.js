import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAC_NODE_CAPABILITIES,
  NODE_PROTOCOL_VERSION,
  createNodeRegistration,
  parseNodeRegistration,
} from '../dist/node-capabilities.js'

const registration = (overrides = {}) => ({
  nodeId: 'node-1',
  platform: 'macos',
  softwareVersion: '0.2.0-dev',
  capabilities: Object.values(MAC_NODE_CAPABILITIES),
  ...overrides,
})

test('creates a stable versioned registration sorted by capability name', () => {
  const result = createNodeRegistration(registration({ capabilities: [MAC_NODE_CAPABILITIES.system_status, MAC_NODE_CAPABILITIES.open_app] }))
  assert.equal(result.protocolVersion, NODE_PROTOCOL_VERSION)
  assert.deepEqual(result.capabilities.map(capability => capability.name), ['open_app', 'system_status'])
})

test('rejects capabilities that are not in the local allowlist', () => {
  assert.throws(() => createNodeRegistration(registration({
    capabilities: [{ ...MAC_NODE_CAPABILITIES.system_status, name: 'run_shell' }],
  })), /not allowlisted/)
})

test('rejects duplicate capabilities and definition changes', () => {
  assert.throws(() => createNodeRegistration(registration({
    capabilities: [MAC_NODE_CAPABILITIES.open_app, MAC_NODE_CAPABILITIES.open_app],
  })), /duplicate/)
  assert.throws(() => createNodeRegistration(registration({
    capabilities: [{ ...MAC_NODE_CAPABILITIES.open_app, timeoutMs: 1 }],
  })), /does not match/)
})

test('parses a wire registration and rejects protocol or platform changes', () => {
  const created = createNodeRegistration(registration())
  assert.deepEqual(parseNodeRegistration(JSON.parse(JSON.stringify(created))), created)
  assert.throws(() => parseNodeRegistration({ ...created, protocolVersion: 2 }), /protocol version/)
  assert.throws(() => parseNodeRegistration({ ...created, platform: 'linux' }), /platform/)
})

test('rejects malformed descriptor fields at the wire boundary', () => {
  const created = createNodeRegistration(registration())
  const malformed = {
    ...created,
    capabilities: [{ ...created.capabilities[0], supportsCancellation: 'yes' }],
  }
  assert.throws(() => parseNodeRegistration(malformed), /does not match|boolean/)
})
