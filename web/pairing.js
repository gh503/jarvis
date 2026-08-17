import { clearDeviceState, deleteDeviceState, readDeviceState, writeDeviceState } from './device-store.js?v=19'

const MAX_RESPONSE_CHARS = 2 * 1024 * 1024

class GatewayUnavailableError extends Error {}

export function encodeBase64Url(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function decodeBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('encoded data is invalid')
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

export async function decryptPairingCredential(envelope, claimToken) {
  if (envelope?.algorithm !== 'A256GCM' || typeof envelope.iv !== 'string' || typeof envelope.ciphertext !== 'string') {
    throw new Error('encrypted device credential is invalid')
  }
  const material = new TextEncoder().encode(`jarvis-pairing-claim-v1\0${claimToken}`)
  const digest = await crypto.subtle.digest('SHA-256', material)
  const key = await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['decrypt'])
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decodeBase64Url(envelope.iv) },
    key,
    decodeBase64Url(envelope.ciphertext),
  )
  const credential = new TextDecoder().decode(plaintext)
  if (!/^[A-Za-z0-9_-]{43}$/.test(credential)) throw new Error('device credential is invalid')
  return credential
}

function validIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}

function validToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
}

function parseSession(value, nodeId) {
  if (value?.nodeId !== nodeId || typeof value.sessionId !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(value.sessionId)
    || typeof value.familyId !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(value.familyId)
    || !validToken(value.accessToken) || !validToken(value.refreshToken)
    || !Number.isFinite(value.accessExpiresAt) || !Number.isFinite(value.refreshExpiresAt)) {
    throw new Error('Gateway returned an invalid session')
  }
  return value
}

function exactFields(value, fields) {
  return value !== null && typeof value === 'object'
    && Object.keys(value).every(key => fields.includes(key))
    && fields.every(key => Object.hasOwn(value, key))
}

function parseCurrentDevice(value, identity, session) {
  const deviceFields = ['nodeId', 'displayName', 'platform', 'generation', 'issuedAt']
  const sessionFields = ['sessionId', 'issuedAt', 'refreshedAt', 'accessExpiresAt', 'refreshExpiresAt']
  if (!exactFields(value, ['device', 'session']) || !exactFields(value.device, deviceFields)
    || !exactFields(value.session, sessionFields) || value.device.nodeId !== identity.nodeId
    || value.device.platform !== 'pwa' || typeof value.device.displayName !== 'string'
    || value.device.displayName.length < 1 || value.device.displayName.length > 128
    || /[\u0000-\u001f\u007f]/.test(value.device.displayName)
    || !Number.isInteger(value.device.generation) || value.device.generation < 1
    || !Number.isFinite(value.device.issuedAt) || value.session.sessionId !== session.sessionId
    || !Number.isFinite(value.session.issuedAt) || !Number.isFinite(value.session.refreshedAt)
    || value.session.refreshedAt < value.session.issuedAt
    || value.session.accessExpiresAt <= value.session.refreshedAt
    || value.session.refreshExpiresAt <= value.session.issuedAt
    || value.session.accessExpiresAt !== session.accessExpiresAt
    || value.session.refreshExpiresAt !== session.refreshExpiresAt) {
    throw new Error('Gateway returned an invalid current device')
  }
  return value
}

function parseRotatedDevice(value, identity, expectedGeneration) {
  const fields = ['nodeId', 'displayName', 'platform', 'generation', 'issuedAt']
  if (!exactFields(value, ['device']) || !exactFields(value.device, fields)
    || value.device.nodeId !== identity.nodeId || value.device.displayName !== identity.displayName
    || value.device.platform !== 'pwa' || value.device.generation !== expectedGeneration + 1
    || !Number.isFinite(value.device.issuedAt)) {
    throw new Error('Gateway returned an invalid credential rotation')
  }
  return value.device
}

function createCredential() {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)))
}

async function createIdentity(displayName) {
  const generated = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
  )
  const publicKey = encodeBase64Url(await crypto.subtle.exportKey('spki', generated.publicKey))
  const exportedPrivateKey = await crypto.subtle.exportKey('pkcs8', generated.privateKey)
  const privateKey = await crypto.subtle.importKey(
    'pkcs8', exportedPrivateKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
  )
  new Uint8Array(exportedPrivateKey).fill(0)
  return {
    nodeId: `pwa-${crypto.randomUUID()}`,
    displayName,
    publicKey,
    privateKey,
  }
}

export class BrowserPairing {
  constructor(onState, fetchValue = (...requestArguments) => fetch(...requestArguments), store = {}) {
    this.onState = onState
    this.fetchValue = fetchValue
    this.store = {
      read: store.read ?? readDeviceState,
      write: store.write ?? writeDeviceState,
      delete: store.delete ?? deleteDeviceState,
      clear: store.clear ?? clearDeviceState,
    }
    this.pollTimer = undefined
    this.initializationPromise = undefined
  }

  initialize() {
    this.initializationPromise ??= this.initializeState()
    return this.initializationPromise
  }

  async initializeState() {
    try {
      const identity = await this.store.read('identity')
      let credential = await this.store.read('credential')
      const pending = await this.store.read('pending')
      if (identity !== undefined && credential !== undefined) {
        const rotation = await this.store.read('credential-rotation')
        if (rotation !== undefined) {
          try {
            credential = await this.completeCredentialRotation(identity, credential, rotation)
          } catch (error) {
            if (!(error instanceof GatewayUnavailableError)) throw error
          }
        }
        await this.ensureSession(identity, credential)
        return
      }
      if (identity !== undefined && pending !== undefined && pending.expiresAt > Date.now()) {
        this.emitPending(pending)
        void this.poll(identity, pending)
        return
      }
      if (pending !== undefined) await this.store.delete('pending')
      this.onState({ phase: 'unpaired' })
    } catch (error) {
      this.onState({ phase: 'error', message: error instanceof Error ? error.message : 'pairing initialization failed' })
    }
  }

  async begin(displayName) {
    await this.initialize()
    const normalizedName = displayName.trim()
    if (normalizedName.length < 1 || normalizedName.length > 64 || /[\u0000-\u001f\u007f]/.test(normalizedName)) {
      throw new Error('设备名称应为 1 至 64 个字符')
    }
    this.clearPoll()
    this.onState({ phase: 'starting' })
    let identity = await this.store.read('identity')
    if (identity === undefined) {
      identity = await createIdentity(normalizedName)
      await this.store.write('identity', identity)
    } else if (identity.displayName !== normalizedName) {
      identity = { ...identity, displayName: normalizedName }
      await this.store.write('identity', identity)
    }
    const response = await this.request('/v1/pairing/requests/browser', {
      method: 'POST',
      body: JSON.stringify({
        nodeId: identity.nodeId,
        publicKey: identity.publicKey,
        displayName: normalizedName,
        platform: 'pwa',
      }),
    })
    if (!response.ok) throw new Error(`无法创建配对请求 (${response.status})`)
    const challenge = response.value
    if (challenge?.nodeId !== identity.nodeId || challenge?.publicKey !== identity.publicKey
      || !validIdentifier(challenge.requestId) || !/^\d{6}$/.test(challenge.verificationCode)
      || !validToken(challenge.claimToken) || !Number.isFinite(challenge.expiresAt)) {
      throw new Error('Gateway 返回了无效配对请求')
    }
    const pending = {
      requestId: challenge.requestId,
      claimToken: challenge.claimToken,
      verificationCode: challenge.verificationCode,
      expiresAt: challenge.expiresAt,
      displayName: normalizedName,
    }
    await this.store.write('pending', pending)
    this.emitPending(pending)
    void this.poll(identity, pending)
  }

  async cancel() {
    this.clearPoll()
    await this.store.delete('pending')
    this.onState({ phase: 'unpaired' })
  }

  clearPoll() {
    if (this.pollTimer !== undefined) window.clearTimeout(this.pollTimer)
    this.pollTimer = undefined
  }

  emitPending(pending, message) {
    this.onState({
      phase: 'pending',
      verificationCode: pending.verificationCode,
      expiresAt: pending.expiresAt,
      displayName: pending.displayName,
      ...(message === undefined ? {} : { message }),
    })
  }

  schedulePoll(identity, pending, delay = 2_000) {
    this.clearPoll()
    this.pollTimer = window.setTimeout(() => { void this.poll(identity, pending) }, delay)
  }

  async poll(identity, pending) {
    if (pending.expiresAt <= Date.now()) {
      await this.store.delete('pending')
      this.onState({ phase: 'expired' })
      return
    }
    try {
      const response = await this.request('/v1/pairing/requests/claim', {
        method: 'POST',
        body: JSON.stringify({ requestId: pending.requestId, claimToken: pending.claimToken }),
      })
      if (response.status === 202) {
        this.emitPending(pending)
        this.schedulePoll(identity, pending)
        return
      }
      if (response.status === 410) {
        await this.store.delete('pending')
        this.onState({ phase: 'expired' })
        return
      }
      if (!response.ok) {
        await this.store.delete('pending')
        this.onState({ phase: 'error', message: `配对领取失败 (${response.status})` })
        return
      }
      const claim = response.value
      if (claim?.requestId !== pending.requestId || claim?.nodeId !== identity.nodeId
        || claim?.publicKey !== identity.publicKey || !Number.isInteger(claim.generation)
        || claim.generation < 1 || !Number.isFinite(claim.issuedAt)) {
        throw new Error('Gateway 返回了无效配对凭据')
      }
      const credentialValue = await decryptPairingCredential(claim.encryptedCredential, pending.claimToken)
      const credential = {
        nodeId: identity.nodeId,
        credential: credentialValue,
        generation: claim.generation,
        issuedAt: claim.issuedAt,
      }
      await this.store.write('credential', credential)
      await this.store.delete('pending')
      await this.ensureSession(identity, credential)
    } catch (error) {
      if (error instanceof GatewayUnavailableError) {
        this.emitPending(pending, 'Gateway 暂时不可用')
        this.schedulePoll(identity, pending, 5_000)
        return
      }
      await this.store.delete('pending')
      this.onState({ phase: 'error', message: error instanceof Error ? error.message : '配对响应无效' })
    }
  }

  async ensureSession(identity, credential) {
    try {
      const storedSession = await this.store.read('session')
      if (storedSession !== undefined && storedSession.accessExpiresAt > Date.now()) {
        const current = await this.request('/v1/devices/current', {
          headers: { authorization: `Session ${storedSession.accessToken}` },
        })
        if (current.ok) {
          this.emitPaired(parseCurrentDevice(current.value, identity, storedSession))
          return parseSession(storedSession, identity.nodeId)
        }
      }
      if (storedSession !== undefined && storedSession.refreshExpiresAt > Date.now()) {
        const refreshed = await this.request('/v1/sessions/refresh', {
          method: 'POST',
          body: JSON.stringify({ refreshToken: storedSession.refreshToken }),
        })
        if (refreshed.ok) {
          const session = parseSession(refreshed.value, identity.nodeId)
          await this.store.write('session', session)
          await this.loadCurrentDevice(identity, session)
          return session
        }
      }
      const issued = await this.request('/v1/sessions', {
        method: 'POST',
        headers: { authorization: `Device ${credential.credential}` },
        body: JSON.stringify({ nodeId: identity.nodeId }),
      })
      if (issued.status === 401) {
        await this.handleRemoteRevocation()
        return
      }
      if (!issued.ok) throw new Error(`Gateway 会话创建失败 (${issued.status})`)
      const session = parseSession(issued.value, identity.nodeId)
      await this.store.write('session', session)
      await this.loadCurrentDevice(identity, session)
      return session
    } catch (error) {
      if (error instanceof GatewayUnavailableError) {
        this.onState({ phase: 'paired-offline', displayName: identity.displayName, nodeId: identity.nodeId })
        return
      }
      this.onState({
        phase: 'paired-error',
        displayName: identity.displayName,
        nodeId: identity.nodeId,
        message: error instanceof Error ? error.message : 'Gateway 会话响应无效',
      })
    }
    return undefined
  }

  async loadCurrentDevice(identity, session) {
    const response = await this.request('/v1/devices/current', {
      headers: { authorization: `Session ${session.accessToken}` },
    })
    if (!response.ok) throw new Error(`Gateway device status failed (${response.status})`)
    this.emitPaired(parseCurrentDevice(response.value, identity, session))
  }

  emitPaired(current) {
    this.onState({
      phase: 'paired',
      displayName: current.device.displayName,
      nodeId: current.device.nodeId,
      platform: current.device.platform,
      generation: current.device.generation,
      issuedAt: current.device.issuedAt,
      accessExpiresAt: current.session.accessExpiresAt,
      refreshExpiresAt: current.session.refreshExpiresAt,
    })
  }

  async revokeCurrentDevice() {
    await this.initialize()
    const session = await this.accessSession()
    const response = await this.request('/v1/devices/current', {
      method: 'DELETE',
      headers: { authorization: `Session ${session.accessToken}` },
    })
    if (response.status !== 204) throw new Error(`无法断开此设备 (${response.status})`)
    this.clearPoll()
    await this.store.clear()
    this.initializationPromise = undefined
    this.onState({ phase: 'unpaired' })
  }

  async rotateCurrentCredential() {
    await this.initialize()
    const identity = await this.store.read('identity')
    const credential = await this.store.read('credential')
    if (identity === undefined || credential === undefined) throw new Error('此设备尚未配对')
    let rotation = await this.store.read('credential-rotation')
    if (rotation === undefined) {
      rotation = {
        nodeId: identity.nodeId,
        nextCredential: createCredential(),
        expectedGeneration: credential.generation,
      }
      await this.store.write('credential-rotation', rotation)
    }
    const rotated = await this.completeCredentialRotation(identity, credential, rotation)
    const session = await this.store.read('session')
    if (session === undefined) throw new Error('Gateway 会话不可用')
    const activeSession = parseSession(session, identity.nodeId)
    this.emitPaired({
      device: {
        nodeId: identity.nodeId,
        displayName: identity.displayName,
        platform: 'pwa',
        generation: rotated.generation,
        issuedAt: rotated.issuedAt,
      },
      session: activeSession,
    })
    return rotated
  }

  async completeCredentialRotation(identity, credential, rotation) {
    const activeIsNext = credential?.credential === rotation?.nextCredential
      && credential?.generation === rotation?.expectedGeneration + 1
    if (rotation?.nodeId !== identity.nodeId || !validToken(rotation.nextCredential)
      || !Number.isInteger(rotation.expectedGeneration)
      || (!activeIsNext && rotation.expectedGeneration !== credential.generation)) {
      throw new Error('本地凭证轮换状态无效')
    }
    const path = `/v1/devices/${encodeURIComponent(identity.nodeId)}/credential`
    const body = JSON.stringify({
      nextCredential: rotation.nextCredential,
      expectedGeneration: rotation.expectedGeneration,
    })
    let response
    try {
      response = await this.request(path, {
        method: 'PUT',
        headers: { authorization: `Device ${credential.credential}` },
        body,
      })
    } catch (error) {
      if (!(error instanceof GatewayUnavailableError)) throw error
      response = await this.request(path, {
        method: 'PUT',
        headers: { authorization: `Device ${rotation.nextCredential}` },
        body,
      })
    }
    if (response.status === 401) {
      response = await this.request(path, {
        method: 'PUT',
        headers: { authorization: `Device ${rotation.nextCredential}` },
        body,
      })
    }
    if (!response.ok) throw new Error(`无法轮换设备凭证 (${response.status})`)
    const device = parseRotatedDevice(response.value, identity, rotation.expectedGeneration)
    const next = {
      nodeId: identity.nodeId,
      credential: rotation.nextCredential,
      generation: device.generation,
      issuedAt: device.issuedAt,
    }
    await this.store.write('credential', next)
    await this.store.delete('credential-rotation')
    return next
  }

  async handleRemoteRevocation() {
    this.clearPoll()
    await this.store.clear()
    this.initializationPromise = undefined
    this.onState({ phase: 'revoked' })
  }

  async accessSession(forceRenew = false) {
    await this.initialize()
    const identity = await this.store.read('identity')
    const credential = await this.store.read('credential')
    if (identity === undefined || credential === undefined) throw new Error('此设备尚未配对')
    const storedSession = await this.store.read('session')
    if (!forceRenew && storedSession !== undefined && storedSession.accessExpiresAt > Date.now()) {
      return parseSession(storedSession, identity.nodeId)
    }
    const session = await this.ensureSession(identity, credential)
    if (session === undefined || session.accessExpiresAt <= Date.now()) throw new Error('Gateway 会话不可用')
    return session
  }

  async authenticatedRequest(path, init = {}) {
    let session = await this.accessSession()
    let response = await this.request(path, {
      ...init,
      headers: { ...init.headers, authorization: `Session ${session.accessToken}` },
    })
    if (response.status !== 401) return response
    await this.store.delete('session')
    session = await this.accessSession(true)
    response = await this.request(path, {
      ...init,
      headers: { ...init.headers, authorization: `Session ${session.accessToken}` },
    })
    return response
  }

  async request(path, init = {}) {
    let response
    try {
      response = await this.fetchValue(path, {
        ...init,
        headers: {
          accept: 'application/json',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...init.headers,
        },
      })
    } catch {
      throw new GatewayUnavailableError('Gateway 暂时不可用')
    }
    const text = await response.text()
    if (text.length > MAX_RESPONSE_CHARS) throw new Error('Gateway response is too large')
    let value
    try {
      value = text === '' ? undefined : JSON.parse(text)
    } catch {
      throw new Error('Gateway returned invalid JSON')
    }
    return { ok: response.ok, status: response.status, value }
  }
}
