import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '../util/process.ts'

export async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}

export async function makeTempDir(prefix = 'jarvis-'): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix))
}

export async function removeDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(() => undefined)
}

export async function toWav(ffmpeg: string, input: string, output: string): Promise<void> {
  await runProcess(
    ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', output],
    { timeoutMs: 60_000 },
  )
}

export async function recordWav(arecord: string, output: string, seconds: number): Promise<void> {
  await runProcess(
    arecord,
    ['-q', '-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'wav', '-d', String(Math.max(1, Math.round(seconds))), output],
    { timeoutMs: (seconds + 5) * 1000 },
  )
}