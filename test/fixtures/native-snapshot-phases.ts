// TEST ONLY. Install before dynamically importing the snapshot module.
import childProcess from 'node:child_process'
import { createHash } from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { win32 } from 'node:path'
import { types } from 'node:util'

const fingerprint = '2e8d9eeec5f538ae555915aa72b5fbf179a63385f1e21729bbab3401f93241f2'
const phases = ['entered', 'json-start', 'json-done', 'ancestor-start', 'ancestor-done', 'acl-start', 'acl-done', 'complete'] as const
type Phase = typeof phases[number]
export interface PermissionPhases { elapsedMs: number; phases: Partial<Record<Phase, number>>; truncated: boolean }
const bound = (n: number) => Math.max(0, Math.min(120_000, Math.round(n)))

// Exact full-line grammar only; never retain arbitrary output, paths or error text.
// A partial final line is ignored, including output cut off by execFile maxBuffer.
export function parsePermissionPhases(stdout: unknown, started: number, elapsed: number): PermissionPhases {
  const result: PermissionPhases = { elapsedMs: bound(elapsed), phases: {}, truncated: false }
  if (typeof stdout !== 'string' && !Buffer.isBuffer(stdout)) return result
  const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout)
  result.truncated = bytes.length > 16 * 1024
  const text = bytes.subarray(0, 16 * 1024).toString('utf8')
  const lines = text.split('\n')
  if (lines.pop() !== '') result.truncated = true
  for (const line of lines.slice(0, 96)) {
    const match = /^JARVIS_PHASE_V1\|(entered|json-start|json-done|ancestor-start|ancestor-done|acl-start|acl-done|complete)\|([0-9]{13})\r?$/.exec(line)
    if (!match) continue
    const ms = Number(match[2]) - started
    if (ms >= 0 && ms <= 120_000) result.phases[match[1] as Phase] = ms
  }
  if (lines.length >= 96) result.truncated = true
  return result
}

/** Reconstruct the small parent-facing protocol; never spread child JSON. */
export function sanitizePermissionPhases(value: unknown): PermissionPhases | undefined {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return undefined
  const own = (object: object, key: string): unknown => Object.getOwnPropertyDescriptor(object, key)?.value
  const elapsedMs = own(value, 'elapsedMs'), truncated = own(value, 'truncated'), timings = own(value, 'phases')
  if (typeof elapsedMs !== 'number' || !Number.isInteger(elapsedMs) || elapsedMs < 0 || elapsedMs > 120_000 || typeof truncated !== 'boolean' || !timings || typeof timings !== 'object' || types.isProxy(timings)) return undefined
  const result: PermissionPhases = { elapsedMs, phases: {}, truncated }
  for (const phase of phases) {
    const n = own(timings, phase)
    if (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 120_000) result.phases[phase] = n
  }
  return result
}

export function decoratePermissionScript(script: string): string | undefined {
  if (createHash('sha256').update(script).digest('hex') !== fingerprint) return undefined
  const marker = (phase: Phase) => `Write-JarvisPhase '${phase}'`
  return `# Test-only bounded fixed phase protocol; no path or exception interpolation.
$script:jarvisPhaseCount=0
function Write-JarvisPhase([string]$phase) {
 if ($script:jarvisPhaseCount -lt 96) {
  $script:jarvisPhaseCount++
  [Console]::Out.WriteLine('JARVIS_PHASE_V1|'+$phase+'|'+[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
  [Console]::Out.Flush()
 }
}
${marker('entered')}
` + script
    .replace('foreach ($p in (ConvertFrom-Json $env:JARVIS_INTEGRATION_PATHS)) {', `${marker('json-start')}\n$jarvisPaths=ConvertFrom-Json $env:JARVIS_INTEGRATION_PATHS\n${marker('json-done')}\nforeach ($p in $jarvisPaths) {`)
    .replace(' $c=$p', ` ${marker('ancestor-start')}\n $c=$p`)
    .replace(' # Windows PowerShell', ` ${marker('ancestor-done')}\n # Windows PowerShell`)
    .replace(' $acl=if', ` ${marker('acl-start')}\n $acl=if`)
    .replace(' $owner=$acl.GetOwner', ` ${marker('acl-done')}\n $owner=$acl.GetOwner`) + `\n${marker('complete')}`
}

/** Only the exact production invocation is eligible. Unknown/drifted scripts pass through. */
export function installPermissionPhaseProbe(): { latest: () => PermissionPhases | undefined; restore: () => void } {
  const original = childProcess.execFile
  let latest: PermissionPhases | undefined
  // Keep native callback semantics (including errors/streams) and the ChildProcess.
  const wrapped = function (...call: unknown[]) {
    const [file, args, options, callback] = call
    const opts = options as childProcess.ExecFileOptions | undefined
    const root = opts?.env?.SystemRoot
    if (typeof root === 'string' && win32.isAbsolute(root) && file === win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') &&
      Array.isArray(args) && args.length === 5 && args.slice(0, 4).join('|') === '-NoLogo|-NoProfile|-NonInteractive|-EncodedCommand' &&
      typeof args[4] === 'string' && args[4].length < 32 * 1024 && typeof opts?.env?.JARVIS_INTEGRATION_PATHS === 'string' &&
      opts.timeout === 10_000 && opts.maxBuffer === 16 * 1024 && opts.windowsHide === true && opts.shell === false && typeof callback === 'function') {
      const script = decoratePermissionScript(Buffer.from(args[4], 'base64').toString('utf16le'))
      if (script !== undefined) {
        const started = Date.now(), clock = performance.now()
        latest = undefined
        call[1] = [...args.slice(0, 4), Buffer.from(script, 'utf16le').toString('base64')]
        call[3] = (error: unknown, stdout: unknown, stderr: unknown) => {
          latest = parsePermissionPhases(stdout, started, performance.now() - clock)
          callback(error, stdout, stderr)
        }
      }
    }
    return Reflect.apply(original, childProcess, call)
  } as typeof childProcess.execFile
  childProcess.execFile = wrapped
  syncBuiltinESMExports()
  return { latest: () => latest, restore() { childProcess.execFile = original; syncBuiltinESMExports() } }
}
