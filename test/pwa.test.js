import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { PairingAuthority, createDeviceIdentity } from '../dist/pairing.js'
import { BrowserPairing, decryptPairingCredential } from '../web/pairing.js'
import { NotificationCenter } from '../web/notifications.js'

const webRoot = join(process.cwd(), 'web')

test('declares a scoped installable manifest and complete offline shell', async () => {
  const manifest = JSON.parse(await readFile(join(webRoot, 'manifest.webmanifest'), 'utf8'))
  assert.equal(manifest.id, '/app/')
  assert.equal(manifest.start_url, '/app/')
  assert.equal(manifest.scope, '/app/')
  assert.equal(manifest.display, 'standalone')
  assert.ok(manifest.name)
  assert.ok(manifest.short_name)
  assert.ok(manifest.theme_color)
  assert.ok(manifest.background_color)
  assert.ok(manifest.icons.some(icon => icon.src === '/app/icon-192.png' && icon.sizes === '192x192'))
  assert.ok(manifest.icons.some(icon => icon.src === '/app/icon-512.png' && icon.sizes === '512x512'))

  const serviceWorker = await readFile(join(webRoot, 'sw.js'), 'utf8')
  for (const path of [
    '/app/', '/app/app.css', '/app/app.js?v=16', '/app/pairing.js?v=16', '/app/device-store.js?v=16',
    '/app/conversations.js?v=16', '/app/notifications.js?v=16', '/app/voice.js?v=16', '/app/apple-touch-icon.png', '/app/icon.svg',
    '/app/icon-192.png', '/app/icon-512.png', '/app/manifest.webmanifest',
  ]) {
    assert.ok(serviceWorker.includes(`'${path}'`), `${path} must be pre-cached`)
  }
  assert.match(serviceWorker, /event\.request\.mode === 'navigate'/)
  assert.match(serviceWorker, /caches\.match\('\/app\/'\)/)
})

test('ships valid standard and Apple PNG icon dimensions', async () => {
  for (const [file, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
    const icon = await readFile(join(webRoot, file))
    assert.deepEqual([...icon.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    assert.equal(icon.readUInt32BE(16), size)
    assert.equal(icon.readUInt32BE(20), size)
  }
})

test('keeps the browser client on the public Gateway contract', async () => {
  const appSource = await readFile(join(webRoot, 'app.js'), 'utf8')
  const pairingSource = await readFile(join(webRoot, 'pairing.js'), 'utf8')
  const conversationsSource = await readFile(join(webRoot, 'conversations.js'), 'utf8')
  const notificationsSource = await readFile(join(webRoot, 'notifications.js'), 'utf8')
  const voiceSource = await readFile(join(webRoot, 'voice.js'), 'utf8')
  const deviceStoreSource = await readFile(join(webRoot, 'device-store.js'), 'utf8')
  const htmlSource = await readFile(join(webRoot, 'index.html'), 'utf8')
  assert.match(appSource, /fetch\('\.\.\/v1\/health'/)
  assert.match(appSource, /handlePairingState\(\{ phase: 'loading' \}\)/)
  assert.match(deviceStoreSource, /indexedDB\.open/)
  assert.match(pairingSource, /await this\.initialize\(\)/)
  assert.match(conversationsSource, /events\.authenticate/)
  assert.match(conversationsSource, /authenticatedRequest\('\/v1\/conversations'/)
  assert.match(conversationsSource, /authenticatedRequest\('\/v1\/approvals'/)
  assert.match(conversationsSource, /authenticatedRequest\('\/v1\/device-approvals'/)
  assert.match(notificationsSource, /class NotificationCenter/)
  assert.match(notificationsSource, /固定摘要|高风险操作/)
  assert.match(voiceSource, /class PushToTalkController/)
  assert.match(voiceSource, /class SpeechPlaybackController/)
  assert.doesNotMatch(voiceSource, /indexedDB|localStorage|sessionStorage|fetch\(/)
  assert.doesNotMatch(notificationsSource, /arguments|message|rpcId|accessToken|refreshToken/)
  assert.match(htmlSource, /id="approval-list"/)
  assert.match(htmlSource, /id="disconnect-device-dialog"/)
  assert.match(htmlSource, /id="disconnect-device-button"[^>]+hidden disabled/)
  assert.match(htmlSource, /id="pair-button"[^>]+disabled/)
  assert.match(htmlSource, /id="voice-button"[^>]+disabled/)
  assert.match(htmlSource, /id="cancel-turn-button"[^>]+hidden disabled/)
  assert.match(htmlSource, /id="voice-enabled"[^>]+type="checkbox"/)
  assert.match(appSource, /data-speech-key|speechKey/)
  assert.match(appSource, /playbackController\.cancel\(\)/)
  assert.match(appSource, /conversationsClient\.cancelActive\(\)/)
  assert.doesNotMatch(`${appSource}\n${pairingSource}\n${conversationsSource}`, /@deepseek-ai|dsh|Harness|\/api\//i)
  assert.doesNotMatch(`${appSource}\n${pairingSource}\n${conversationsSource}`, /localStorage|sessionStorage/)
  assert.doesNotMatch(conversationsSource, /\.close\((1002|1008|1011)/)
})

test('decrypts the Gateway claim envelope with the browser claim secret', async () => {
  const authority = new PairingAuthority(() => 1_000, 60_000)
  const identity = createDeviceIdentity()
  const challenge = authority.createClaimableRequest({
    nodeId: 'pwa-browser', publicKey: identity.publicKey, displayName: 'Browser', platform: 'pwa',
  })
  authority.approveClaimable(challenge.verificationCode)
  const claim = authority.claim(challenge.requestId, challenge.claimToken)
  const credential = await decryptPairingCredential(claim.encryptedCredential, challenge.claimToken)
  assert.equal(authority.authenticate('pwa-browser', credential), true)
})

function response(status, value) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => value === undefined ? '' : JSON.stringify(value),
  }
}

function pairedBrowserState() {
  const now = Date.now()
  return {
    identity: { nodeId: 'pwa-browser', displayName: 'My Phone', publicKey: 'public-key', privateKey: {} },
    credential: { nodeId: 'pwa-browser', credential: 'c'.repeat(43), generation: 2, issuedAt: now - 1_000 },
    session: {
      nodeId: 'pwa-browser', sessionId: 's'.repeat(22), familyId: 'f'.repeat(22),
      accessToken: 'a'.repeat(43), refreshToken: 'r'.repeat(43),
      accessExpiresAt: now + 60_000, refreshExpiresAt: now + 120_000,
    },
    'conversation-cache': { private: 'cached conversation' },
    'event-cursor': `${'A'.repeat(22)}.7`,
  }
}

function currentDevice(state) {
  return {
    device: {
      nodeId: state.identity.nodeId, displayName: state.identity.displayName,
      platform: 'pwa', generation: 2, issuedAt: state.credential.issuedAt,
    },
    session: {
      sessionId: state.session.sessionId, issuedAt: state.credential.issuedAt,
      refreshedAt: state.credential.issuedAt, accessExpiresAt: state.session.accessExpiresAt,
      refreshExpiresAt: state.session.refreshExpiresAt,
    },
  }
}

function memoryDeviceStore(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    values,
    read: async key => values.get(key),
    write: async (key, value) => values.set(key, value),
    delete: async key => values.delete(key),
    clear: async () => values.clear(),
  }
}

test('shows authoritative device status and clears all browser state after self-revocation', async () => {
  const initial = pairedBrowserState()
  const store = memoryDeviceStore(initial)
  const states = []
  const calls = []
  const pairing = new BrowserPairing(state => states.push(state), async (path, init = {}) => {
    calls.push({ path, init })
    return path === '/v1/devices/current' && init.method === 'DELETE'
      ? response(204)
      : response(200, currentDevice(initial))
  }, store)

  await pairing.initialize()
  assert.deepEqual(states.at(-1), {
    phase: 'paired', displayName: 'My Phone', nodeId: 'pwa-browser', platform: 'pwa', generation: 2,
    issuedAt: initial.credential.issuedAt, accessExpiresAt: initial.session.accessExpiresAt,
    refreshExpiresAt: initial.session.refreshExpiresAt,
  })
  await pairing.revokeCurrentDevice()
  assert.equal(store.values.size, 0)
  assert.equal(states.at(-1).phase, 'unpaired')
  assert.equal(calls.at(-1).init.headers.authorization, `Session ${initial.session.accessToken}`)
})

test('converges to revoked and clears cached data after a self-revocation response is lost', async () => {
  const initial = pairedBrowserState()
  const store = memoryDeviceStore(initial)
  const first = new BrowserPairing(() => {}, async (path, init = {}) => {
    if (path === '/v1/devices/current' && init.method === 'DELETE') throw new Error('response lost')
    return response(200, currentDevice(initial))
  }, store)
  await first.initialize()
  await assert.rejects(first.revokeCurrentDevice(), /Gateway/)
  assert.ok(store.values.has('credential'))

  const states = []
  const restarted = new BrowserPairing(state => states.push(state), async path => {
    if (path === '/v1/devices/current' || path === '/v1/sessions/refresh') return response(401, {})
    if (path === '/v1/sessions') return response(401, {})
    throw new Error(`unexpected request: ${path}`)
  }, store)
  await restarted.initialize()
  assert.equal(states.at(-1).phase, 'revoked')
  assert.equal(store.values.size, 0)
})

test('clears all browser state when another tab observes device revocation', async () => {
  const store = memoryDeviceStore(pairedBrowserState())
  const states = []
  const pairing = new BrowserPairing(state => states.push(state), async () => response(500, {}), store)
  await pairing.handleRemoteRevocation()
  assert.equal(store.values.size, 0)
  assert.equal(states.at(-1).phase, 'revoked')
})

test('rejects current-device responses containing private or unexpected fields', async () => {
  const initial = pairedBrowserState()
  const store = memoryDeviceStore(initial)
  const states = []
  const pairing = new BrowserPairing(state => states.push(state), async () => response(200, {
    ...currentDevice(initial), credentialDigest: 'must-not-cross-the-boundary',
  }), store)
  await pairing.initialize()
  assert.equal(states.at(-1).phase, 'paired-error')
  assert.match(states.at(-1).message, /invalid current device/)
})

test('creates redacted, deduplicated notifications from normalized events', async () => {
  const store = memoryDeviceStore()
  const states = []
  const systemNotifications = []
  const center = new NotificationCenter({
    store,
    onState: state => states.push(state),
    permission: 'granted',
    systemNotify: notification => systemNotifications.push(notification),
    now: () => 1_700_000_000_000,
  })
  await center.initialize()
  const event = {
    version: 1, cursor: 'A'.repeat(22) + '.8', occurredAt: 1_700_000_000_000,
    type: 'approval.pending',
    approval: {
      id: 'approval-1', conversationId: 'conversation-1', toolName: 'jarvis_open_app',
      callId: 'call-1', risk: 'high', canAllow: true,
    },
    arguments: { application: 'Secret App', command: 'private argument' },
  }
  assert.equal(await center.ingestEvent(event), true)
  assert.equal(await center.ingestEvent(event), false)
  assert.equal(states.at(-1).unreadCount, 1)
  assert.equal(systemNotifications.length, 1)
  assert.equal(systemNotifications[0].body.includes('private argument'), false)
  assert.equal(JSON.stringify(systemNotifications[0]).includes('Secret App'), false)
  assert.deepEqual(systemNotifications[0].resource, { view: 'activity', approvalId: 'approval-1' })
  const restarted = new NotificationCenter({ store, permission: 'default' })
  await restarted.initialize()
  assert.equal(restarted.history[0].id, 'approval:approval-1:pending')

  const deviceEvent = {
    version: 1, cursor: 'A'.repeat(22) + '.9', occurredAt: 1_700_000_000_001,
    type: 'device.approval.pending',
    approval: {
      approvalId: 'device-approval-1', capability: 'lock.set', externalEntityId: 'lock.front_door',
      service: 'lock_unlock', expectedState: 'unlocked', digest: 'b'.repeat(64), risk: 'high', expiresAt: 1_700_000_060_000,
    },
  }
  assert.equal(await center.ingestEvent(deviceEvent), true)
  assert.equal(systemNotifications.at(-1).body.includes('lock.front_door'), false)
  assert.deepEqual(systemNotifications.at(-1).resource, { view: 'activity', approvalId: 'device-approval-1' })
})

test('quiet hours and rate limits suppress system presentation but retain history', async () => {
  const store = memoryDeviceStore()
  const systemNotifications = []
  const quietNow = new Date(2026, 0, 1, 23, 30, 0, 0)
  const center = new NotificationCenter({
    store,
    permission: 'granted',
    systemNotify: notification => systemNotifications.push(notification),
    now: () => quietNow.getTime(),
  })
  await center.initialize()
  await center.updatePreferences({
    quietHours: { enabled: true, start: '23:00', end: '07:00' },
    rateLimits: { conversation: 1 },
  })
  const base = { version: 1, occurredAt: quietNow.getTime(), type: 'conversation.status', running: false }
  await center.ingestEvent({ ...base, cursor: 'B'.repeat(22) + '.1', conversationId: 'conversation-1' })
  assert.equal(systemNotifications.length, 0)
  assert.equal(store.values.get('notification-history').length, 1)
  await center.updatePreferences({ quietHours: { enabled: false } })
  await center.ingestEvent({ ...base, cursor: 'B'.repeat(22) + '.2', conversationId: 'conversation-2' })
  assert.equal(systemNotifications.length, 1)
  await center.ingestEvent({ ...base, cursor: 'B'.repeat(22) + '.3', conversationId: 'conversation-3' })
  assert.equal(systemNotifications.length, 1)
})

test('reports failed turns without emitting a false completion notification', async () => {
  const store = memoryDeviceStore()
  const center = new NotificationCenter({ store, permission: 'default' })
  await center.initialize()
  const base = { version: 1, occurredAt: 1_700_000_000_000, conversationId: 'conversation-1' }
  assert.equal(await center.ingestEvent({
    ...base, cursor: 'D'.repeat(22) + '.1', type: 'conversation.status', running: true,
  }), false)
  assert.equal(await center.ingestEvent({
    ...base, cursor: 'D'.repeat(22) + '.2', type: 'conversation.error', code: 'harness_agent_error',
  }), true)
  assert.equal(await center.ingestEvent({
    ...base, cursor: 'D'.repeat(22) + '.3', type: 'conversation.status', running: false,
  }), false)
  assert.equal(center.history.length, 1)
  assert.equal(center.history[0].title, 'Jarvis 回复失败')
  assert.deepEqual(center.history[0].resource, { view: 'chat', conversationId: 'conversation-1' })

  assert.equal(await center.ingestEvent({
    ...base, conversationId: 'conversation-2', cursor: 'D'.repeat(22) + '.4',
    type: 'conversation.status', running: false,
  }), true)
  assert.equal(center.history[0].title, 'Jarvis 已完成回复')
})

test('notification history is bounded, persisted, and cleared on revocation', async () => {
  const store = memoryDeviceStore()
  const center = new NotificationCenter({ store, permission: 'default' })
  await center.initialize()
  for (let index = 0; index < 60; index += 1) {
    await center.ingestEvent({
      version: 1, cursor: 'C'.repeat(22) + '.' + index, occurredAt: 1_700_000_000_000 + index,
      type: 'sync.required',
    })
  }
  assert.equal(center.history.length, 50)
  assert.equal(store.values.get('notification-history').length, 50)
  await center.markAllRead()
  assert.equal(center.history.every(item => item.read), true)
  await center.clear()
  assert.equal(store.values.has('notification-history'), false)
  assert.equal(store.values.has('notification-preferences'), false)
  assert.equal(center.history.length, 0)
})
