import assert from 'node:assert/strict'
import { test } from 'node:test'
import { processFailureMetadata, validateMember } from '../scripts/verify-native-release-pair.ts'

test('process failure metadata excludes messages, accessors and arbitrary values', () => {
  assert.deepEqual(processFailureMetadata({ status: 1, signal: 'SIGTERM', code: 'ETIMEDOUT', message: 'secret', stderr: 'secret', cmd: 'secret' }), { status: 1, signal: 'SIGTERM', code: 'ETIMEDOUT' })
  let reads = 0
  const hostile = Object.create({ code: 'ENOENT' }, { status: { get() { reads++; return 1 } } })
  assert.deepEqual(processFailureMetadata(hostile), {})
  assert.equal(reads, 0)
  assert.deepEqual(processFailureMetadata({ status: Infinity, signal: 'secret', code: 'secret' }), {})
  assert.deepEqual(processFailureMetadata(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('secret') } })), {})
})

test('release acceptance rejects archive paths that escape or alias the fixed root', () => {
  const root = 'jarvis-2.0.75-linux-x64'
  for (const name of [root + '/', root + '/runtime/node', root + '/docs/中文.txt']) validateMember(name, root)
  for (const name of [
    '/tmp/payload', 'other/runtime/node', root + '/../outside', root + '/./alias',
    root + '//alias', root + '/dir\\outside', root + '/file:stream', root + '/file.',
    root + '/file ', root + '/bad\nname', root + '/bad\0name',
  ]) assert.throws(() => validateMember(name, root), { name: 'AssertionError' }, name)
})
