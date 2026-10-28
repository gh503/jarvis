import { spawn } from 'node:child_process'
import type { Logger } from './logger.ts'

export interface NotificationExecution {
  command: string
  args: string[]
}

export function notificationExecution(title: string, body: string, platform: NodeJS.Platform = process.platform, command?: string): NotificationExecution {
  if (platform === 'darwin') {
    const script = 'on run argv\n display notification (item 2 of argv) with title (item 1 of argv)\nend run'
    return { command: command || '/usr/bin/osascript', args: ['-e', script, '--', title, body.slice(0, 500)] }
  }
  if (platform === 'linux') return { command: command || 'notify-send', args: ['--app-name=Jarvis', '--urgency=normal', '--expire-time=12000', '--', title, body.slice(0, 500)] }
  throw new Error(platform === 'win32'
    ? 'Windows 桌面通知不可用：尚未配置原生 toast 应用身份和通知通道。'
    : `当前平台不支持桌面通知：${platform}`)
}

/** Desktop notification is a courtesy, never a delivery guarantee. */
export class Notifier {
  constructor(
    private readonly logger?: Logger,
    private readonly command = process.env.JARVIS_NOTIFY_COMMAND,
    private readonly enabled = process.env.JARVIS_NOTIFY !== '0',
    private readonly runtime: { platform?: NodeJS.Platform; spawn?: typeof spawn } = {},
  ) {}

  send(title: string, body: string): void {
    if (!this.enabled || !title.trim()) return
    try {
      const execution = notificationExecution(title, body, this.runtime.platform, this.command)
      const child = (this.runtime.spawn ?? spawn)(execution.command, execution.args, {
        detached: true,
        stdio: 'ignore',
        env: process.env,
      })
      child.once('error', error => this.logger?.warn('desktop notification failed', { error: error.message }))
      child.once('exit', code => {
        if (code !== 0) this.logger?.warn('desktop notification failed', { error: `notification command exited with ${code}` })
      })
      child.unref()
    } catch (error) {
      this.logger?.warn('desktop notification failed', { error: String(error) })
    }
  }
}
