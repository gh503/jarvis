import { deleteDeviceState, readDeviceState, writeDeviceState } from './device-store.js?v=11'

export const NOTIFICATION_HISTORY_KEY = 'notification-history'
export const NOTIFICATION_PREFERENCES_KEY = 'notification-preferences'
export const NOTIFICATION_CATEGORIES = ['approval', 'conversation', 'connection']
export const MAX_NOTIFICATIONS = 50

const NOTIFICATION_ID_PATTERN = /^[a-z]+:[A-Za-z0-9_.:-]{1,320}$/
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/

export const DEFAULT_NOTIFICATION_PREFERENCES = Object.freeze({
  categories: Object.freeze({ approval: true, conversation: true, connection: true }),
  quietHours: Object.freeze({ enabled: false, start: '22:00', end: '07:00' }),
  rateLimits: Object.freeze({ approval: 5, conversation: 5, connection: 3 }),
})

function clonePreferences(preferences) {
  return {
    categories: { ...preferences.categories },
    quietHours: { ...preferences.quietHours },
    rateLimits: { ...preferences.rateLimits },
  }
}

function validNotification(value) {
  return value !== null && typeof value === 'object'
    && typeof value.id === 'string' && NOTIFICATION_ID_PATTERN.test(value.id)
    && NOTIFICATION_CATEGORIES.includes(value.category)
    && typeof value.title === 'string' && typeof value.body === 'string'
    && Number.isFinite(value.occurredAt) && typeof value.read === 'boolean'
    && (value.presentedAt === undefined || Number.isFinite(value.presentedAt))
    && (value.resource === null || (value.resource !== null && typeof value.resource === 'object'
      && ['activity', 'chat', 'settings'].includes(value.resource.view)
      && (value.resource.conversationId === undefined || RESOURCE_ID_PATTERN.test(value.resource.conversationId))
      && (value.resource.approvalId === undefined || RESOURCE_ID_PATTERN.test(value.resource.approvalId))))
}

function parseHistory(value) {
  if (!Array.isArray(value) || !value.every(validNotification)) return []
  const unique = new Map()
  for (const notification of value) unique.set(notification.id, {
    ...notification,
    resource: notification.resource === null ? null : { ...notification.resource },
  })
  return [...unique.values()].slice(0, MAX_NOTIFICATIONS)
}

function parsePreferences(value) {
  const preferences = clonePreferences(DEFAULT_NOTIFICATION_PREFERENCES)
  if (value === null || typeof value !== 'object') return preferences
  for (const category of NOTIFICATION_CATEGORIES) {
    if (typeof value.categories?.[category] === 'boolean') preferences.categories[category] = value.categories[category]
    if (Number.isInteger(value.rateLimits?.[category])) {
      preferences.rateLimits[category] = Math.max(0, Math.min(20, value.rateLimits[category]))
    }
  }
  if (typeof value.quietHours?.enabled === 'boolean') preferences.quietHours.enabled = value.quietHours.enabled
  if (TIME_PATTERN.test(value.quietHours?.start ?? '')) preferences.quietHours.start = value.quietHours.start
  if (TIME_PATTERN.test(value.quietHours?.end ?? '')) preferences.quietHours.end = value.quietHours.end
  return preferences
}

function notificationForEvent(event) {
  if (event?.version !== 1 || typeof event.cursor !== 'string' || !Number.isFinite(event.occurredAt)) return null
  if (event.type === 'approval.pending' && RESOURCE_ID_PATTERN.test(event.approval?.id ?? '')) {
    return {
      id: `approval:${event.approval.id}:pending`, category: 'approval',
      title: '有一项审批等待处理', body: 'Jarvis 有一项高风险操作等待你的决定。',
      resource: { view: 'activity', approvalId: event.approval.id },
    }
  }
  if (event.type === 'approval.resolved' && RESOURCE_ID_PATTERN.test(event.approvalId ?? '')) {
    return {
      id: `approval:${event.approvalId}:resolved`, category: 'approval',
      title: '审批状态已更新', body: 'Jarvis 的一项操作审批已经完成。',
      resource: { view: 'activity', approvalId: event.approvalId },
    }
  }
  if (event.type === 'device.approval.pending' && RESOURCE_ID_PATTERN.test(event.approval?.approvalId ?? '')) {
    return {
      id: `device-approval:${event.approval.approvalId}:pending`, category: 'approval',
      title: '有一项智能设备审批等待处理', body: 'Jarvis 有一项高风险智能设备操作等待你的决定。',
      resource: { view: 'activity', approvalId: event.approval.approvalId },
    }
  }
  if (event.type === 'device.approval.resolved' && RESOURCE_ID_PATTERN.test(event.approvalId ?? '')) {
    return {
      id: `device-approval:${event.approvalId}:resolved`, category: 'approval',
      title: '智能设备审批状态已更新', body: 'Jarvis 的一项智能设备操作审批已经完成。',
      resource: { view: 'activity', approvalId: event.approvalId },
    }
  }
  if (event.type === 'conversation.status' && RESOURCE_ID_PATTERN.test(event.conversationId ?? '')
    && event.running === false) {
    return {
      id: `conversation:${event.conversationId}:complete:${event.cursor}`, category: 'conversation',
      title: 'Jarvis 已完成回复', body: '一个对话回合已经完成。',
      resource: { view: 'chat', conversationId: event.conversationId },
    }
  }
  if (event.type === 'conversation.error' && RESOURCE_ID_PATTERN.test(event.conversationId ?? '')) {
    return {
      id: `conversation:${event.conversationId}:failed:${event.cursor}`, category: 'conversation',
      title: 'Jarvis 回复失败', body: '本次回复未能完成，请返回对话后重试。',
      resource: { view: 'chat', conversationId: event.conversationId },
    }
  }
  if (event.type === 'sync.required') {
    return {
      id: `connection:${event.cursor}`, category: 'connection',
      title: '需要重新同步', body: '实时事件需要重新同步，请检查当前连接状态。',
      resource: { view: 'settings' },
    }
  }
  return null
}

function minutesSinceMidnight(value) {
  const [hour, minute] = value.split(':').map(Number)
  return hour * 60 + minute
}

function inQuietHours(preferences, now) {
  if (!preferences.quietHours.enabled) return false
  const current = now.getHours() * 60 + now.getMinutes()
  const start = minutesSinceMidnight(preferences.quietHours.start)
  const end = minutesSinceMidnight(preferences.quietHours.end)
  return start === end ? true : start < end ? current >= start && current < end : current >= start || current < end
}

export class NotificationCenter {
  constructor(options = {}) {
    this.store = options.store ?? { read: readDeviceState, write: writeDeviceState, delete: deleteDeviceState }
    this.onState = options.onState ?? (() => {})
    this.systemNotify = options.systemNotify ?? (notification => {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification(notification.title, { body: notification.body, tag: notification.id })
      }
    })
    this.now = options.now ?? (() => Date.now())
    this.permission = options.permission ?? (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)
    this.history = []
    this.preferences = clonePreferences(DEFAULT_NOTIFICATION_PREFERENCES)
    this.failedConversationIds = new Set()
  }

  async initialize() {
    this.history = parseHistory(await this.store.read(NOTIFICATION_HISTORY_KEY))
    this.preferences = parsePreferences(await this.store.read(NOTIFICATION_PREFERENCES_KEY))
    this.emit()
  }

  async ingestEvent(event) {
    if (event?.type === 'conversation.status' && RESOURCE_ID_PATTERN.test(event.conversationId ?? '')) {
      if (event.running === true) this.failedConversationIds.delete(event.conversationId)
      if (event.running === false && this.failedConversationIds.delete(event.conversationId)) return false
    } else if (event?.type === 'conversation.error' && RESOURCE_ID_PATTERN.test(event.conversationId ?? '')) {
      this.failedConversationIds.add(event.conversationId)
    }
    const candidate = notificationForEvent(event)
    if (candidate === null || this.history.some(item => item.id === candidate.id)) return false
    const notification = {
      ...candidate,
      occurredAt: event.occurredAt,
      read: false,
      resource: { ...candidate.resource },
    }
    if (this.permission === 'granted' && this.shouldPresent(notification)) {
      notification.presentedAt = this.now()
      try {
        this.systemNotify({ ...notification, resource: { ...notification.resource } })
      } catch {
        delete notification.presentedAt
      }
    }
    this.history = [notification, ...this.history].slice(0, MAX_NOTIFICATIONS)
    await this.persist()
    this.emit()
    return true
  }

  async updatePreferences(update) {
    this.preferences = parsePreferences({ ...this.preferences, ...update,
      categories: { ...this.preferences.categories, ...update.categories },
      quietHours: { ...this.preferences.quietHours, ...update.quietHours },
      rateLimits: { ...this.preferences.rateLimits, ...update.rateLimits },
    })
    await this.store.write(NOTIFICATION_PREFERENCES_KEY, this.preferences)
    this.emit()
  }

  shouldPresent(notification, now = this.now()) {
    if (!this.preferences.categories[notification.category] || inQuietHours(this.preferences, new Date(now))) return false
    const limit = this.preferences.rateLimits[notification.category]
    if (limit <= 0) return false
    const hourAgo = now - 60 * 60 * 1_000
    const recent = this.history.filter(item => item.category === notification.category
      && item.presentedAt !== undefined && item.presentedAt >= hourAgo)
    return recent.length < limit
  }

  async markRead(id) {
    const notification = this.history.find(item => item.id === id)
    if (notification === undefined || notification.read) return
    notification.read = true
    await this.persist()
    this.emit()
  }

  async markAllRead() {
    if (this.history.every(item => item.read)) return
    this.history = this.history.map(item => ({ ...item, read: true }))
    await this.persist()
    this.emit()
  }

  async clear() {
    this.history = []
    this.failedConversationIds.clear()
    await this.store.delete(NOTIFICATION_HISTORY_KEY)
    await this.store.delete(NOTIFICATION_PREFERENCES_KEY)
    this.preferences = clonePreferences(DEFAULT_NOTIFICATION_PREFERENCES)
    this.emit()
  }

  async requestSystemPermission() {
    if (typeof Notification === 'undefined') return 'unsupported'
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
    this.permission = permission
    this.emit(permission)
    return permission
  }

  async persist() {
    await this.store.write(NOTIFICATION_HISTORY_KEY, this.history)
  }

  emit(permission) {
    this.onState({
      history: this.history.map(item => ({ ...item, resource: item.resource === null ? null : { ...item.resource } })),
      preferences: clonePreferences(this.preferences),
      unreadCount: this.history.filter(item => !item.read).length,
      permission: permission ?? this.permission,
    })
  }
}

export { inQuietHours, notificationForEvent, parseHistory, parsePreferences }
