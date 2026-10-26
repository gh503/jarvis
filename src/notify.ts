import { spawn } from 'node:child_process'
import type { Logger } from './logger.ts'

/** Desktop notification is a courtesy, never a delivery guarantee. */
export class Notifier {
  constructor(
    private readonly logger?: Logger,
    private readonly command = process.env.JARVIS_NOTIFY_COMMAND || 'notify-send',
    private readonly enabled = process.env.JARVIS_NOTIFY !== '0',
  ) {}

  send(title: string, body: string): void {
    if (!this.enabled || !title.trim()) return
    try {
      const child = spawn(this.command, ['--app-name=Jarvis', '--urgency=normal', '--expire-time=12000', title, body.slice(0, 500)], {
        detached: true,
        stdio: 'ignore',
        env: process.env,
      })
      child.once('error', error => this.logger?.warn('desktop notification failed', { error: error.message }))
      child.unref()
    } catch (error) {
      this.logger?.warn('desktop notification failed', { error: String(error) })
    }
  }
}
