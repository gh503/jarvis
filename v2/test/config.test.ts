import test from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig, parseEnvFile } from '../src/config.ts'

test('parses quoted and unquoted env values', () => {
  const result = parseEnvFile('A=1\nB="two words"\n# comment\nC=\'three\'\n')
  assert.deepEqual(result, { A: '1', B: 'two words', C: 'three' })
})

test('remote binding fails closed without a token and TLS', () => {
  const saved = { ...process.env }
  try {
    process.env.JARVIS_HOST = '0.0.0.0'
    delete process.env.JARVIS_AUTH_TOKEN
    delete process.env.JARVIS_TLS_CERT
    delete process.env.JARVIS_TLS_KEY
    assert.throws(() => loadConfig(), /JARVIS_AUTH_TOKEN/)
  } finally {
    process.env = saved
  }
})

test('remote binding still fails closed with a token but no TLS', () => {
  const saved = { ...process.env }
  try {
    process.env.JARVIS_HOST = '0.0.0.0'
    process.env.JARVIS_AUTH_TOKEN = 'a'.repeat(32)
    delete process.env.JARVIS_TLS_CERT
    delete process.env.JARVIS_TLS_KEY
    assert.throws(() => loadConfig(), /TLS/)
  } finally {
    process.env = saved
  }
})
