import assert from 'node:assert/strict'
import test from 'node:test'
import { readHomeAssistantRuntimeConfig } from '../dist/home-assistant-runtime.js'

test('keeps Home Assistant optional and rejects partial runtime configuration', () => {
  assert.equal(readHomeAssistantRuntimeConfig({}), undefined)
  assert.throws(() => readHomeAssistantRuntimeConfig({ JARVIS_HOME_ASSISTANT_URL: 'ws://127.0.0.1:8123/api/websocket' }), /configured together/)
  assert.throws(() => readHomeAssistantRuntimeConfig({ JARVIS_HOME_ASSISTANT_TOKEN: 'secret' }), /configured together/)
})

test('normalizes the explicit Home Assistant runtime configuration without changing the token', () => {
  const config = readHomeAssistantRuntimeConfig({
    JARVIS_HOME_ASSISTANT_URL: 'wss://ha.internal.example/api/websocket',
    JARVIS_HOME_ASSISTANT_TOKEN: 'provider-token',
    JARVIS_HOME_ASSISTANT_COMMAND_TIMEOUT_MS: '15000',
  })
  assert.deepEqual(config, {
    url: 'wss://ha.internal.example/api/websocket',
    accessToken: 'provider-token',
    commandTimeoutMs: 15_000,
  })
  assert.throws(() => readHomeAssistantRuntimeConfig({
    JARVIS_HOME_ASSISTANT_URL: 'ws://127.0.0.1:8123/api/websocket',
    JARVIS_HOME_ASSISTANT_TOKEN: 'secret',
    JARVIS_HOME_ASSISTANT_COMMAND_TIMEOUT_MS: '0',
  }), /from 1 to 120000/)
})
