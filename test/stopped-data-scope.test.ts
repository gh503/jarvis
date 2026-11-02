import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { withStoppedDataScope, withScopeOperation, assertStoppedDataScope, type StoppedDataScope } from '../scripts/stopped-data-scope.ts'
import { createStateSnapshot, verifyStateSnapshot } from '../scripts/native-state-snapshot.ts'
import { createConfigSnapshot, verifyConfigSnapshot } from '../scripts/native-config-snapshot.ts'
import { acquireLifecycleLock } from '../src/runtime-lifecycle.ts'
import { ensurePrivateDataDirectory } from '../src/private-directory.ts'

async function fixture(run: (f: { root: string; dataDir: string; configFile: string }) => Promise<void>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jarvis-stopped-scope-')))
  try {
    await ensurePrivateDataDirectory(root)
    const dataDir = join(root, 'data'), configDir = join(root, 'config')
    mkdirSync(dataDir, { mode: 0o700 }); mkdirSync(configDir, { mode: 0o700 })
    const configFile = join(configDir, 'config.env')
    writeFileSync(configFile, `JARVIS_DATA_DIR="${dataDir}"\n`, { mode: 0o600 })
    writeFileSync(join(dataDir, 'state'), 'preserved', { mode: 0o600 })
    await run({ root, dataDir, configFile })
  } finally {
    // This is the canonical temporary root allocated exclusively by this fixture.
    rmSync(root, { recursive: true, force: true })
  }
}
async function unlocked(dataDir: string) {
  for (const name of ['launcher', 'runtime'] as const) { const release = await acquireLifecycleLock(dataDir, name, 0); release() }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }

test('one frozen scope creates config and state snapshots without an ownership gap', async () => {
  await fixture(async f => {
    await withStoppedDataScope(f.dataDir, async scope => {
      assert.ok(Object.isFrozen(scope))
      const config = await createConfigSnapshot({ ...f, scope, destination: join(f.root, 'config-copy') })
      await verifyConfigSnapshot(config)
      for (const name of ['runtime', 'launcher'] as const) await assert.rejects(acquireLifecycleLock(f.dataDir, name, 0), /already owns|launcher is still/)
      execFileSync(process.execPath, ['--experimental-transform-types', '--input-type=module', '--eval', `
        import assert from 'node:assert/strict';
        const { acquireLifecycleLock } = await import(process.env.SCOPE_TEST_MODULE);
        for (const name of ['runtime', 'launcher']) {
          await assert.rejects(acquireLifecycleLock(process.env.SCOPE_TEST_ROOT, name, 0), /already owns|launcher is still/);
        }
      `], {
        env: { ...process.env, SCOPE_TEST_ROOT: f.dataDir, SCOPE_TEST_MODULE: new URL('../src/runtime-lifecycle.ts', import.meta.url).href },
        timeout: 15_000, stdio: 'pipe',
      })
      const state = await createStateSnapshot({ ...f, scope, destination: join(f.root, 'state-copy') })
      await verifyStateSnapshot(state)
      await createConfigSnapshot({ ...f, scope, destination: join(f.root, 'sequential-config') })
      await createStateSnapshot({ ...f, scope, destination: join(f.root, 'sequential-state') })
    })
    await unlocked(f.dataDir)
  })
})

test('forged, expired and mismatched scopes reject both APIs before destinations exist', async () => {
  await fixture(async f => {
    let expired!: StoppedDataScope
    await withStoppedDataScope(f.dataDir, async scope => { expired = scope })
    const forged: unknown[] = [null, {}, { ...expired }, new Proxy(expired, {}), expired]
    for (const value of forged) {
      const scope = value as StoppedDataScope
      for (const create of [createStateSnapshot, createConfigSnapshot]) {
        const destination = join(f.root, 'rejected')
        await assert.rejects(create({ ...f, destination, scope }), /Invalid|expired/)
        assert.equal(existsSync(destination), false)
      }
    }
    const other = join(f.root, 'other'); mkdirSync(other, { mode: 0o700 })
    await assert.rejects(withStoppedDataScope(f.dataDir, async scope => {
      for (const create of [createStateSnapshot, createConfigSnapshot]) {
        const destination = join(f.root, 'wrong-root')
        await assert.rejects(create({ ...f, dataDir: other, destination, scope }), /mismatch/)
        assert.equal(existsSync(destination), false)
      }
    }), /mismatch/)
  })
})

test('scope rejects replacement of its canonical root before destination writes', { skip: process.platform === 'win32' }, async () => {
  await fixture(async f => {
    await assert.rejects(withStoppedDataScope(f.dataDir, async scope => {
      // Both absolute paths are inside this fixture; moved is a fresh sibling.
      const moved = join(f.root, 'moved-data')
      assert.equal(existsSync(moved), false)
      renameSync(f.dataDir, moved)
      mkdirSync(f.dataDir, { mode: 0o700 })
      const destination = join(f.root, 'replacement-copy')
      await assert.rejects(createStateSnapshot({ ...f, scope, destination }), /identity changed/)
      assert.equal(existsSync(destination), false)
    }), /identity changed/)
    await unlocked(join(f.root, 'moved-data'))
  })
})

test('missing roots are never created by scope or snapshot preflight', async () => {
  await fixture(async f => {
    const dataDir = join(f.root, 'missing')
    await assert.rejects(withStoppedDataScope(dataDir, async () => {}), { code: 'ENOENT' })
    for (const create of [createStateSnapshot, createConfigSnapshot]) await assert.rejects(create({ ...f, dataDir, destination: join(f.root, 'no-copy') }))
    assert.equal(existsSync(dataDir), false)
    assert.equal(existsSync(join(f.root, 'no-copy')), false)
  })
})

test('callback failure releases locks; snapshot failure clears busy but poisons result', async () => {
  await fixture(async f => {
    const failure = new Error('callback failure')
    await assert.rejects(withStoppedDataScope(f.dataDir, async () => { throw failure }), error => error === failure)
    await unlocked(f.dataDir)
    await assert.rejects(withStoppedDataScope(f.dataDir, async scope => {
      await assert.rejects(createStateSnapshot({ ...f, scope, destination: f.dataDir }), /overlaps/)
      await createConfigSnapshot({ ...f, scope, destination: join(f.root, 'after-failure') })
    }), /overlaps/)
    await unlocked(f.dataDir)
  })
})

test('parallel and nested operations reject synchronously reserved busy scope', async () => {
  await fixture(async f => {
    await assert.rejects(withStoppedDataScope(f.dataDir, async scope => {
      const gate = deferred()
      const first = withScopeOperation(scope, f.dataDir, async () => {
        await assert.rejects(withScopeOperation(scope, f.dataDir, async () => {}), /already active/)
        await gate.promise
      })
      await assert.rejects(createConfigSnapshot({ ...f, scope, destination: join(f.root, 'parallel') }), /already active/)
      gate.resolve(); await first
      assert.equal(existsSync(join(f.root, 'parallel')), false)
    }), /already active/)
    await unlocked(f.dataDir)
  })
})

test('detached operation drains before locks release and rejects successful callback', async () => {
  await fixture(async f => {
    const gate = deferred(), entered = deferred(), left = deferred()
    let token!: StoppedDataScope
    let finished = false
    const result = withStoppedDataScope(f.dataDir, async scope => {
      token = scope
      void withScopeOperation(scope, f.dataDir, async () => { entered.resolve(); await gate.promise; finished = true })
      left.resolve()
    })
    const checked = assert.rejects(result, /active operation/)
    await entered.promise; await left.promise
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(finished, false)
    assert.throws(() => assertStoppedDataScope(token, f.dataDir), /expired/)
    await assert.rejects(acquireLifecycleLock(f.dataDir, 'runtime', 0), /already owns/)
    gate.resolve(); await checked
    assert.equal(finished, true)
    await unlocked(f.dataDir)
  })
})

test('detached failures remain observable after settlement and during callback failure', async () => {
  await fixture(async f => {
    const failure = new Error('detached failure')
    await assert.rejects(withStoppedDataScope(f.dataDir, async scope => {
      void withScopeOperation(scope, f.dataDir, async () => { throw failure })
      await new Promise<void>(resolve => setImmediate(resolve))
    }), error => error === failure)
    const gate = deferred(), entered = deferred(), callbackFailure = new Error('outer failure')
    const result = withStoppedDataScope(f.dataDir, async scope => {
      void withScopeOperation(scope, f.dataDir, async () => { entered.resolve(); await gate.promise; throw failure })
      throw callbackFailure
    })
    const checked = assert.rejects(result, error => error instanceof AggregateError && error.errors.includes(failure) && error.errors.includes(callbackFailure))
    await entered.promise
    await assert.rejects(acquireLifecycleLock(f.dataDir, 'runtime', 0), /already owns/)
    gate.resolve(); await checked
    await unlocked(f.dataDir)
  })
})
