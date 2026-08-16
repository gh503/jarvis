import { deleteDeviceState, readDeviceState, writeDeviceState } from './device-store.js?v=8'

const CACHE_KEY = 'conversation-cache'
const CURSOR_KEY = 'event-cursor'
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{22}\.[0-9]+$/
const MAX_MESSAGES = 50
const MAX_ACTIVITY = 30
const MAX_EVENT_CHARS = 64 * 1024

function validSummary(value) {
  return value !== null && typeof value === 'object' && ID_PATTERN.test(value.id)
    && (value.title === null || typeof value.title === 'string')
    && Number.isFinite(value.updatedAt) && typeof value.running === 'boolean' && typeof value.blank === 'boolean'
}

function validMessage(value) {
  return value !== null && typeof value === 'object' && typeof value.id === 'string' && value.id.length > 0
    && Number.isSafeInteger(value.sequence) && value.sequence >= 0 && Number.isFinite(value.createdAt)
    && (value.role === 'user' || value.role === 'assistant') && typeof value.text === 'string' && value.text.length > 0
}

function validApproval(value) {
  if (value === null || typeof value !== 'object' || !ID_PATTERN.test(value.id)
    || !ID_PATTERN.test(value.conversationId) || typeof value.toolName !== 'string'
    || (value.callId !== null && !ID_PATTERN.test(value.callId)) || value.risk !== 'high'
    || typeof value.canAllow !== 'boolean') return false
  if (value.action === 'open_app') {
    return typeof value.target === 'string' && value.target.length > 0
      && value.arguments !== null && typeof value.arguments === 'object'
      && value.arguments.application === value.target
      && typeof value.digest === 'string' && /^[0-9a-f]{64}$/.test(value.digest)
      && Number.isFinite(value.requestedAt) && Number.isFinite(value.expiresAt)
      && value.expiresAt > value.requestedAt
      && (value.blockReason === null || value.blockReason === 'expired')
  }
  return value.action === 'unsupported' && value.target === null && value.arguments === null
    && value.digest === null && value.requestedAt === null && value.expiresAt === null
    && value.canAllow === false
    && (value.blockReason === 'evidence_missing' || value.blockReason === 'unsupported_action')
}

function parseConversationList(value) {
  if (!Array.isArray(value?.conversations) || !value.conversations.every(validSummary)) {
    throw new Error('Gateway 返回了无效对话列表')
  }
  return value.conversations.slice().sort((left, right) => right.updatedAt - left.updatedAt)
}

function parseHistory(value) {
  if (!Array.isArray(value?.messages) || !value.messages.every(validMessage)
    || typeof value.hasMore !== 'boolean'
    || (value.nextBeforeSequence !== null && (!Number.isSafeInteger(value.nextBeforeSequence) || value.nextBeforeSequence < 0))) {
    throw new Error('Gateway 返回了无效对话记录')
  }
  const messages = value.messages.slice().sort((left, right) => left.sequence - right.sequence)
  if (new Set(messages.map(message => message.id)).size !== messages.length) {
    throw new Error('Gateway 返回了重复消息')
  }
  return { messages, hasMore: value.hasMore }
}

function parseApprovalList(value) {
  if (!Array.isArray(value?.approvals) || !value.approvals.every(validApproval)
    || new Set(value.approvals.map(approval => approval.id)).size !== value.approvals.length) {
    throw new Error('Gateway 返回了无效审批列表')
  }
  return value.approvals.slice().sort((left, right) => (right.requestedAt ?? 0) - (left.requestedAt ?? 0))
}

function parseCache(value) {
  if (value?.version !== 1 || !Array.isArray(value.conversations) || !value.conversations.every(validSummary)
    || (value.selectedId !== null && !ID_PATTERN.test(value.selectedId))
    || !Array.isArray(value.messages) || !value.messages.every(validMessage) || !Number.isFinite(value.cachedAt)) return undefined
  if (new Set(value.conversations.map(item => item.id)).size !== value.conversations.length
    || new Set(value.messages.map(item => item.id)).size !== value.messages.length) return undefined
  const selectedId = value.selectedId !== null && value.conversations.some(item => item.id === value.selectedId)
    ? value.selectedId
    : null
  return {
    conversations: value.conversations.slice(0, 100),
    selectedId,
    messages: selectedId === null ? [] : value.messages.slice(-MAX_MESSAGES),
    cachedAt: value.cachedAt,
  }
}

function messageForError(error, fallback) {
  return error instanceof Error ? error.message : fallback
}

function eventDescription(event) {
  if (event.type === 'conversation.created') return '新对话已创建'
  if (event.type === 'conversation.removed') return '对话已移除'
  if (event.type === 'conversation.status') return event.running ? 'Jarvis 正在回复' : 'Jarvis 已完成回复'
  if (event.type === 'conversation.message.committed') return event.message.role === 'assistant' ? '收到 Jarvis 回复' : '消息已提交'
  if (event.type === 'conversation.error') return '对话执行失败'
  if (event.type === 'approval.pending') return '收到待审批操作'
  if (event.type === 'approval.resolved') return event.outcome === 'allowed-once' ? '操作已允许一次' : '操作未获允许'
  return '正在重新同步对话'
}

export class ConversationsClient {
  constructor(pairing, onState, options = {}) {
    this.pairing = pairing
    this.onState = onState
    this.socketFactory = options.socketFactory ?? (url => new WebSocket(url))
    this.locationValue = options.location ?? window.location
    this.setTimeoutValue = options.setTimeout ?? ((callback, delay) => window.setTimeout(callback, delay))
    this.clearTimeoutValue = options.clearTimeout ?? (timer => window.clearTimeout(timer))
    this.randomUUID = options.randomUUID ?? (() => crypto.randomUUID())
    this.store = options.store ?? {
      read: readDeviceState,
      write: writeDeviceState,
      delete: deleteDeviceState,
    }
    this.active = false
    this.online = true
    this.loading = false
    this.sending = false
    this.conversations = []
    this.selectedId = null
    this.messages = []
    this.activity = []
    this.approvals = []
    this.approvalBusyId = null
    this.approvalDecisionKeys = new Map()
    this.approvalSubmittedIds = new Set()
    this.cachedAt = undefined
    this.socket = undefined
    this.reconnectTimer = undefined
    this.forceRenewSession = false
  }

  async start() {
    if (this.active) return
    this.active = true
    let cached
    try {
      cached = parseCache(await this.store.read(CACHE_KEY))
    } catch (error) {
      this.active = false
      this.emit('error', messageForError(error, '无法读取本地对话快照'))
      return
    }
    if (cached !== undefined) {
      this.conversations = cached.conversations
      this.selectedId = cached.selectedId
      this.messages = cached.messages
      this.cachedAt = cached.cachedAt
      this.emit('stale')
    } else {
      this.emit('loading')
    }
    if (!this.online) return
    await this.refresh()
    if (this.active) void this.connectEvents()
  }

  stop(reason = 'disabled') {
    this.active = false
    this.loading = false
    this.sending = false
    this.approvals = []
    this.approvalBusyId = null
    this.approvalDecisionKeys.clear()
    this.approvalSubmittedIds.clear()
    this.clearReconnect()
    if (this.socket !== undefined) {
      const socket = this.socket
      this.socket = undefined
      socket.close(1000, 'client suspended')
    }
    this.emit(this.conversations.length > 0 ? 'stale' : reason)
  }

  setOnline(online) {
    this.online = online
    if (!online) {
      this.approvals = []
      this.approvalBusyId = null
      this.approvalDecisionKeys.clear()
      this.approvalSubmittedIds.clear()
      this.clearReconnect()
      if (this.socket !== undefined) {
        const socket = this.socket
        this.socket = undefined
        socket.close(1000, 'offline')
      }
      if (this.active) this.emit('stale')
      return
    }
    if (this.active) {
      void this.refresh().then(() => this.connectEvents())
    }
  }

  async refresh() {
    if (!this.active || !this.online || this.loading) return false
    this.loading = true
    this.emit(this.conversations.length > 0 ? 'refreshing' : 'loading')
    try {
      const [response, approvalsResponse] = await Promise.all([
        this.pairing.authenticatedRequest('/v1/conversations'),
        this.pairing.authenticatedRequest('/v1/approvals'),
      ])
      if (!response.ok) throw new Error(`无法读取对话 (${response.status})`)
      if (!approvalsResponse.ok) throw new Error(`无法读取审批 (${approvalsResponse.status})`)
      this.conversations = parseConversationList(response.value)
      this.approvals = parseApprovalList(approvalsResponse.value)
      const currentApprovalIds = new Set(this.approvals.map(approval => approval.id))
      for (const approvalId of this.approvalSubmittedIds) {
        if (!currentApprovalIds.has(approvalId)) this.approvalSubmittedIds.delete(approvalId)
      }
      if (this.selectedId === null || !this.conversations.some(item => item.id === this.selectedId)) {
        this.selectedId = this.conversations[0]?.id ?? null
      }
      await this.loadSelected()
      this.cachedAt = Date.now()
      await this.persistCache()
      this.emit('ready')
      return true
    } catch (error) {
      this.approvals = []
      this.addActivity('同步失败')
      this.emit(this.conversations.length > 0 ? 'stale' : 'error', messageForError(error, '无法同步对话'))
      return false
    } finally {
      this.loading = false
    }
  }

  async select(conversationId) {
    if (!ID_PATTERN.test(conversationId) || !this.conversations.some(item => item.id === conversationId)) return
    this.selectedId = conversationId
    this.messages = []
    this.emit(this.online ? 'loading' : 'stale')
    if (!this.online) return
    try {
      await this.loadSelected()
      this.cachedAt = Date.now()
      await this.persistCache()
      this.emit('ready')
    } catch (error) {
      this.emit(this.conversations.length > 0 ? 'ready' : 'error', messageForError(error, '无法打开对话'))
    }
  }

  async create() {
    if (!this.active || !this.online || this.sending) return false
    this.sending = true
    this.emit('refreshing')
    let errorMessage
    try {
      const response = await this.pairing.authenticatedRequest('/v1/conversations', { method: 'POST', body: '{}' })
      if (response.status !== 201 || !ID_PATTERN.test(response.value?.conversation?.id)) {
        throw new Error(`无法新建对话 (${response.status})`)
      }
      const id = response.value.conversation.id
      this.selectedId = id
      this.messages = []
      await this.refresh()
      if (!this.conversations.some(item => item.id === id)) {
        this.conversations.unshift({ id, title: null, updatedAt: Date.now(), running: false, blank: true })
      }
      this.selectedId = id
      await this.persistCache()
      this.addActivity('新对话已创建')
    } catch (error) {
      errorMessage = messageForError(error, '无法新建对话')
    } finally {
      this.sending = false
    }
    const phase = !this.active || !this.online
      ? this.conversations.length > 0 ? 'stale' : 'disabled'
      : this.conversations.length > 0 || errorMessage === undefined ? 'ready' : 'error'
    this.emit(phase, errorMessage)
    return errorMessage === undefined
  }

  async send(text) {
    if (!this.active || !this.online || this.sending || this.selectedId === null) return false
    const bytes = new TextEncoder().encode(text).byteLength
    if (text.trim().length === 0 || bytes > 16 * 1024 || text.includes('\0') || text.trimStart().startsWith('/')) {
      this.emit('ready', '消息应为 1 至 16384 字节的普通文本，且不能是斜杠命令')
      return false
    }
    this.sending = true
    this.emit('sending')
    let errorMessage
    try {
      const response = await this.pairing.authenticatedRequest(`/v1/conversations/${encodeURIComponent(this.selectedId)}/messages`, {
        method: 'POST', body: JSON.stringify({ text, mode: 'queue' }),
      })
      if (response.status !== 202 || response.value?.accepted !== true) throw new Error(`消息未被接受 (${response.status})`)
      this.addActivity('消息已发送')
      await this.loadSelected()
      this.cachedAt = Date.now()
      await this.persistCache()
    } catch (error) {
      errorMessage = messageForError(error, '消息发送失败')
    } finally {
      this.sending = false
    }
    this.emit(this.active && this.online ? 'ready' : this.conversations.length > 0 ? 'stale' : 'disabled', errorMessage)
    return errorMessage === undefined
  }

  async decideApproval(approvalId, outcome) {
    if (!this.active || !this.online || this.approvalBusyId !== null
      || (outcome !== 'allowed-once' && outcome !== 'rejected')) return false
    const approval = this.approvals.find(item => item.id === approvalId)
    if (approval === undefined || (outcome === 'allowed-once'
      && (!approval.canAllow || approval.digest === null || approval.expiresAt <= Date.now()))) return false
    this.approvalBusyId = approval.id
    this.emit('sending')
    let errorMessage
    try {
      const decisionKey = `${approval.id}:${outcome}:${approval.digest ?? ''}`
      const idempotencyKey = this.approvalDecisionKeys.get(decisionKey) ?? this.randomUUID()
      this.approvalDecisionKeys.set(decisionKey, idempotencyKey)
      const response = await this.pairing.authenticatedRequest(`/v1/approvals/${encodeURIComponent(approval.id)}/decision`, {
        method: 'POST',
        body: JSON.stringify({ digest: approval.digest, outcome, idempotencyKey }),
      })
      if (response.status !== 202 || response.value?.accepted !== true
        || response.value.approvalId !== approval.id || response.value.outcome !== outcome) {
        throw new Error(`审批未被接受 (${response.status})`)
      }
      this.approvalSubmittedIds.add(approval.id)
      this.addActivity(outcome === 'allowed-once' ? '已允许一次' : '已拒绝操作')
    } catch (error) {
      errorMessage = messageForError(error, '审批提交失败')
    } finally {
      this.approvalBusyId = null
    }
    this.emit(this.active && this.online ? 'ready' : 'stale', errorMessage)
    return errorMessage === undefined
  }

  async cancelApproval(approvalId) {
    if (!this.active || !this.online || this.approvalBusyId !== null) return false
    const approval = this.approvals.find(item => item.id === approvalId)
    if (approval === undefined) return false
    this.approvalBusyId = approval.id
    this.emit('sending')
    let errorMessage
    try {
      const response = await this.pairing.authenticatedRequest(
        `/v1/conversations/${encodeURIComponent(approval.conversationId)}/cancel`,
        { method: 'POST', body: '{}' },
      )
      if (!response.ok || response.value?.accepted !== true) throw new Error(`无法取消本轮 (${response.status})`)
      this.addActivity('已取消请求本轮')
    } catch (error) {
      errorMessage = messageForError(error, '取消本轮失败')
    } finally {
      this.approvalBusyId = null
    }
    this.emit(this.active && this.online ? 'ready' : 'stale', errorMessage)
    return errorMessage === undefined
  }

  async loadSelected() {
    if (this.selectedId === null) {
      this.messages = []
      return
    }
    const response = await this.pairing.authenticatedRequest(
      `/v1/conversations/${encodeURIComponent(this.selectedId)}?maxMessages=${MAX_MESSAGES}`,
    )
    if (!response.ok) throw new Error(`无法读取对话记录 (${response.status})`)
    this.messages = parseHistory(response.value).messages
  }

  async connectEvents() {
    if (!this.active || !this.online || this.socket !== undefined) return
    let session
    try {
      session = await this.pairing.accessSession(this.forceRenewSession)
      this.forceRenewSession = false
    } catch {
      this.scheduleReconnect()
      return
    }
    if (!this.active || !this.online || this.socket !== undefined) return
    const url = new URL('/v1/events', this.locationValue.origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    let socket
    try {
      socket = this.socketFactory(url.toString())
    } catch {
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    socket.addEventListener('open', async () => {
      if (this.socket !== socket) return
      try {
        const cursor = await this.store.read(CURSOR_KEY)
        socket.send(JSON.stringify({
          type: 'events.authenticate', accessToken: session.accessToken,
          ...(typeof cursor === 'string' && CURSOR_PATTERN.test(cursor) ? { cursor } : {}),
        }))
      } catch {
        socket.close(1011, 'event cursor unavailable')
      }
    })
    socket.addEventListener('message', event => {
      void this.handleEvent(socket, event.data).catch(() => socket.close(1011, 'event processing failed'))
    })
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return
      this.socket = undefined
      this.scheduleReconnect()
    })
    socket.addEventListener('error', () => socket.close())
  }

  async handleEvent(socket, data) {
    if (this.socket !== socket || typeof data !== 'string' || data.length > MAX_EVENT_CHARS) {
      socket.close(1002, 'invalid event')
      return
    }
    let event
    try {
      event = JSON.parse(data)
    } catch {
      socket.close(1002, 'invalid event')
      return
    }
    if (event?.type === 'events.rejected') {
      this.forceRenewSession = event.code === 'authentication_rejected' || event.code === 'session_invalid'
        || event.code === 'session_expired' || event.code === 'device_revoked'
      this.emit('stale', '实时连接认证已失效')
      socket.close(1008, 'event authentication ended')
      return
    }
    if (event?.type === 'events.ready') {
      if (typeof event.cursor !== 'string' || !CURSOR_PATTERN.test(event.cursor) || typeof event.requiresSnapshot !== 'boolean') {
        socket.close(1002, 'invalid ready event')
        return
      }
      if (event.requiresSnapshot && !await this.refresh()) {
        socket.close(1011, 'snapshot unavailable')
        return
      }
      await this.store.write(CURSOR_KEY, event.cursor)
      return
    }
    if (event?.version !== 1 || typeof event.cursor !== 'string' || !CURSOR_PATTERN.test(event.cursor)
      || typeof event.type !== 'string' || !Number.isFinite(event.occurredAt)) {
      socket.close(1002, 'invalid event')
      return
    }
    let eventNotice
    if (event.type === 'sync.required') {
      this.emit('stale')
      if (!await this.refresh()) return
    } else if (event.type === 'conversation.created' || event.type === 'conversation.removed') {
      if (!await this.refresh()) return
    } else if (event.type === 'conversation.status' && ID_PATTERN.test(event.conversationId)
      && typeof event.running === 'boolean') {
      this.conversations = this.conversations.map(item => item.id === event.conversationId
        ? { ...item, running: event.running, updatedAt: event.occurredAt }
        : item).sort((left, right) => right.updatedAt - left.updatedAt)
    } else if (event.type === 'conversation.message.committed' && ID_PATTERN.test(event.conversationId)
      && validMessage(event.message)) {
      this.conversations = this.conversations.map(item => item.id === event.conversationId
        ? { ...item, blank: false, updatedAt: event.occurredAt }
        : item).sort((left, right) => right.updatedAt - left.updatedAt)
      if (event.conversationId === this.selectedId && !this.messages.some(message => message.id === event.message.id)) {
        this.messages = [...this.messages, event.message].sort((left, right) => left.sequence - right.sequence).slice(-MAX_MESSAGES)
      }
    } else if (event.type === 'conversation.error' && ID_PATTERN.test(event.conversationId)) {
      eventNotice = 'Jarvis 未能完成本次回复'
    } else if (event.type === 'approval.pending' && validApproval(event.approval)) {
      this.approvals = [event.approval, ...this.approvals.filter(item => item.id !== event.approval.id)]
    } else if (event.type === 'approval.resolved' && ID_PATTERN.test(event.approvalId)
      && ID_PATTERN.test(event.conversationId)
      && ['allowed-once', 'rejected', 'cancelled', 'unavailable'].includes(event.outcome)) {
      this.approvals = this.approvals.filter(item => item.id !== event.approvalId)
      this.approvalSubmittedIds.delete(event.approvalId)
      for (const key of this.approvalDecisionKeys.keys()) {
        if (key.startsWith(`${event.approvalId}:`)) this.approvalDecisionKeys.delete(key)
      }
    } else {
      socket.close(1002, 'unsupported event')
      return
    }
    this.addActivity(eventDescription(event))
    this.cachedAt = Date.now()
    await this.persistCache()
    await this.store.write(CURSOR_KEY, event.cursor)
    if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'events.ack', cursor: event.cursor }))
    this.emit('ready', eventNotice)
  }

  async persistCache() {
    await this.store.write(CACHE_KEY, {
      version: 1,
      conversations: this.conversations.slice(0, 100),
      selectedId: this.selectedId,
      messages: this.messages.slice(-MAX_MESSAGES),
      cachedAt: this.cachedAt ?? Date.now(),
    })
  }

  async clearCache() {
    await this.store.delete(CACHE_KEY)
    await this.store.delete(CURSOR_KEY)
  }

  addActivity(label) {
    this.activity = [{ label, occurredAt: Date.now() }, ...this.activity].slice(0, MAX_ACTIVITY)
  }

  scheduleReconnect() {
    if (!this.active || !this.online || this.reconnectTimer !== undefined) return
    this.reconnectTimer = this.setTimeoutValue(() => {
      this.reconnectTimer = undefined
      void this.connectEvents()
    }, 2_000)
  }

  clearReconnect() {
    if (this.reconnectTimer !== undefined) this.clearTimeoutValue(this.reconnectTimer)
    this.reconnectTimer = undefined
  }

  emit(phase, message) {
    this.onState({
      phase,
      conversations: this.conversations.map(item => ({ ...item })),
      selectedId: this.selectedId,
      messages: this.messages.map(item => ({ ...item })),
      activity: this.activity.map(item => ({ ...item })),
      approvals: this.approvals.map(item => ({ ...item, arguments: item.arguments === null ? null : { ...item.arguments } })),
      approvalBusyId: this.approvalBusyId,
      approvalSubmittedIds: [...this.approvalSubmittedIds],
      cachedAt: this.cachedAt,
      sending: this.sending,
      ...(message === undefined ? {} : { message }),
    })
  }
}
