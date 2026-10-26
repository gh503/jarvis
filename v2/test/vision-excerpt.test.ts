import test from 'node:test'
import assert from 'node:assert/strict'
import { selectOcrExcerpt } from '../src/senses/vision.ts'

test('OCR excerpt keeps the query-relevant line and stays bounded', () => {
  const text = ['无关的导航栏', '无关的页脚', '发布计划：周五上线', ...Array.from({ length: 200 }, (_, i) => `填充行 ${i} 的普通说明文字`)].join('\n')
  const excerpt = selectOcrExcerpt(text, '发布计划什么时候上线？', 500)
  assert.ok(excerpt.length <= 500)
  assert.match(excerpt, /发布计划/)
})
