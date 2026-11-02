import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config.ts'
import { loadExternalConfig } from '../src/external-config.ts'
import { ensurePrivateDataDirectory } from '../src/private-directory.ts'

async function fixture(run: (dir: string, file: string) => void) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jarvis-external-config-')))
  const saved = { ...process.env }
  try {
    if (process.platform === 'win32') await ensurePrivateDataDirectory(dir)
    const file = join(dir, 'config.env')
    writeFileSync(file, `JARVIS_DATA_DIR=${join(dir, 'data')}\n`, { mode: 0o600 })
    run(dir, file)
  } finally {
    process.env = saved
    // dir is the canonical unique test directory created above.
    rmSync(dir, { recursive: true, force: true })
  }
}

test('explicit config uses file plus defaults, preserves internal/generic environment, and is cwd independent', async () => {
  await fixture((dir, file) => {
    writeFileSync(file, `# private config\nJARVIS_DATA_DIR="${join(dir, 'data')}"\nJARVIS_PORT=4567\nJARVIS_CALENDAR_ICS='${join(dir, 'calendar.ics')}'\nJARVIS_AUTH_TOKEN=secret-value\n`)
    process.env.JARVIS_CONFIG_FILE = file
    process.env.JARVIS_PORT = '9999'
    process.env.JARVIS_HOST = '0.0.0.0'
    process.env.JARVIS_ALLOWED_HOSTS = 'inherited.invalid'
    process.env.JARVIS_APP_INTERNAL = 'keep'
    const originalPath = process.env.PATH
    const config = loadConfig()
    assert.equal(config.port, 4567)
    assert.equal(config.host, '127.0.0.1')
    assert.equal(config.dataDir, join(dir, 'data'))
    assert.equal(config.authToken, 'secret-value')
    assert.equal(process.env.JARVIS_CALENDAR_ICS, join(dir, 'calendar.ics'))
    assert.equal(process.env.JARVIS_ALLOWED_HOSTS, undefined)
    assert.equal(process.env.JARVIS_APP_INTERNAL, 'keep')
    assert.equal(process.env.PATH, originalPath)
    assert.equal(process.env.JARVIS_CONFIG_FILE, file)
    const previousCwd = process.cwd()
    try {
      process.chdir(dir)
      assert.deepEqual(loadConfig(), config)
    } finally { process.chdir(previousCwd) }
  })
})

test('preflight reads only and default loading retains inherited settings without selector', async () => {
  await fixture((dir, file) => {
    const before = { ...process.env }
    const stat = lstatSync(file)
    assert.equal(loadExternalConfig(file).JARVIS_DATA_DIR, join(dir, 'data'))
    assert.deepEqual(process.env, before)
    assert.equal(lstatSync(file).mode, stat.mode)
    assert.equal(lstatSync(file).mtimeMs, stat.mtimeMs)
    delete process.env.JARVIS_CONFIG_FILE
    process.env.JARVIS_PORT = '4568'
    process.env.JARVIS_HOST = '127.0.0.1'
    assert.equal(loadConfig().port, 4568)
  })
})

test('explicit selector rejects missing, relative, noncanonical, directory and empty paths without leaking paths', async () => {
  await fixture((dir, file) => {
    for (const selected of ['', 'config.env', join(dir, 'missing-private-secret'), dir, `${dir}/./config.env`]) {
      process.env.JARVIS_CONFIG_FILE = selected
      assert.throws(() => loadConfig(), error => error instanceof Error && /JARVIS_CONFIG_FILE/.test(error.message) && !error.message.includes(dir))
    }
    assert.doesNotThrow(() => loadExternalConfig(file))
  })
})

test('external files reject unknown keys, malformed records, duplicates and relative path settings atomically', async () => {
  await fixture((dir, file) => {
    const data = `JARVIS_DATA_DIR=${join(dir, 'data')}\n`
    const bad = [
      'NODE_OPTIONS=--require=secret-value', 'PATH=secret-value', 'QWEATHER_API_KEY=secret-value',
      'JARVIS_CONFIG_FILE=/secret-value', 'JARVIS_APP_INTERNAL=secret-value', 'JARVIS_UNKNOWN=secret-value',
      'broken-secret-value', 'JARVIS_PORT=1\nJARVIS_PORT=2', 'JARVIS_PORT="secret-value',
      'JARVIS_WEB_DIR=relative', 'JARVIS_PYTHON=python3', 'JARVIS_TLS_CERT=~/cert',
      'JARVIS_CALENDAR_ICS=https://example.com/private', 'JARVIS_EDGE_TTS_BIN=./edge',
      'JARVIS_AUTH_TOKEN=secret\0value',
    ]
    process.env.JARVIS_CONFIG_FILE = file
    process.env.JARVIS_PORT = '6789'
    for (const record of bad) {
      writeFileSync(file, data + record)
      assert.throws(() => loadConfig(), error => error instanceof Error && !error.message.includes('secret-value'))
      assert.equal(process.env.JARVIS_PORT, '6789')
    }
    for (const contents of ['', 'JARVIS_DATA_DIR=\n', 'JARVIS_DATA_DIR=relative\n']) {
      writeFileSync(file, contents)
      assert.throws(() => loadExternalConfig(file))
    }
  })
})

test('bounded read rejects oversized and invalid UTF-8 files but accepts exactly 64 KiB', async () => {
  await fixture((dir, file) => {
    const prefix = `JARVIS_DATA_DIR=${join(dir, 'data')}\n#`
    const exact = prefix + 'x'.repeat(64 * 1024 - Buffer.byteLength(prefix))
    writeFileSync(file, exact)
    assert.doesNotThrow(() => loadExternalConfig(file))
    writeFileSync(file, exact + 'x')
    assert.throws(() => loadExternalConfig(file))
    writeFileSync(file, Buffer.concat([Buffer.from(prefix), Buffer.from([0xc3, 0x28])]))
    assert.throws(() => loadExternalConfig(file))
  })
})

test('file hard links are rejected', async () => {
  await fixture((dir, file) => {
    linkSync(file, join(dir, 'other-link'))
    assert.throws(() => loadExternalConfig(file))
  })
})

test('symlink files and ancestors are rejected', { skip: process.platform === 'win32' }, async () => {
  await fixture((dir, file) => {
    const link = join(dir, 'link.env')
    symlinkSync(file, link)
    assert.throws(() => loadExternalConfig(link))
    const nested = join(dir, 'nested')
    mkdirSync(nested, { mode: 0o700 })
    writeFileSync(join(nested, 'config.env'), readFileSync(file), { mode: 0o600 })
    symlinkSync(nested, join(dir, 'alias'))
    assert.throws(() => loadExternalConfig(join(dir, 'alias', 'config.env')))
  })
})

test('POSIX file and immediate parent require owner-only permissions, never repaired', { skip: process.platform === 'win32' }, async () => {
  await fixture((dir, file) => {
    for (const mode of [0o640, 0o604, 0o660]) {
      chmodSync(file, mode)
      assert.throws(() => loadExternalConfig(file))
      assert.equal(lstatSync(file).mode & 0o777, mode)
    }
    chmodSync(file, 0o400)
    assert.doesNotThrow(() => loadExternalConfig(file))
    chmodSync(dir, 0o750)
    assert.throws(() => loadExternalConfig(file))
    assert.equal(lstatSync(dir).mode & 0o777, 0o750)
  })
})

// Fixed script and native executable: test paths travel only in the environment.
function windowsAcl(target: string, share = false): string {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:PSModulePath = "$PSHOME\Modules"
Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1" -ErrorAction Stop
$p = $env:JARVIS_TEST_ACL_TARGET
if ($env:JARVIS_TEST_ACL_SHARE -eq '1') {
  $acl = Get-Acl -LiteralPath $p
  $everyone = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
  $rule = [Security.AccessControl.FileSystemAccessRule]::new($everyone, [Security.AccessControl.FileSystemRights]::Read, [Security.AccessControl.InheritanceFlags]::None, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $p -AclObject $acl
}
$verified = Get-Acl -LiteralPath $p
[Console]::Write($verified.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All))
`
  assert.ok(process.env.SystemRoot)
  return execFileSync(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], {
    env: { ...process.env, JARVIS_TEST_ACL_TARGET: target, JARVIS_TEST_ACL_SHARE: share ? '1' : '0' },
    encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024,
  })
}

for (const target of ['file', 'parent'] as const) {
  test(`Windows rejects shared ${target} ACL without changing file or parent permissions`, { skip: process.platform !== 'win32' }, async () => {
    await fixture((dir, file) => {
      assert.doesNotThrow(() => loadExternalConfig(file))
      const shared = target === 'file' ? file : dir
      const privateAcl = windowsAcl(shared)
      const sharedAcl = windowsAcl(shared, true)
      assert.notEqual(sharedAcl, privateAcl)
      const beforeFile = windowsAcl(file)
      const beforeParent = windowsAcl(dir)
      assert.throws(() => loadExternalConfig(file), /Invalid JARVIS_CONFIG_FILE/)
      assert.equal(windowsAcl(file), beforeFile)
      assert.equal(windowsAcl(dir), beforeParent)
    })
  })
}

test('configuration validation diagnostics never include supplied values', async () => {
  await fixture((dir, file) => {
    process.env.JARVIS_CONFIG_FILE = file
    for (const setting of ['JARVIS_PORT=private-secret', 'JARVIS_QUIET_START=private-secret']) {
      writeFileSync(file, `JARVIS_DATA_DIR=${join(dir, 'data')}\n${setting}`)
      assert.throws(() => loadConfig(), error => error instanceof Error && !error.message.includes('private-secret'))
    }
  })
})
