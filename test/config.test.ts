import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultDataDir, loadConfig, parseEnvFile } from '../src/config.ts'

test('native data defaults are absolute and preserve existing Linux state', () => {
  assert.equal(defaultDataDir('linux', '/home/example', {}), '/home/example/.local/share/jarvis/data')
  assert.equal(defaultDataDir('darwin', '/Users/Example Person', {}), '/Users/Example Person/Library/Application Support/Jarvis/data')
  assert.equal(defaultDataDir('win32', 'C:\\Users\\Example', { LOCALAPPDATA: 'D:\\Local Data' }), 'D:\\Local Data\\Jarvis\\data')
  assert.equal(defaultDataDir('win32', 'C:\\Users\\Example', { LOCALAPPDATA: 'relative' }), 'C:\\Users\\Example\\AppData\\Local\\Jarvis\\data')
})

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
