const DATABASE_NAME = 'jarvis-device-v1'
const STORE_NAME = 'private-state'
const MAX_RESPONSE_CHARS = 32 * 1024

class GatewayUnavailableError extends Error {}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME)
    request.onerror = () => reject(new Error('device storage is unavailable'))
    request.onsuccess = () => resolve(request.result)
  })
}

async function readState(key) {
  const database = await openDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly')
      const request = transaction.objectStore(STORE_NAME).get(key)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(new Error('device storage could not be read'))
    })
  } finally {
    database.close()
  }
}

async function writeState(key, value) {
  const database = await openDatabase()
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      transaction.objectStore(STORE_NAME).put(value, key)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(new Error('device storage could not be written'))
    })
  } finally {
    database.close()
  }
}

async function deleteState(key) {
  const database = await openDatabase()
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      transaction.objectStore(STORE_NAME).delete(key)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(new Error('device storage could not be updated'))
    })
  } finally {
    database.close()
  }
}

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
  constructor(onState, fetchValue = (...requestArguments) => fetch(...requestArguments)) {
    this.onState = onState
    this.fetchValue = fetchValue
    this.pollTimer = undefined
    this.initializationPromise = undefined
  }

  initialize() {
    this.initializationPromise ??= this.initializeState()
    return this.initializationPromise
  }

  async initializeState() {
    try {
      const identity = await readState('identity')
      const credential = await readState('credential')
      const pending = await readState('pending')
      if (identity !== undefined && credential !== undefined) {
        await this.ensureSession(identity, credential)
        return
      }
      if (identity !== undefined && pending !== undefined && pending.expiresAt > Date.now()) {
        this.emitPending(pending)
        void this.poll(identity, pending)
        return
      }
      if (pending !== undefined) await deleteState('pending')
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
    let identity = await readState('identity')
    if (identity === undefined) {
      identity = await createIdentity(normalizedName)
      await writeState('identity', identity)
    } else if (identity.displayName !== normalizedName) {
      identity = { ...identity, displayName: normalizedName }
      await writeState('identity', identity)
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
    await writeState('pending', pending)
    this.emitPending(pending)
    void this.poll(identity, pending)
  }

  async cancel() {
    this.clearPoll()
    await deleteState('pending')
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
      await deleteState('pending')
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
        await deleteState('pending')
        this.onState({ phase: 'expired' })
        return
      }
      if (!response.ok) {
        await deleteState('pending')
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
      await writeState('credential', credential)
      await deleteState('pending')
      await this.ensureSession(identity, credential)
    } catch (error) {
      if (error instanceof GatewayUnavailableError) {
        this.emitPending(pending, 'Gateway 暂时不可用')
        this.schedulePoll(identity, pending, 5_000)
        return
      }
      await deleteState('pending')
      this.onState({ phase: 'error', message: error instanceof Error ? error.message : '配对响应无效' })
    }
  }

  async ensureSession(identity, credential) {
    try {
      const storedSession = await readState('session')
      if (storedSession !== undefined && storedSession.accessExpiresAt > Date.now()) {
        const current = await this.request('/v1/sessions/current', {
          headers: { authorization: `Session ${storedSession.accessToken}` },
        })
        if (current.ok) {
          this.onState({ phase: 'paired', displayName: identity.displayName, nodeId: identity.nodeId })
          return
        }
      }
      if (storedSession !== undefined && storedSession.refreshExpiresAt > Date.now()) {
        const refreshed = await this.request('/v1/sessions/refresh', {
          method: 'POST',
          body: JSON.stringify({ refreshToken: storedSession.refreshToken }),
        })
        if (refreshed.ok) {
          await writeState('session', parseSession(refreshed.value, identity.nodeId))
          this.onState({ phase: 'paired', displayName: identity.displayName, nodeId: identity.nodeId })
          return
        }
      }
      const issued = await this.request('/v1/sessions', {
        method: 'POST',
        headers: { authorization: `Device ${credential.credential}` },
        body: JSON.stringify({ nodeId: identity.nodeId }),
      })
      if (issued.status === 401) {
        await deleteState('credential')
        await deleteState('session')
        this.onState({ phase: 'revoked' })
        return
      }
      if (!issued.ok) throw new Error(`Gateway 会话创建失败 (${issued.status})`)
      await writeState('session', parseSession(issued.value, identity.nodeId))
      this.onState({ phase: 'paired', displayName: identity.displayName, nodeId: identity.nodeId })
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
