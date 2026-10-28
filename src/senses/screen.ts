import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { JarvisConfig } from '../config.ts'
import type { Logger } from '../logger.ts'
import { runProcess } from '../util/process.ts'
import { fileExists } from '../voice/media.ts'

export interface Capture {
  path: string
  source: 'portal' | 'x11' | 'camera'
  bytes: number
  windowTitle?: string
  titleKnown?: boolean
}

export class ScreenCapture {
  private readonly helper: string

  constructor(
    private readonly config: JarvisConfig,
    private readonly logger?: Logger,
  ) {
    this.helper = join(import.meta.dirname, '..', '..', 'scripts', 'screen_capture.py')
  }

  async activeWindowTitle(): Promise<string> {
    try {
      const result = await runProcess('xdotool', ['getactivewindow', 'getwindowname'], { timeoutMs: 1500 })
      return result.stdout.trim()
    } catch {
      return ''
    }
  }

  isBlocked(title: string): boolean {
    if (!title) return false
    const lower = title.toLowerCase()
    return this.config.screenBlocklist.some(word => lower.includes(word))
  }

  async capture(outputDir: string, timeoutMs = this.config.screenTimeoutMs): Promise<Capture> {
    const title = await this.activeWindowTitle()
    if (this.isBlocked(title)) {
      throw new Error(`当前窗口属于隐私黑名单，已拒绝截屏：${title}`)
    }
    await mkdir(outputDir, { recursive: true, mode: 0o700 })
    const output = join(outputDir, `screen-${Date.now()}.png`)

    try {
      await runProcess(this.config.voice.pythonBin, [this.helper, '--output', output, '--timeout', String(Math.floor(timeoutMs / 1000))], {
        timeoutMs: timeoutMs + 5000,
        maxOutputBytes: 500_000,
      })
      if (!(await fileExists(output))) throw new Error('portal returned no image')
      this.logger?.info('screen captured through portal', { output })
      const stat = await import('node:fs/promises').then(module => module.stat(output))
      return { path: output, source: 'portal', bytes: stat.size, windowTitle: title, titleKnown: Boolean(title) }
    } catch (error) {
      const detail = String(error)
      if (detail.includes('exited with 2') || detail.includes('denied')) {
        throw new Error('你拒绝了屏幕共享；我不会绕过系统门户去截屏。')
      }
      // On a native Wayland session an X11 root capture is normally black.
      // Fail with an actionable message instead of sending the model an empty
      // image and pretending we looked.
      if (process.env.WAYLAND_DISPLAY) {
        throw new Error('屏幕授权未完成或超时。请在系统弹窗里允许共享后重试，或改用文字/摄像头。')
      }
      this.logger?.warn('portal capture failed; trying X11 fallback', { error: detail })
      const captured = await this.captureX11(output)
      return { ...captured, windowTitle: title, titleKnown: Boolean(title) }
    }
  }

  private async captureX11(output: string): Promise<Capture> {
    const display = process.env.DISPLAY
    if (!display) throw new Error('屏幕捕获不可用：没有 Wayland portal，也没有 X11 DISPLAY')
    let size = '1920x1080'
    try {
      const xrandr = await runProcess('xrandr', ['--current'], { timeoutMs: 2000 })
      const match = xrandr.stdout.match(/current\s+(\d+)\s*x\s*(\d+)/)
      if (match) size = `${match[1]}x${match[2]}`
    } catch {
      // Use the conservative default.
    }
    await runProcess(
      this.config.voice.ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'x11grab', '-video_size', size, '-i', display, '-frames:v', '1', output],
      { timeoutMs: 15_000 },
    )
    if (!(await fileExists(output))) throw new Error('X11 screenshot produced no image')
    this.logger?.info('screen captured through X11 fallback', { output })
    const stat = await import('node:fs/promises').then(module => module.stat(output))
    return { path: output, source: 'x11', bytes: stat.size }
  }
}