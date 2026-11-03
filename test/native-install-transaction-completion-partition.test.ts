import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const suite = new URL('./native-install-transaction-completion-store.test.ts', import.meta.url).href

// Observe actual top-level registrations without executing filesystem fixtures.
// The production test file keeps its small partition wrapper local.
function registrations(partition?: string) {
  const env = { ...process.env }
  delete env.JARVIS_TEST_COMPLETION_PARTITION
  if (partition !== undefined) env.JARVIS_TEST_COMPLETION_PARTITION = partition
  return spawnSync(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', `
    import { registerHooks } from 'node:module'
    const cases = []
    globalThis.completionCases = cases
    const stub = 'data:text/javascript,' + encodeURIComponent(
      'export default function test(name, options) { globalThis.completionCases.push({ name, options }) }'
    )
    registerHooks({ resolve(specifier, context, nextResolve) {
      return specifier === 'node:test' ? { url: stub, shortCircuit: true } : nextResolve(specifier, context)
    } })
    try {
      await import(${JSON.stringify(suite)})
      console.log(JSON.stringify(cases))
    } catch (error) {
      console.log(JSON.stringify(cases))
      console.error(error.message)
      process.exitCode = 1
    }
  `], { env, encoding: 'utf8', timeout: 30_000 })
}

type Registration = { name: string, options: { concurrency: boolean, skip?: boolean } }
function cases(partition?: string): Registration[] {
  const result = registrations(partition)
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test('completion partitions register a deterministic disjoint union of all top-level cases', () => {
  const full = cases()
  assert.ok(full.length > 0)
  assert.equal(new Set(full.map(item => item.name)).size, full.length)
  const partitions = Array.from({ length: 4 }, (_, partition) => cases(String(partition)))
  for (let partition = 0; partition < 4; partition++) {
    assert.deepEqual(partitions[partition], full.filter((_, index) => index % 4 === partition))
    assert.deepEqual(cases(String(partition)), partitions[partition])
  }
  const union = partitions.flat()
  assert.equal(union.length, full.length)
  assert.equal(new Set(union.map(item => item.name)).size, full.length)
  assert.deepEqual(union.map(item => item.name).sort(), full.map(item => item.name).sort())
  assert.ok(union.every(item => item.options.concurrency === false))
})

test('invalid completion partition fails before registering any case', () => {
  for (const partition of ['', '-1', '4', '01', '1.0', ' 1', '1 ', '1\n', 'all', '0/1/2/3']) {
    const result = registrations(partition)
    assert.equal(result.error, undefined)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /JARVIS_TEST_COMPLETION_PARTITION must be 0, 1, 2 or 3 when set/)
    assert.deepEqual(JSON.parse(result.stdout), [])
  }
})
