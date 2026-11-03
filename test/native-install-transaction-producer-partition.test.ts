import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
const suite = new URL('./native-install-transaction-producer.test.ts', import.meta.url).href
function registrations(partition?: string) {
  const env = { ...process.env }
  delete env.JARVIS_INSTALL_PRODUCER_PARTITION
  if (partition !== undefined) env.JARVIS_INSTALL_PRODUCER_PARTITION = partition
  return spawnSync(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', `
    import { registerHooks } from 'node:module'
    globalThis.cases = []
    const stub = 'data:text/javascript,' + encodeURIComponent('export function test(name) { globalThis.cases.push(name) }')
    registerHooks({ resolve(specifier, context, next) { return specifier === 'node:test' ? { url: stub, shortCircuit: true } : next(specifier, context) } })
    try { await import(${JSON.stringify(suite)}) } catch { process.exitCode = 1 }
    console.log(JSON.stringify(globalThis.cases))
  `], { env, encoding: 'utf8', timeout: 30_000 })
}
test('producer partitions cover the full deterministic test set exactly once', () => {
  const full = registrations()
  assert.equal(full.status, 0, full.stderr)
  const names: string[] = JSON.parse(full.stdout)
  assert.ok(names.length >= 45)
  const union = []
  for (let index = 0; index < 8; index++) {
    const result = registrations(String(index))
    assert.equal(result.status, 0, result.stderr)
    const selected = JSON.parse(result.stdout)
    assert.deepEqual(selected, names.filter((_, ordinal) => ordinal % 8 === index))
    union.push(...selected)
  }
  assert.equal(new Set(union).size, names.length)
  assert.deepEqual(union.sort(), names.sort())
})
test('producer partition accepts only exact digits zero through seven', () => {
  for (const partition of ['', '8', '-1', '01', '1.0', ' 1', '1 ', '1\n', 'all']) {
    const result = registrations(partition)
    assert.equal(result.status, 1)
    assert.deepEqual(JSON.parse(result.stdout), [])
  }
})
