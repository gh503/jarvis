import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const suite = new URL('./native-install-completed-uninstall-cli.test.ts', import.meta.url).href

// Observe actual top-level registrations without executing filesystem fixtures.
// The production test file keeps its small partition wrapper local.
function registrations(partition?: string) {
  const env = { ...process.env }
  delete env.JARVIS_TEST_UNINSTALL_CLI_PARTITION
  if (partition !== undefined) env.JARVIS_TEST_UNINSTALL_CLI_PARTITION = partition
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

const expectedNames = [
  'strict completed uninstall parser validates all fields, duplicate/unknown switches and standalone help',
  ...['darwin', 'win32'].flatMap(platform => [
    `${platform}: subprocess removes exact completed generation with missing original root`,
    ...['wrong-id/wrong-root', 'replace-receipt/replace-artifact', 'unknown/intent/startup'].map(scenarios => `${platform}: subprocess refuses ${scenarios} and preserves evidence`),
    `${platform}: malformed subprocess input makes no writes or raw reports`,
  ]),
  'standalone JSON help and invalid inputs require no operational modules; import failures are uncertain',
  'packaging includes explicit uninstall CLI and excludes its test and fixture',
]

test('uninstall CLI partitions register the original 13 names as a deterministic exact union', () => {
  const full = cases()
  assert.deepEqual(full.map(item => item.name), expectedNames)
  const partitions = Array.from({ length: 13 }, (_, partition) => cases(String(partition)))
  assert.deepEqual(partitions.map(items => items.length), Array(13).fill(1))
  for (let partition = 0; partition < 13; partition++) {
    assert.deepEqual(partitions[partition], [full[partition]])
    assert.deepEqual(cases(String(partition)), partitions[partition])
  }
  assert.deepEqual(partitions.flat(), full)
  assert.equal(new Set(partitions.flat().map(item => item.name)).size, 13)
  assert.ok(full.every(item => item.options.concurrency === false))
})

test('invalid uninstall CLI partition fails before registering any case', () => {
  for (const partition of ['', '-1', '13', '16', '01', '1.0', ' 1', '1 ', '1\n', 'all', '0/1/2/3', 'NaN']) {
    const result = registrations(partition)
    assert.equal(result.error, undefined)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /JARVIS_TEST_UNINSTALL_CLI_PARTITION must be an integer from 0 through 12/)
    assert.deepEqual(JSON.parse(result.stdout), [])
  }
})
