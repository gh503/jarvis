import { lstatSync, realpathSync, type BigIntStats } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { acquireLifecycleLock } from '../src/runtime-lifecycle.ts'

declare const stoppedDataScopeBrand: unique symbol
/** Capability valid only inside an awaited withStoppedDataScope callback. */
export interface StoppedDataScope { readonly [stoppedDataScopeBrand]: true }
type Outcome = { ok: true } | { ok: false; error: unknown }
interface State { root: string; identity: BigIntStats; active: boolean; closing: boolean; pending?: Promise<Outcome>; failure?: { error: unknown } }
const states = new WeakMap<object, State>()
function existingRoot(root: string) {
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root || root.includes('\0')) throw new Error('Expected canonical absolute data directory')
  for (let p = root; ; p = dirname(p)) {
    const stat = lstatSync(p)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Expected existing data directory without links')
    if (dirname(p) === p) break
  }
  if (realpathSync(root) !== root) throw new Error('Expected canonical existing data directory')
  return lstatSync(root, { bigint: true })
}
export function assertStoppedDataScope(scope: unknown, dataDir: string): asserts scope is StoppedDataScope {
  const state = scope !== null && typeof scope === 'object' ? states.get(scope) : undefined
  if (!state) throw new Error('Invalid stopped data scope')
  if (!state.active || state.closing) throw new Error('Stopped data scope expired')
  if (state.root !== dataDir) throw new Error('Stopped data scope directory mismatch')
  const current = existingRoot(dataDir)
  if (current.dev !== state.identity.dev || current.ino !== state.identity.ino) throw new Error('Stopped data scope directory identity changed')
}
/** Operations must be awaited and sequential. Reserve before any asynchronous preflight.
 * Any operation failure or rejected admission poisons the enclosing scope, even
 * when caught by its callback; subsequent operations can still run sequentially.
 */
export function withScopeOperation<T>(scope: StoppedDataScope, dataDir: string, operation: () => Promise<T>): Promise<T> {
  try {
    assertStoppedDataScope(scope, dataDir)
    const state = states.get(scope)!
    if (state.pending) throw new Error('Stopped data scope operation already active')
    const result = Promise.resolve().then(operation)
    const pending = result.then<Outcome, Outcome>(
      () => { state.pending = undefined; return { ok: true } },
      error => { state.pending = undefined; state.failure ??= { error }; return { ok: false, error } },
    )
    state.pending = pending
    // The observer handles detached rejection; the original promise still rejects for its caller.
    return result
  } catch (error) {
    const state = scope !== null && typeof scope === 'object' ? states.get(scope) : undefined
    if (state?.active) state.failure ??= { error }
    const rejected = Promise.reject<T>(error)
    void rejected.catch(() => {})
    return rejected
  }
}
/** Hold launcher then runtime ownership continuously across sequential snapshots.
 * A callback returning with work in flight is misuse: drain it before unlocking,
 * then reject, retaining both callback and detached-operation errors when present.
 */
export async function withStoppedDataScope<T>(dataDir: string, callback: (scope: StoppedDataScope) => Promise<T>): Promise<T> {
  const identity = existingRoot(dataDir)
  const releaseLauncher = await acquireLifecycleLock(dataDir, 'launcher', 0)
  try {
    const releaseRuntime = await acquireLifecycleLock(dataDir, 'runtime', 0)
    const scope = Object.freeze({}) as StoppedDataScope
    const state: State = { root: dataDir, identity, active: true, closing: false }
    states.set(scope, state)
    try {
      assertStoppedDataScope(scope, dataDir)
      let value!: T
      const errors: unknown[] = []
      try { value = await callback(scope) } catch (error) { errors.push(error) }
      state.closing = true
      const pending = state.pending
      if (pending) {
        const outcome = await pending
        errors.push(new Error('Stopped data scope callback finished with an active operation; await every operation'))
        if (!outcome.ok && !errors.includes(outcome.error)) errors.push(outcome.error)
      }
      if (state.failure && !errors.includes(state.failure.error)) errors.push(state.failure.error)
      if (errors.length === 1) throw errors[0]
      if (errors.length) throw new AggregateError(errors, 'Stopped data scope callback or detached operation failed')
      return value
    } finally { state.active = false; state.closing = true; releaseRuntime() }
  } finally { releaseLauncher() }
}
