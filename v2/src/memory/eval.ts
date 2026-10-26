import { HashEmbedder } from './embedding.ts'
import { MemoryStore } from './store.ts'
import type { MemoryKind, MemorySensitivity, MemoryStatus } from './types.ts'

export interface MemoryEvalItem {
  id: string
  content: string
  kind?: MemoryKind
  status?: MemoryStatus
  sensitivity?: MemorySensitivity
  validTo?: string
  supersedesId?: string
}

export interface MemoryEvalCase {
  id: string
  query: string
  items: MemoryEvalItem[]
  expect?: string[]
  abstain?: boolean
  includeSensitive?: boolean
  includeProposed?: boolean
}

export interface MemoryEvalResult {
  id: string
  query: string
  expected: string[]
  actual: string[]
  top: string | null
  confidence: number
  passed: boolean
  detail: string
}

export interface MemoryEvalReport {
  total: number
  passed: number
  hitAt1: number
  hitAt3: number
  abstainCorrect: number
  abstainTotal: number
  privacyLeaks: number
  results: MemoryEvalResult[]
}

const NOW = new Date('2026-10-26T08:00:00.000Z')

/**
 * Deterministic, offline behavioral evaluation. It deliberately uses the
 * hash embedder so the suite can run in CI without Ollama; the production
 * embedder is exercised separately by the acceptance/eval command.
 */
export async function runMemoryEval(cases: MemoryEvalCase[]): Promise<MemoryEvalReport> {
  const results: MemoryEvalResult[] = []
  for (const testCase of cases) {
    const store = new MemoryStore({ file: ':memory:', embedder: new HashEmbedder(128), now: () => NOW })
    try {
      for (const item of testCase.items) {
        await store.add({
          id: item.id,
          kind: item.kind ?? 'semantic',
          content: item.content,
          sourceKind: 'user-confirmed',
          sourceRef: `eval:${testCase.id}`,
          status: item.status ?? 'confirmed',
          sensitivity: item.sensitivity ?? 'standard',
          validTo: item.validTo ?? null,
          supersedesId: item.supersedesId ?? null,
        })
      }
      const result = await store.recall(testCase.query, {
        limit: 3,
        includeSensitive: testCase.includeSensitive,
        includeProposed: testCase.includeProposed,
        now: NOW,
      })
      const expected = testCase.expect ?? []
      const actual = result.items.map(item => item.id)
      const hitAt1 = actual[0] === expected[0]
      const hitAt3 = expected.every(id => actual.includes(id))
      const abstainOk = Boolean(testCase.abstain) && actual.length === 0
      const passed = testCase.abstain ? abstainOk : expected.length > 0 && hitAt3
      results.push({
        id: testCase.id,
        query: testCase.query,
        expected,
        actual,
        top: actual[0] ?? null,
        confidence: result.confidence,
        passed,
        detail: testCase.abstain
          ? actual.length === 0 ? 'correctly abstained' : `leaked: ${actual.join(', ')}`
          : hitAt1 ? 'hit@1' : hitAt3 ? 'hit@3' : `missed: ${actual.join(', ') || 'empty'}`,
      })
    } finally {
      store.close()
    }
  }
  return {
    total: results.length,
    passed: results.filter(result => result.passed).length,
    hitAt1: results.filter(result => result.expected.length > 0 && result.actual[0] === result.expected[0]).length,
    hitAt3: results.filter(result => result.expected.length > 0 && result.expected.every(id => result.actual.includes(id))).length,
    abstainCorrect: results.filter(result => result.detail === 'correctly abstained').length,
    abstainTotal: results.filter(result => result.expected.length === 0).length,
    privacyLeaks: results.filter(result => result.expected.length === 0 && result.actual.length > 0).length,
    results,
  }
}
