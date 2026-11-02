import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateMember } from '../scripts/verify-native-release-pair.ts'

test('release acceptance rejects archive paths that escape or alias the fixed root', () => {
  const root = 'jarvis-2.0.75-linux-x64'
  for (const name of [root + '/', root + '/runtime/node', root + '/docs/中文.txt']) validateMember(name, root)
  for (const name of [
    '/tmp/payload', 'other/runtime/node', root + '/../outside', root + '/./alias',
    root + '//alias', root + '/dir\\outside', root + '/file:stream', root + '/file.',
    root + '/file ', root + '/bad\nname', root + '/bad\0name',
  ]) assert.throws(() => validateMember(name, root), { name: 'AssertionError' }, name)
})
