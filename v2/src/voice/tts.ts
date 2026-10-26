import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Logger } from '../logger.ts'
import { runProcess } from '../util/process.ts'
import { fileExists } from './media.ts'

export interface SynthesizerOptions {
  piperBin: string
  voice: string
  logger?: Logger
}

export class PiperSynthesizer {
  constructor(private readonly options: SynthesizerOptions) {}

  async available(): Promise<boolean> {
    return (await fileExists(this.options.piperBin)) && (await fileExists(this.options.voice))
  }

  async synthesize(text: string, output: string): Promise<void> {
    const clean = text.replace(/\s+/g, ' ').trim()
    if (!clean) throw new Error('cannot synthesize empty text')
    await mkdir(dirname(output), { recursive: true, mode: 0o700 })
    await runProcess(
      this.options.piperBin,
      ['--model', this.options.voice, '--output_file', output, '--quiet'],
      { input: `${clean.slice(0, 4000)}\n`, timeoutMs: 120_000, maxOutputBytes: 500_000 },
    )
    if (!(await fileExists(output))) throw new Error('Piper produced no audio')
    this.options.logger?.debug('tts synthesized', { chars: clean.length, output })
  }
}