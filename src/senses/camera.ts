import { access, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { JarvisConfig } from '../config.ts'
import type { Logger } from '../logger.ts'
import { runProcess } from '../util/process.ts'
import { fileExists } from '../voice/media.ts'
import type { Capture } from './screen.ts'

export class CameraCapture {
  constructor(
    private readonly config: JarvisConfig,
    private readonly logger?: Logger,
  ) {}

  async capture(outputDir: string, device = process.env.JARVIS_CAMERA_DEVICE || '/dev/video0'): Promise<Capture> {
    try {
      await access(device)
    } catch {
      throw new Error(`摄像头不可用：${device} 不存在。可以用 JARVIS_CAMERA_DEVICE 指定设备。`)
    }
    await mkdir(outputDir, { recursive: true, mode: 0o700 })
    const output = join(outputDir, `camera-${Date.now()}.jpg`)
    await runProcess(
      this.config.voice.ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'v4l2',
        '-i',
        device,
        '-frames:v',
        '1',
        '-vf',
        'scale=1280:-2',
        '-q:v',
        '3',
        output,
      ],
      { timeoutMs: 15_000 },
    )
    if (!(await fileExists(output))) throw new Error('摄像头没有返回画面')
    const stat = await import('node:fs/promises').then(module => module.stat(output))
    this.logger?.info('camera frame captured', { bytes: stat.size })
    return { path: output, source: 'camera', bytes: stat.size }
  }
}