import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { actionExecution, ActionManager, isAllowedUrl } from '../src/actions.ts'
import { Notifier, notificationExecution } from '../src/notify.ts'
import type { Logger } from '../src/logger.ts'

const hostileUrl = 'https://example.com/中文?q=\';$(calc.exe)&x=";`whoami`|%PATH%'

test('native URL launch preserves adversarial URL as data', () => {
  assert.equal(isAllowedUrl(hostileUrl), true)
  assert.deepEqual(actionExecution('open-url', hostileUrl, 'linux'), { command: 'xdg-open', args: [hostileUrl] })
  assert.deepEqual(actionExecution('open-url', hostileUrl, 'darwin'), { command: '/usr/bin/open', args: [hostileUrl] })
  const windows = actionExecution('open-url', hostileUrl, 'win32')
  assert.equal(windows.command, 'powershell.exe')
  assert.deepEqual(windows.args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'])
  const script = Buffer.from(windows.args[4]!, 'base64').toString('utf16le')
  assert.match(script, /FileName = \$env:JARVIS_OPEN_TARGET/)
  assert.match(script, /UseShellExecute = \$true/)
  assert.equal(script.includes(hostileUrl), false)
  assert.equal(windows.env?.JARVIS_OPEN_TARGET, hostileUrl)
  assert.equal(windows.args.includes(hostileUrl), false)
})

test('logical app allowlist rejects shell text and inherited object names on every OS', () => {
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    for (const target of ['constructor', '__proto__', 'toString', 'files;calc', '-a Terminal', 'browser & calc.exe']) {
      assert.throws(() => actionExecution('open-app', target, platform), /不在允许/)
      const manager = new ActionManager({ auditFile: '', platform, runner: async () => {} })
      assert.throws(() => manager.propose({ kind: 'open-app', target }), /不在允许/)
    }
    for (const target of ['file:///tmp/a', 'https://user:pass@example.com/', 'javascript:alert(1)']) {
      assert.throws(() => actionExecution('open-url', target, platform), /http/)
    }
  }
  assert.deepEqual(actionExecution('open-app', 'files', 'darwin').args, [homedir()])
  assert.deepEqual(actionExecution('open-app', 'browser', 'darwin').args, ['-a', 'Safari'])
  assert.equal(actionExecution('open-app', 'files', 'win32').env?.JARVIS_OPEN_TARGET, homedir())
  assert.match(actionExecution('open-app', 'browser', 'win32').env!.JARVIS_OPEN_TARGET!, /^https:\/\//)
})

test('native approval probes availability and records failures without executing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-native-actions-'))
  try {
    let runs = 0
    let probes = 0
    const manager = new ActionManager({ auditFile: join(dir, 'audit.jsonl'), platform: 'win32', runner: async () => { runs++ }, commandAvailable: async command => { assert.equal(command, 'powershell.exe'); probes++; return false } })
    const action = manager.propose({ kind: 'open-url', target: hostileUrl })
    assert.equal(probes, 0)
    await assert.rejects(manager.approve(action.id), /缺少 powershell/)
    assert.equal(action.status, 'failed')
    assert.equal(runs, 0)
    assert.equal(probes, 1)
    assert.match(await readFile(join(dir, 'audit.jsonl'), 'utf8'), /failed/)
    await assert.rejects(manager.approve(action.id), /不能重复/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('Windows approval passes target data to execution only after consent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-native-approval-'))
  try {
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = []
    const manager = new ActionManager({ auditFile: join(dir, 'audit.jsonl'), platform: 'win32', runner: async (command, args, env) => { calls.push({ command, args, env }) } })
    const action = manager.propose({ kind: 'open-url', target: hostileUrl })
    assert.equal(calls.length, 0)
    await manager.approve(action.id)
    assert.equal(action.status, 'executed')
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0], actionExecution('open-url', hostileUrl, 'win32'))
    await assert.rejects(manager.approve(action.id), /不能重复/)
    assert.equal(calls.length, 1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('macOS notification script receives hostile text only through argv', () => {
  const title = '-title " & do shell script "touch /tmp/pwn"'
  const body = '中文\n"; $(calc.exe) \\ `whoami`'
  const execution = notificationExecution(title, body, 'darwin')
  assert.equal(execution.command, '/usr/bin/osascript')
  assert.deepEqual(execution.args.slice(2), ['--', title, body])
  assert.equal(execution.args[1]!.includes(title), false)
  assert.match(execution.args[1]!, /item 2 of argv/)
  assert.equal(notificationExecution('t', 'a'.repeat(501), 'darwin').args[4]!.length, 500)
  assert.deepEqual(notificationExecution('--help', 'body', 'linux').args.slice(-3), ['--', '--help', 'body'])
})

test('Windows notifications explicitly report unsupported without spawning', () => {
  const warnings: unknown[] = []
  const logger: Logger = { debug() {}, info() {}, error() {}, child() { return logger }, warn(_message, meta) { warnings.push(meta) } }
  const notifier = new Notifier(logger, undefined, true, { platform: 'win32', spawn: (() => { throw new Error('must not spawn') }) as never })
  notifier.send('Reminder', 'Hello')
  assert.match(JSON.stringify(warnings), /Windows.*toast/)
  assert.equal(JSON.stringify(warnings).includes('must not spawn'), false)
})
