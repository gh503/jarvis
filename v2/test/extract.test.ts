import test from 'node:test'
import assert from 'node:assert/strict'
import { parseExtraction, shouldExtract } from '../src/memory/extract.ts'

test('explicit remember is handled synchronously, not by extraction', () => {
  assert.equal(shouldExtract('记住：我每周三晚上整理项目进度。', '好。'), false)
  assert.equal(shouldExtract('忘掉项目进度这件事。', '忘掉了。'), false)
  assert.equal(shouldExtract('我决定以后每周三晚上整理项目进度。', '好。'), true)
})

test('extraction parser tolerates fenced JSON and caps at three', () => {
  const parsed = parseExtraction('```json\n{"memories":[{"content":"a"},{"content":"b"},{"content":"c"},{"content":"d"}]}\n```')
  assert.equal(parsed.length, 3)
  assert.equal(parsed[0].content, 'a')
})

test('extraction parser rejects malformed output instead of inventing', () => {
  assert.deepEqual(parseExtraction('not json'), [])
  assert.deepEqual(parseExtraction('{"memories": "wrong"}'), [])
})
