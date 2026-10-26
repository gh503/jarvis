import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import type { EventBus } from './events.ts'
import type { Logger } from './logger.ts'

export type ActionKind = 'open-url' | 'open-app'
export type ActionStatus = 'proposed' | 'approved' | 'executed' | 'denied' | 'expired' | 'failed'

export interface ActionRequest {
  id: string
  kind: ActionKind
  target: string
  label: string
  status: ActionStatus
  createdAt: string
  expiresAt: string
  executedAt: string | null
  error: string | null
}

export interface ActionInput {
  kind: ActionKind
  target: string
  label?: string
}

interface AppTarget {
  command: string
  args: string[]
  label: string
}

const APPS: Record<string, AppTarget> = {
  files: { command: 'xdg-open', args: [homedir()], label: '文件管理器' },
  browser: { command: 'google-chrome', args: ['--new-window'], label: '浏览器' },
}

const APP_ALIASES: Array<[RegExp, string]> = [
  [/文件管理器|文件管理|我的文件|文件夹/, 'files'],
  [/浏览器|chrome|谷歌浏览器/, 'browser'],
]

export function isAllowedUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password && value.length <= 2048
  } catch {
    return false
  }
}

export class ActionManager {
  private readonly actions = new Map<string, ActionRequest>()
  private readonly now: () => Date
  private readonly ttlMs: number
  private readonly runner: (command: string, args: string[]) => Promise<void>

  constructor(
    private readonly options: {
      bus?: EventBus
      logger?: Logger
      auditFile: string
      ttlMs?: number
      now?: () => Date
      runner?: (command: string, args: string[]) => Promise<void>
    },
  ) {
    this.now = options.now ?? (() => new Date())
    this.ttlMs = options.ttlMs ?? 60_000
    this.runner = options.runner ?? (async (command, args) => {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, { detached: true, stdio: 'ignore' })
        child.once('spawn', () => {
          child.unref()
          resolve()
        })
        child.once('error', reject)
      })
    })
  }

  propose(input: ActionInput): ActionRequest {
    const target = input.target.trim()
    if (!target) throw new Error('要打开什么？')
    if (input.kind === 'open-url' && !isAllowedUrl(target)) {
      throw new Error('只允许打开 http/https 网页，且链接里不能带用户名或密码。')
    }
    let label = input.label?.trim() ?? ''
    if (input.kind === 'open-app') {
      const app = APPS[target]
      if (!app) throw new Error(`不在允许打开的应用列表里：${target}`)
      label = label || app.label
    } else {
      label = label || target
    }
    const now = this.now()
    const action: ActionRequest = {
      id: randomUUID(),
      kind: input.kind,
      target,
      label,
      status: 'proposed',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      executedAt: null,
      error: null,
    }
    this.actions.set(action.id, action)
    this.options.bus?.emit('action.proposed', { action })
    return action
  }

  proposeText(text: string): ActionRequest {
    const trimmed = text.trim()
    if (!trimmed) throw new Error('要打开什么？')
    const url = trimmed.match(/https?:\/\/[^\s，。]+/i)?.[0]
    if (url) return this.propose({ kind: 'open-url', target: url })
    for (const [pattern, app] of APP_ALIASES) {
      if (pattern.test(trimmed)) return this.propose({ kind: 'open-app', target: app })
    }
    throw new Error('我只支持打开 http/https 网页，或“文件管理器/浏览器”。')
  }

  clear(): void {
    this.actions.clear()
  }

  list(): ActionRequest[] {
    const now = this.now().getTime()
    for (const action of this.actions.values()) {
      if (action.status === 'proposed' && Date.parse(action.expiresAt) <= now) {
        action.status = 'expired'
      }
    }
    return [...this.actions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50)
  }

  get(id: string): ActionRequest | null {
    const action = this.actions.get(id)
    if (!action) return null
    if (action.status === 'proposed' && Date.parse(action.expiresAt) <= this.now().getTime()) {
      action.status = 'expired'
    }
    return action
  }

  async approve(id: string): Promise<ActionRequest> {
    const action = this.get(id)
    if (!action) throw new Error('找不到这条待确认动作。')
    if (action.status === 'expired') throw new Error('这条确认已过期；请重新发起。')
    if (action.status !== 'proposed') throw new Error(`这条动作已经是 ${action.status}，不能重复执行。`)
    action.status = 'approved'
    this.options.bus?.emit('action.approved', { action })
    try {
      if (action.kind === 'open-url') await this.runner('xdg-open', [action.target])
      else {
        const app = APPS[action.target]
        if (!app) throw new Error(`不在允许打开的应用列表里：${action.target}`)
        await this.runner(app.command, app.args)
      }
      action.status = 'executed'
      action.executedAt = this.now().toISOString()
      this.options.bus?.emit('action.executed', { action })
      await this.audit(action, 'executed')
      return action
    } catch (error) {
      action.status = 'failed'
      action.error = error instanceof Error ? error.message : String(error)
      this.options.bus?.emit('action.failed', { action })
      await this.audit(action, 'failed')
      throw error
    }
  }

  deny(id: string): ActionRequest {
    const action = this.get(id)
    if (!action) throw new Error('找不到这条待确认动作。')
    if (action.status !== 'proposed') throw new Error(`这条动作已经是 ${action.status}，不能拒绝。`)
    action.status = 'denied'
    this.options.bus?.emit('action.denied', { action })
    void this.audit(action, 'denied')
    return action
  }

  private async audit(action: ActionRequest, outcome: string): Promise<void> {
    try {
      await mkdir(dirname(this.options.auditFile), { recursive: true, mode: 0o700 })
      await appendFile(
        this.options.auditFile,
        `${JSON.stringify({ at: this.now().toISOString(), outcome, id: action.id, kind: action.kind, target: action.target, status: action.status })}\n`,
        { mode: 0o600 },
      )
    } catch (error) {
      this.options.logger?.warn('action audit failed', { error: String(error) })
    }
  }
}
