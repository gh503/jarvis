import assert from 'node:assert/strict'
import test from 'node:test'
import { KeychainCredentialStore, KeychainDeviceIdentityStore } from '../dist/node-credentials.js'
import { createDeviceIdentity } from '../dist/pairing.js'

test('writes credentials through stdin and never puts them in security arguments', async () => {
  const calls = []
  const store = new KeychainCredentialStore('ai.jarvis.test', async (args, stdin) => {
    calls.push({ args: [...args], stdin })
    return { exitCode: 0, stdout: '' }
  })
  await store.write('node-1', 'credential-value-1234')
  assert.deepEqual(calls, [{
    args: ['add-generic-password', '-a', 'node-1', '-s', 'ai.jarvis.test', '-U', '-w'],
    stdin: 'credential-value-1234\ncredential-value-1234\n',
  }])
})

test('reads and removes a credential without exposing command errors', async () => {
  const calls = []
  const store = new KeychainCredentialStore('ai.jarvis.test', async (args, stdin) => {
    calls.push({ args: [...args], stdin })
    if (args[0] === 'find-generic-password') return { exitCode: 0, stdout: 'credential-value-1234\n' }
    return { exitCode: 0, stdout: '' }
  })
  assert.equal(await store.read('node-1'), 'credential-value-1234')
  assert.equal(await store.remove('node-1'), true)
  assert.deepEqual(calls, [
    { args: ['find-generic-password', '-a', 'node-1', '-s', 'ai.jarvis.test', '-w'], stdin: undefined },
    { args: ['delete-generic-password', '-a', 'node-1', '-s', 'ai.jarvis.test'], stdin: undefined },
  ])
})

test('treats an absent item as an absent credential', async () => {
  const store = new KeychainCredentialStore('ai.jarvis.test', async () => ({ exitCode: 44, stdout: '' }))
  assert.equal(await store.read('node-1'), undefined)
  assert.equal(await store.remove('node-1'), false)
})

test('rejects malformed credentials returned by Keychain', async () => {
  const store = new KeychainCredentialStore('ai.jarvis.test', async () => ({ exitCode: 0, stdout: 'short\n' }))
  await assert.rejects(store.read('node-1'), /16 to 127/)
})

test('rejects unsafe accounts, services, and credentials before invoking security', async () => {
  let calls = 0
  const run = async () => {
    calls += 1
    return { exitCode: 0, stdout: '' }
  }
  assert.throws(() => new KeychainCredentialStore('bad service'), /service/)
  const store = new KeychainCredentialStore('ai.jarvis.test', run)
  await assert.rejects(store.write('node/1', 'credential-value-1234'), /nodeId/)
  await assert.rejects(store.write('node-1', 'short'), /16 to 127/)
  await assert.rejects(store.write('node-1', 'x'.repeat(128)), /16 to 127/)
  await assert.rejects(store.write('node-1', 'credential-with\nline'), /line breaks/)
  assert.equal(calls, 0)
})

test('stores a cryptographically valid device identity through stdin without overwrite', async () => {
  const calls = []
  const identity = createDeviceIdentity()
  const store = new KeychainDeviceIdentityStore('ai.jarvis.test.identity', async (args, stdin) => {
    calls.push({ args: [...args], stdin })
    return { exitCode: 0, stdout: '' }
  })
  await store.write('node-1', identity)
  assert.deepEqual(calls[0].args, [
    'add-generic-password', '-a', 'node-1', '-s', 'ai.jarvis.test.identity', '-w',
  ])
  assert.equal(calls[0].args.includes('-U'), false)
  assert.equal(calls[0].args.includes(identity.privateKey), false)
  const secretLines = calls[0].stdin.trim().split('\n')
  assert.equal(secretLines.length, 2)
  assert.equal(secretLines[0], secretLines[1])
  assert.equal(secretLines[0], identity.privateKey)
})

test('reads and reuses the same valid device identity', async () => {
  const identity = createDeviceIdentity()
  let calls = 0
  const store = new KeychainDeviceIdentityStore('ai.jarvis.test.identity', async args => {
    calls += 1
    assert.equal(args[0], 'find-generic-password')
    return { exitCode: 0, stdout: `${identity.privateKey}\n` }
  })
  assert.deepEqual(await store.loadOrCreate('node-1'), identity)
  assert.equal(calls, 1)
})

test('rejects malformed stored keys and refuses mismatched identity metadata before writing', async () => {
  const first = createDeviceIdentity()
  const second = createDeviceIdentity()
  const malformedStore = new KeychainDeviceIdentityStore('ai.jarvis.test.identity', async () => ({
    exitCode: 0,
    stdout: `${first.publicKey}\n`,
  }))
  await assert.rejects(malformedStore.read('node-1'), /identity is invalid/)

  let calls = 0
  const writeStore = new KeychainDeviceIdentityStore('ai.jarvis.test.identity', async () => {
    calls += 1
    return { exitCode: 0, stdout: '' }
  })
  await assert.rejects(writeStore.write('node-1', { ...first, publicKey: second.publicKey }), /validation/)
  await assert.rejects(writeStore.write('node-1', { ...first, fingerprint: second.fingerprint }), /validation/)
  assert.equal(calls, 0)
})

test('creates a missing identity once and supports explicit removal', async () => {
  const calls = []
  const store = new KeychainDeviceIdentityStore('ai.jarvis.test.identity', async (args, stdin) => {
    calls.push({ args: [...args], stdin })
    if (args[0] === 'find-generic-password') return { exitCode: 44, stdout: '' }
    return { exitCode: 0, stdout: '' }
  })
  const identity = await store.loadOrCreate('node-1')
  assert.match(identity.fingerprint, /^[a-f0-9]{64}$/)
  assert.equal(calls.filter(call => call.args[0] === 'add-generic-password').length, 1)
  assert.equal(await store.remove('node-1'), true)
})
