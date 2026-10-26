import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Logger } from '../logger.ts'
import { commandExists, runProcess } from '../util/process.ts'
import { makeTempDir, toWav } from './media.ts'
import type { Synthesizer } from './tts.ts'

/**
 * Edge TTS is not an HTTP provider: it is a local command that talks to
 * Microsoft's speech service. It is optional and has no SLA, so failures are
 * surfaced instead of being hidden behind a generic "remote TTS failed".
 */
export class EdgeSynthesizer implements Synthesizer {
  constructor(private readonly options: {
    voice: string
    ffmpeg: string
    bin?: string
    logger?: Logger
  }) {}

  private bin(): string {
    return this.options.bin || process.env.JARVIS_EDGE_TTS_BIN || 'edge-tts'
  }

  async available(): Promise<boolean> {
    return await commandExists(this.bin())
  }

  async synthesize(text: string, output: string): Promise<void> {
    const clean = text.replace(/\s+/g, ' ').trim()
    if (!clean) throw new Error('cannot synthesize empty text')
    if (!this.options.voice) throw new Error('Edge TTS 还没有配置音色')
    if (!(await this.available())) {
      throw new Error('未找到 edge-tts；请先安装：python3 -m pip install --user edge-tts')
    }
    const dir = await makeTempDir('jarvis-edge-tts-')
    const mp3 = join(dir, 'speech.mp3')
    try {
      await mkdir(dirname(output), { recursive: true, mode: 0o700 })
      await runProcess(this.bin(), [
        '--voice', this.options.voice,
        '--text', clean.slice(0, 4000),
        '--write-media', mp3,
      ], { timeoutMs: 120_000, maxOutputBytes: 500_000 })
      await toWav(this.options.ffmpeg, mp3, output)
      this.options.logger?.debug('edge tts synthesized', { chars: clean.length, voice: this.options.voice })
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async warmup(): Promise<void> {
    // Do not make a network request at process start.
  }

  async reconfigure(): Promise<void> {}

  async close(): Promise<void> {}
}
