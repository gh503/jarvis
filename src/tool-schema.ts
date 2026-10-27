import { Worker } from 'node:worker_threads'

export interface ToolValidationResult { valid: boolean; error?: string }
export interface ToolValidationOptions {
  signal?: AbortSignal
  /** Defaults to 64KiB; output validation may raise this to at most 1MiB. */
  maxValueBytes?: number
  /** Compilation and validation deadline, at most 1000ms; worker startup has a separate 5000ms cap. */
  timeoutMs?: number
}
const SCHEMA_BYTES = 65_536
let active = 0
const failure = (error: string): ToolValidationResult => ({ valid: false, error })

/** Bound traversal before serialization/structured clone. Reject getters and non-JSON values. */
function boundedJson(value: unknown, maxBytes: number, maxNodes: number): boolean {
  let bytes = 0, nodes = 0
  const ancestors = new Set<object>()
  const add = (size: number) => { bytes += size; return bytes <= maxBytes }
  const string = (value: string) => value.length <= maxBytes && add(Buffer.byteLength(JSON.stringify(value)))
  function visit(item: unknown, depth: number): boolean {
    if (++nodes > maxNodes || depth > 32) return false
    if (item === null) return add(4)
    if (typeof item === 'string') return string(item)
    if (typeof item === 'boolean') return add(item ? 4 : 5)
    if (typeof item === 'number') return Number.isFinite(item) && add(String(item).length)
    if (!item || typeof item !== 'object' || ancestors.has(item)) return false
    const array = Array.isArray(item)
    if (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return false
    if (!add(2)) return false
    ancestors.add(item)
    // Own descriptors avoid running getters during validation; symbol properties are not JSON.
    const keys = Reflect.ownKeys(item)
    if (keys.length > maxNodes || keys.some(key => typeof key !== 'string')) return false
    let count = 0
    for (const key of keys as string[]) {
      if (array && key === 'length') continue
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!
      if (!descriptor.enumerable || !('value' in descriptor)) return false
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= (item as unknown[]).length)) return false
      if (count++ && !add(1)) return false
      if (!array && (!string(key) || !add(1))) return false
      if (!visit(descriptor.value, depth + 1)) return false
    }
    if (array && count !== (item as unknown[]).length) return false
    ancestors.delete(item)
    return true
  }
  try { return visit(value, 0) } catch { return false }
}

/** Compile and execute untrusted schemas off the event loop, with a bounded worker lifetime.
 * At most four workers are alive, including workers still terminating. No unbounded queue.
 */
export async function validateToolValue(
  schema: Record<string, unknown>, value: unknown, options: ToolValidationOptions = {},
): Promise<ToolValidationResult> {
  if (options.signal?.aborted) return failure('Tool validation cancelled')
  const maxValueBytes = options.maxValueBytes ?? 65_536
  const timeoutMs = options.timeoutMs ?? 1000
  if (!Number.isSafeInteger(maxValueBytes) || maxValueBytes < 1 || maxValueBytes > 1_048_576
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1000) return failure('Invalid tool validation limits')
  if (active >= 4) return failure('Tool validation busy')
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || !boundedJson(schema, SCHEMA_BYTES, 5000)) {
    return failure('Tool schema exceeds JSON limits')
  }
  if (!boundedJson(value, maxValueBytes, Math.min(maxValueBytes, 100_000))) return failure('Tool value exceeds JSON limits')
  active++
  return new Promise(resolve => {
    let worker: Worker | undefined
    let finished = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = (result: ToolValidationResult) => {
      if (finished) return
      finished = true
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      // Keep the concurrency reservation until the worker actually exits.
      const release = () => { active--; resolve(result) }
      if (worker) void worker.terminate().then(release, release)
      else release()
    }
    const abort = () => done(failure('Tool validation cancelled'))
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) { abort(); return }
    timer = setTimeout(() => done(failure('Tool validation startup timed out')), 5000)
    try {
      worker = new Worker(new URL('./tool-schema-worker.ts', import.meta.url), {
        workerData: { schema, value },
        // This worker uses only erasable TS. Avoid loading the expensive transform-types
        // engine (or inheriting test/loader flags) for every validation on Node 24.
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 16 },
      })
      let ready = false
      worker.on('message', (result: unknown) => {
        if (finished) return
        if (!ready && (result as { ready?: unknown } | null)?.ready === true) {
          ready = true
          clearTimeout(timer)
          timer = setTimeout(() => done(failure('Tool validation timed out')), timeoutMs)
          return
        }
        const message = result as ToolValidationResult | null
        // Only our fixed messages may cross the isolation boundary.
        if (message?.valid === true) done({ valid: true })
        else done(failure(message?.error === 'Invalid tool schema' ? 'Invalid tool schema' : 'Tool value does not match schema'))
      })
      worker.once('error', () => done(failure('Tool validation worker failed')))
      worker.once('exit', () => done(failure('Tool validation worker failed')))
    } catch { done(failure('Tool validation worker failed')) }
  })
}

export function validateToolArguments(schema: Record<string, unknown>, value: unknown, signal?: AbortSignal): Promise<ToolValidationResult> {
  return validateToolValue(schema, value, { signal })
}
