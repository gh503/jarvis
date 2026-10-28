// Browser permission capture only. Never call this from model/tool/event-bus actions.
const MAX_BYTES = 8 * 1024 * 1024
const MAX_PIXELS = 4_194_304

export function stopCaptureTracks(stream) {
  for (const track of stream?.getTracks() || []) {
    try { track.stop() } catch { /* Still stop every remaining track. */ }
  }
}

function deadline(promise, ms, signal, onLate) {
  return new Promise((resolve, reject) => {
    let done = false
    const finish = (fn, value) => {
      if (done) return false
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(value); return true
    }
    const abort = () => finish(reject, signal.reason || new Error('Capture cancelled'))
    const timer = setTimeout(() => finish(reject, new Error('Capture timed out')), ms)
    promise.then(value => { if (!finish(resolve, value)) onLate?.(value) }, error => finish(reject, error))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}

function requireGesture(event) {
  if (!event?.isTrusted || event.type !== 'click' || !navigator.userActivation?.isActive) throw new Error('请点击屏幕或摄像头按钮，主动授权采集。')
}

async function frame(stream, signal) {
  const video = document.createElement('video')
  video.muted = true; video.playsInline = true; video.srcObject = stream
  let cancelFrame
  try {
    await deadline(video.play(), 10_000, signal)
    if (video.requestVideoFrameCallback) {
      await deadline(new Promise(resolve => { const id = video.requestVideoFrameCallback(resolve); cancelFrame = () => video.cancelVideoFrameCallback(id) }), 10_000, signal)
    }
    const width = video.videoWidth, height = video.videoHeight
    if (!width || !height) throw new Error('浏览器没有提供可用画面。')
    const scale = Math.min(1, 4096 / width, 4096 / height, Math.sqrt(MAX_PIXELS / (width * height)))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.floor(width * scale)); canvas.height = Math.max(1, Math.floor(height * scale))
    try {
      const context = canvas.getContext('2d')
      if (!context) throw new Error('浏览器无法生成预览。')
      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      // Stop before encoding or opening the preview, not just after upload.
      stopCaptureTracks(stream)
      const blob = await deadline(new Promise(resolve => canvas.toBlob(resolve, 'image/png')), 10_000, signal)
      if (!blob || blob.type !== 'image/png' || !blob.size || blob.size > MAX_BYTES) throw new Error('画面过大，请选择较小窗口。')
      return blob
    } finally { canvas.width = 0; canvas.height = 0 }
  } finally {
    stopCaptureTracks(stream); cancelFrame?.(); video.pause(); video.srcObject = null
  }
}

function confirmPreview(blob, target, isCurrent, signal) {
  return new Promise((resolve, reject) => {
    const dialog = document.createElement('dialog')
    const heading = document.createElement('h2')
    heading.textContent = '确认发送这一帧'
    const note = document.createElement('p')
    note.textContent = target === 'screen'
      ? '共享已停止。浏览器无法检查窗口标题隐私黑名单；请检查所选窗口的预览，确认没有密码、私人聊天等敏感内容。确认后仅发送到此 Jarvis 服务器的本地模型，不发送到远程模型。'
      : '摄像头已停止。请检查这一帧，确认后仅发送到此 Jarvis 服务器的本地模型，不发送到远程模型。'
    const image = document.createElement('img')
    const url = URL.createObjectURL(blob)
    image.src = url; image.alt = '待确认的单帧画面'; image.style.maxWidth = 'min(80vw, 900px)'; image.style.maxHeight = '65vh'
    const cancel = document.createElement('button'), confirm = document.createElement('button')
    cancel.type = confirm.type = 'button'; cancel.textContent = '取消'; confirm.textContent = '确认并发送这一帧'
    let settled = false
    const finish = (value, error) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
      dialog.close(); dialog.remove(); URL.revokeObjectURL(url)
      if (error) reject(error); else resolve(value)
    }
    const abort = () => finish(false)
    const timer = setTimeout(abort, 120_000)
    cancel.addEventListener('click', () => finish(false))
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false) })
    confirm.addEventListener('click', event => {
      try { requireGesture(event); if (!isCurrent()) throw new Error('会话已改变，请重新采集。'); finish(true) } catch (error) { finish(false, error) }
    })
    dialog.append(heading, note, image, document.createElement('br'), cancel, confirm)
    document.body.append(dialog)
    try { dialog.showModal(); cancel.focus() } catch (error) { finish(false, error) }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}

/** Call synchronously inside the original button click handler (before any await).
 * isCurrent must check the captured session/turn binding and cancellation state.
 * Returns null on preview cancellation, otherwise the server's normal turn result.
 */
export async function captureAndConfirm({ event, target, sessionId, turnId, token = '', isCurrent, signal }) {
  requireGesture(event)
  if (!['screen', 'camera'].includes(target) || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId || '') || !/^[a-zA-Z0-9_-]{1,128}$/.test(turnId || '')) throw new Error('Invalid capture identity')
  if (typeof isCurrent !== 'function' || !isCurrent()) throw new Error('会话已改变，请重新采集。')
  signal?.throwIfAborted()
  if (!window.isSecureContext || !navigator.mediaDevices) throw new Error('浏览器采集需要 HTTPS 或 localhost 安全上下文。')
  const devices = navigator.mediaDevices
  if (target === 'screen' && !devices.getDisplayMedia) throw new Error('此浏览器不支持屏幕共享，请使用支持 getDisplayMedia 的桌面浏览器。')
  if (target === 'camera' && !devices.getUserMedia) throw new Error('此浏览器不支持摄像头采集。')
  let stream
  try {
    // Permission call occurs during the original user gesture.
    const permission = target === 'screen'
      ? devices.getDisplayMedia({ video: true, audio: false })
      : devices.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
    stream = await deadline(permission, 30_000, signal, stopCaptureTracks)
    if (!isCurrent()) throw new Error('会话已改变，请重新采集。')
    const blob = await frame(stream, signal)
    if (!isCurrent()) throw new Error('会话已改变，请重新采集。')
    if (!await confirmPreview(blob, target, isCurrent, signal)) return null
    if (!isCurrent()) throw new Error('会话已改变，请重新采集。')
    signal?.throwIfAborted()
    const query = new URLSearchParams({ sessionId, turnId, target })
    const response = await fetch(`/api/browser-capture?${query}`, {
      method: 'POST', credentials: 'same-origin', redirect: 'error',
      headers: { 'Content-Type': 'image/png', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: blob,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(130_000)]) : AbortSignal.timeout(130_000),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || `Capture upload failed (${response.status})`)
    return result
  } finally { stopCaptureTracks(stream) }
}
