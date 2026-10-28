import { spawn } from 'node:child_process'
import type { Logger } from './logger.ts'
import { POWERSHELL_TOAST, toastText, windowsNotificationAvailability } from './windows-notification.ts'
import type { WindowsNotificationAvailability } from './windows-notification.ts'

export interface NotificationExecution {
  command: string
  args: string[]
  env?: NodeJS.ProcessEnv
}

export function notificationExecution(title: string, body: string, platform: NodeJS.Platform = process.platform, command?: string, identity?: WindowsNotificationAvailability): NotificationExecution {
  if (platform === 'win32') {
    const discovery = identity ?? windowsNotificationAvailability()
    if (!discovery.available || !discovery.command || !discovery.shortcut) throw new Error('Windows toast identity or PowerShell unavailable; run explicit native installation')
    return { command: discovery.command, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(POWERSHELL_TOAST, 'utf16le').toString('base64')], env: { JARVIS_TOAST_TITLE: toastText(title, 120), JARVIS_TOAST_BODY: toastText(body, 500), JARVIS_TOAST_SHORTCUT: discovery.shortcut } }
  }
  if (platform === 'darwin') {
    const script = 'on run argv\n display notification (item 2 of argv) with title (item 1 of argv)\nend run'
    return { command: command || '/usr/bin/osascript', args: ['-e', script, '--', title, body.slice(0, 500)] }
  }
  if (platform === 'linux') return { command: command || 'notify-send', args: ['--app-name=Jarvis', '--urgency=normal', '--expire-time=12000', '--', title, body.slice(0, 500)] }
  throw new Error(`当前平台不支持桌面通知：${platform}`)
}

/** Desktop notification is a courtesy, never a delivery guarantee. */
export class Notifier {
  constructor(
    private readonly logger?: Logger,
    private readonly command = process.env.JARVIS_NOTIFY_COMMAND,
    private readonly enabled = process.env.JARVIS_NOTIFY !== '0',
    private readonly runtime: { platform?: NodeJS.Platform; spawn?: typeof spawn; windowsIdentity?: () => WindowsNotificationAvailability } = {},
  ) {}

  send(title: string, body: string): void {
    if (!this.enabled || !title.trim()) return
    try {
      const execution = notificationExecution(title, body, this.runtime.platform, this.command, this.runtime.windowsIdentity?.())
      const child = (this.runtime.spawn ?? spawn)(execution.command, execution.args, {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ...execution.env },
        shell: false,
        windowsHide: true,
        timeout: 15000,
      })
      child.once('error', () => this.logger?.warn('desktop notification failed', { error: 'notification process failed to start or timed out' }))
      child.once('exit', code => {
        if (code !== 0) this.logger?.warn('desktop notification failed', { error: `notification command exited with ${code}` })
      })
      child.unref()
    } catch {
      this.logger?.warn('desktop notification failed', { error: 'notification unavailable (Windows toast requires installed Jarvis identity and PowerShell)' })
    }
  }
}
