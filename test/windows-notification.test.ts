import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { notificationExecution, Notifier } from '../src/notify.ts'
import { POWERSHELL_TOAST, POWERSHELL_TOAST_XML, POWERSHELL_TOAST_TYPES, toastText, WINDOWS_AUMID, windowsNotificationAvailability } from '../src/windows-notification.ts'
import type { Logger } from '../src/logger.ts'

const identity = { available: true, command: 'powershell.exe', shortcut: 'owned.lnk', reason: 'fixture' }
const hostile = '中文 😀 <&> "\' $(throw 1); `whoami` \n </text><actions/>'

test('Windows toast uses fixed code, env text, own identity and no activation', () => {
  const execution = notificationExecution(hostile, hostile, 'win32', 'untrusted-command', identity)
  assert.equal(execution.command, 'powershell.exe')
  assert.equal(Buffer.from(execution.args[4]!, 'base64').toString('utf16le'), POWERSHELL_TOAST)
  assert.equal(execution.env?.JARVIS_TOAST_TITLE, hostile)
  assert.equal(execution.env?.JARVIS_TOAST_BODY, hostile)
  assert.ok(!execution.args.join(' ').includes(hostile))
  assert.match(POWERSHELL_TOAST, /CreateToastNotifier\('org.jarvis.portable'\)/)
  assert.ok(!POWERSHELL_TOAST.includes('<actions'))
  assert.ok(!POWERSHELL_TOAST.includes('JarvisIdentity.Set(instance)'))
  assert.match(POWERSHELL_TOAST, /JarvisToastIdentity\]::Check/)
  assert.equal(toastText('a\0\u0001\ud800b\udfff\ufffe\uffff\n😀', 10), 'ab\n😀')
  assert.equal(toastText('😀'.repeat(121), 120), '😀'.repeat(120))
  assert.equal(notificationExecution('x'.repeat(121), '😀'.repeat(501), 'win32', undefined, identity).env?.JARVIS_TOAST_BODY, '😀'.repeat(500))
})

test('Windows notification failures omit payload; execution is hidden, bounded, shell-free and opt-out is inert', () => {
  const warnings: unknown[] = []
  const logger: Logger = { debug() {}, info() {}, error() {}, child() { return logger }, warn(_message, meta) { warnings.push(meta) } }
  let calls = 0
  const runtime = { platform: 'win32' as const, windowsIdentity: () => identity, spawn: ((_command: string, _args: string[], options: Record<string, unknown>) => {
    calls++
    assert.equal(options.shell, false)
    assert.equal(options.windowsHide, true)
    assert.equal(options.timeout, 15000)
    assert.equal(options.stdio, 'ignore')
    const child = new EventEmitter() as EventEmitter & { unref(): void }
    child.unref = () => { child.emit('error', new Error(hostile)); child.emit('exit', 1) }
    return child
  }) as never }
  new Notifier(logger, undefined, false, runtime).send(hostile, hostile)
  assert.equal(calls, 0)
  new Notifier(logger, undefined, true, runtime).send(hostile, hostile)
  assert.equal(calls, 1)
  assert.equal(warnings.length, 2)
  assert.ok(!JSON.stringify(warnings).includes('whoami'))
})

test('discovery requires own receipt, matching shortcut hash and PowerShell without executing', async () => {
  const temporaryRoot = await realpath(tmpdir())
  const temp = await mkdtemp(join(temporaryRoot, 'jarvis-toast-'))
  try {
    const env = { SystemRoot: join(temp, 'windows'), APPDATA: join(temp, 'roaming'), LOCALAPPDATA: join(temp, 'local') }
    const command = join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const shortcut = join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Jarvis.lnk')
    const state = join(env.LOCALAPPDATA, 'Jarvis', 'native-install.json')
    for (const file of [command, shortcut, state]) await mkdir(join(file, '..'), { recursive: true })
    await writeFile(command, 'not executed')
    await writeFile(shortcut, 'fixture link')
    assert.equal(windowsNotificationAvailability(env).available, false)
    const receipt = { schemaVersion: 1, platform: 'win32', notificationAumid: WINDOWS_AUMID, files: [{ path: shortcut, sha256: createHash('sha256').update('fixture link').digest('hex') }] }
    await writeFile(state, JSON.stringify(receipt))
    assert.equal(windowsNotificationAvailability(env).available, true)
    await writeFile(shortcut, 'changed')
    assert.equal(windowsNotificationAvailability(env).available, false)
  } finally {
    assert.ok(temp.startsWith(join(temporaryRoot, 'jarvis-toast-')))
    await rm(temp, { recursive: true, force: true })
  }
})

test('native Windows serializes production WinRT XML safely without sending a notification', { skip: process.platform !== 'win32' }, t => {
  const title = toastText(hostile + '\0\ud800', 120)
  const body = toastText(hostile + '😀'.repeat(501), 500)
  const declarations = POWERSHELL_TOAST.split("Add-Type -TypeDefinition @'\n")[1]!.split("\n'@")[0]!
  const script = `$ErrorActionPreference = 'Stop'
$env:PSModulePath = $PSHOME + '\\Modules'
Add-Type -TypeDefinition @'
${declarations}
'@
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
${POWERSHELL_TOAST_XML}
${POWERSHELL_TOAST_TYPES}
if ([int][Windows.UI.Notifications.NotificationSetting]::Enabled -ne 0) { throw 'Unexpected enum' }
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
if ($null -eq $toast) { throw 'Toast construction failed' }
@{ xml=$xml.GetXml(); title=$texts.Item(0).InnerText; body=$texts.Item(1).InnerText; texts=$texts.Length; actions=$xml.GetElementsByTagName('actions').Length } | ConvertTo-Json -Compress
`
  const output = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', env: { ...process.env, JARVIS_TOAST_TITLE: title, JARVIS_TOAST_BODY: body }, timeout: 15000, windowsHide: true, shell: false })
  const result = JSON.parse(output)
  assert.equal(result.title, title)
  assert.equal(result.body, body)
  assert.equal(result.texts, 2)
  assert.equal(result.actions, 0)
  assert.match(result.xml, /&lt;/)
  t.diagnostic('Production WinRT XML serialization verified. Toast delivery probe NOT RUN: no notification sent; hosted-runner banner delivery/permission remains unverified.')
})
