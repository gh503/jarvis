import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const suite = new URL('./native-install-completed-uninstall.test.ts', import.meta.url).href

// Observe actual top-level registrations without executing filesystem fixtures.
// The production test file keeps its small partition wrapper local.
function registrations(partition?: string) {
  const env = { ...process.env }
  delete env.JARVIS_TEST_UNINSTALL_PARTITION
  if (partition !== undefined) env.JARVIS_TEST_UNINSTALL_PARTITION = partition
  return spawnSync(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', `
    import { registerHooks } from 'node:module'
    const cases = []
    globalThis.uninstallCases = cases
    const stub = 'data:text/javascript,' + encodeURIComponent(
      'export default function test(name, options) { globalThis.uninstallCases.push({ name, options }) }'
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

test('uninstall partitions register a deterministic disjoint union of all top-level cases', () => {
  const full = cases()
  assert.equal(full.length, 61)
  assert.equal(new Set(full.map(item => item.name)).size, full.length)
  const partitions = Array.from({ length: 8 }, (_, partition) => cases(String(partition)))
  assert.deepEqual(partitions.map(items => items.length), [8, 8, 8, 8, 8, 7, 7, 7])
  for (let partition = 0; partition < 8; partition++) {
    assert.deepEqual(partitions[partition], full.filter((_, index) => index % 8 === partition))
    assert.deepEqual(cases(String(partition)), partitions[partition])
  }
  const union = partitions.flat()
  assert.equal(union.length, full.length)
  assert.equal(new Set(union.map(item => item.name)).size, full.length)
  assert.deepEqual(union.map(item => item.name).sort(), full.map(item => item.name).sort())
  assert.ok(union.every(item => item.options.concurrency === false))
})

test('invalid uninstall partition fails before registering any case', () => {
  for (const partition of ['', '-1', '8', '9', '01', '1.0', ' 1', '1 ', '1\n', 'all', '0/1/2/3/4/5/6/7']) {
    const result = registrations(partition)
    assert.equal(result.error, undefined)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /JARVIS_TEST_UNINSTALL_PARTITION must be 0, 1, 2, 3, 4, 5, 6 or 7/)
    assert.deepEqual(JSON.parse(result.stdout), [])
  }
})
