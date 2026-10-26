import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PiperSynthesizer } from '../src/voice/tts.ts'

// A missing/broken Piper binary used to emit an unhandled EPIPE on child
// stdin and kill the whole Jarvis process during startup warm-up.
test('a broken Piper binary rejects synthesis instead of crashing the process', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-piper-broken-'))
  const piper = new PiperSynthesizer({ piperBin: '/bin/false', voice: '/bin/false' })
  try {
    await assert.rejects(() => piper.warmup())
  } finally {
    await piper.close().catch(() => undefined)
    await rm(dir, { recursive: true, force: true })
  }
})
