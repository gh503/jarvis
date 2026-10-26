import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runMemoryEval, type MemoryEvalCase } from '../src/memory/eval.ts'

test('memory behavioral suite: recall, abstention and privacy boundaries', async () => {
  const file = new URL('../eval/memory-cases.json', import.meta.url)
  const cases = JSON.parse(await readFile(file, 'utf8')) as MemoryEvalCase[]
  const report = await runMemoryEval(cases)
  assert.equal(report.total, cases.length)
  assert.equal(report.passed, report.total)
  assert.equal(report.privacyLeaks, 0)
  assert.equal(report.abstainCorrect, report.abstainTotal)
  assert.equal(report.hitAt1, report.hitAt3)
})
