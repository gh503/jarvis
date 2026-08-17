import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'

const entrypoint = join(process.cwd(), 'dist', 'memory-main.js')

function run(args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entrypoint, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => resolve({ code, stdout, stderr }))
    child.stdin.end(input)
  })
}

function value(result) {
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stderr, '')
  return JSON.parse(result.stdout)
}

test('manages the complete owner memory lifecycle without content arguments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-memory-cli-'))
  const dataArgs = ['--data-dir', directory]
  try {
    const proposed = value(await run(['propose', '--class', 'profile', ...dataArgs], 'Preferred language is Chinese\n')).item
    assert.equal(proposed.status, 'proposed')
    assert.equal(proposed.content, 'Preferred language is Chinese')

    const pending = value(await run(['list', '--status', 'proposed', ...dataArgs])).items
    assert.deepEqual(pending.map(item => item.id), [proposed.id])
    assert.equal(value(await run(['recall', ...dataArgs])).items.length, 0)
    assert.equal(value(await run(['confirm', '--id', proposed.id, ...dataArgs])).item.status, 'confirmed')
    assert.deepEqual(value(await run(['recall', ...dataArgs])).items.map(item => item.id), [proposed.id])

    const edited = value(await run(['edit', '--id', proposed.id, ...dataArgs], 'Preferred language is Simplified Chinese\n')).item
    assert.equal(edited.supersedesId, proposed.id)
    assert.deepEqual(value(await run(['recall', ...dataArgs])).items.map(item => item.id), [edited.id])

    const rejectedCandidate = value(await run([
      'propose', '--class', 'episodic', '--sensitivity', 'sensitive', '--confidence', '0.7', ...dataArgs,
    ], 'Candidate to reject')).item
    assert.equal(value(await run(['reject', '--id', rejectedCandidate.id, ...dataArgs])).item.status, 'rejected')

    const exportPath = join(directory, 'exports', 'memory.json')
    const exported = value(await run(['export', '--output', exportPath, ...dataArgs]))
    assert.equal(exported.itemCount, 3)
    assert.equal((await stat(exportPath)).mode & 0o777, 0o600)
    assert.deepEqual(JSON.parse(await readFile(exportPath, 'utf8')), JSON.parse(await readFile(join(directory, 'memory.json'), 'utf8')))
    const overwrite = await run(['export', '--output', exportPath, ...dataArgs])
    assert.notEqual(overwrite.code, 0)

    assert.equal(value(await run(['delete', '--id', edited.id, ...dataArgs])).item.id, edited.id)
    assert.deepEqual(value(await run(['recall', ...dataArgs])).items, [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects invalid CLI combinations and bounded stdin without echoing content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-memory-cli-invalid-'))
  const dataArgs = ['--data-dir', directory]
  try {
    const unknown = await run(['unknown', ...dataArgs])
    assert.notEqual(unknown.code, 0)
    assert.match(unknown.stderr, /unknown memory command/)
    await assert.rejects(access(join(directory, 'memory.json')))
    const invalidStatus = await run(['list', '--status', 'private', ...dataArgs])
    assert.notEqual(invalidStatus.code, 0)
    assert.match(invalidStatus.stderr, /status is invalid/)
    const missingId = await run(['confirm', ...dataArgs])
    assert.notEqual(missingId.code, 0)
    assert.match(missingId.stderr, /--id is required/)
    const secret = 'private-value-that-must-not-be-echoed'
    const oversized = await run(['propose', '--class', 'profile', ...dataArgs], secret.repeat(300))
    assert.notEqual(oversized.code, 0)
    assert.match(oversized.stderr, /8192 bytes/)
    assert.doesNotMatch(oversized.stderr, /private-value/)
    const contentOption = await run(['propose', '--class', 'profile', '--content', secret, ...dataArgs])
    assert.notEqual(contentOption.code, 0)
    assert.doesNotMatch(contentOption.stderr, new RegExp(secret))
    await writeFile(join(directory, 'sentinel'), 'unchanged')
    assert.equal(await readFile(join(directory, 'sentinel'), 'utf8'), 'unchanged')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
