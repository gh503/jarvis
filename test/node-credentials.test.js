import assert from 'node:assert/strict'
import test from 'node:test'
import { KeychainCredentialStore } from '../dist/node-credentials.js'

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
  await assert.rejects(store.read('node-1'), /16 to 4096/)
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
  await assert.rejects(store.write('node-1', 'short'), /16 to 4096/)
  await assert.rejects(store.write('node-1', 'credential-with\nline'), /line breaks/)
  assert.equal(calls, 0)
})
