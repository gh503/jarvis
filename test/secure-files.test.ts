import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SecureFiles } from '../src/secure-files.ts'

test('sensitive files are encrypted at rest and decrypt losslessly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-secure-'))
  try {
    const secure = new SecureFiles(dir)
    const file = join(dir, 'capture.png')
    await writeFile(file, Buffer.from('PNG-ish plaintext with private content'))
    assert.equal(secure.isEncrypted(file), false)
    await secure.encryptFile(file)
    assert.equal(secure.isEncrypted(file), true)
    const raw = await readFile(file)
    assert.equal(raw.subarray(0, 12).toString(), 'JARVIS-ENC1\n')
    assert.doesNotMatch(raw.toString('latin1'), /private content/)
    assert.equal(secure.decryptFile(file).toString(), 'PNG-ish plaintext with private content')
    assert.equal((await stat(join(dir, 'secret.key'))).mode & 0o777, 0o600)
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    await secure.encryptFile(file)
    assert.equal(secure.decryptFile(file).toString(), 'PNG-ish plaintext with private content')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('tampered ciphertext is rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-secure-tamper-'))
  try {
    const secure = new SecureFiles(dir)
    const file = join(dir, 'audio.wav')
    await writeFile(file, Buffer.from('audio bytes'))
    await secure.encryptFile(file)
    const raw = await readFile(file)
    raw[raw.length - 1] ^= 0xff
    await writeFile(file, raw)
    assert.throws(() => secure.decryptFile(file))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
