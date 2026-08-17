function browserRecognitionFactory() {
  const Recognition = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition
  return typeof Recognition === 'function' ? () => new Recognition() : undefined
}

const MAX_TRANSCRIPT_CHARS = 16 * 1024

function transcriptFromResults(results) {
  const final = []
  const partial = []
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index]
    const transcript = typeof result?.[0]?.transcript === 'string' ? result[0].transcript.trim() : ''
    if (transcript.length === 0) continue
    if (result.isFinal) final.push(transcript)
    else partial.push(transcript)
  }
  const finalTranscript = final.join(' ').trim()
  const partialTranscript = partial.join(' ').trim()
  if (finalTranscript.length > MAX_TRANSCRIPT_CHARS || partialTranscript.length > MAX_TRANSCRIPT_CHARS) {
    throw new Error('voice transcript is too long')
  }
  return { final: finalTranscript, partial: partialTranscript }
}

function errorMessage(code) {
  if (code === 'not-allowed' || code === 'service-not-allowed') return '麦克风权限未允许'
  if (code === 'audio-capture') return '麦克风不可用'
  if (code === 'network') return '语音服务网络不可用'
  if (code === 'no-speech') return '未识别到语音'
  return '语音识别失败'
}

export class PushToTalkController {
  constructor(options = {}) {
    const recognitionFactory = options.recognitionFactory === undefined ? browserRecognitionFactory() : options.recognitionFactory
    this.recognitionFactory = typeof recognitionFactory === 'function' ? recognitionFactory : undefined
    this.onState = options.onState ?? (() => {})
    this.onFinalTranscript = options.onFinalTranscript ?? (() => {})
    this.language = options.language ?? 'zh-CN'
    this.maxDurationMs = options.maxDurationMs ?? 60_000
    if (!Number.isInteger(this.maxDurationMs) || this.maxDurationMs < 1 || this.maxDurationMs > 120_000) {
      throw new RangeError('maxDurationMs must be an integer between 1 and 120000')
    }
    this.enabled = false
    this.recognition = undefined
    this.generation = 0
    this.stopRequested = false
    this.finalTranscript = ''
    this.durationTimer = undefined
    this.phase = this.recognitionFactory === undefined ? 'unavailable' : 'disabled'
    this.emit(this.phase)
  }

  getState() {
    return { phase: this.phase, enabled: this.enabled, supported: this.recognitionFactory !== undefined }
  }

  setEnabled(enabled) {
    if (!enabled) {
      this.enabled = false
      this.cancel()
      this.emit(this.recognitionFactory === undefined ? 'unavailable' : 'disabled')
      return false
    }
    if (this.recognitionFactory === undefined) {
      this.enabled = false
      this.emit('unavailable', '此浏览器不支持语音输入')
      return false
    }
    this.enabled = true
    if (this.recognition === undefined) this.emit('idle')
    return true
  }

  start() {
    if (!this.enabled || this.recognitionFactory === undefined || this.recognition !== undefined) return false
    const recognition = this.recognitionFactory()
    if (recognition === undefined || recognition === null) {
      this.emit('error', '语音识别无法启动')
      return false
    }
    const generation = ++this.generation
    this.recognition = recognition
    this.stopRequested = false
    this.finalTranscript = ''
    recognition.lang = this.language
    recognition.continuous = false
    recognition.interimResults = true
    recognition.maxAlternatives = 1
    recognition.onstart = () => {
      if (!this.isCurrent(recognition, generation)) return
      this.emit('listening', '正在听')
    }
    recognition.onresult = event => {
      if (!this.isCurrent(recognition, generation)) return
      let transcript
      try {
        transcript = transcriptFromResults(event.results)
      } catch {
        this.cancel()
        this.emit('error', '语音转写内容过长')
        return
      }
      this.finalTranscript = transcript.final
      const visible = transcript.partial || transcript.final
      this.emit(this.stopRequested ? 'transcribing' : 'listening', this.stopRequested ? '正在转成文字' : '正在听', visible)
    }
    recognition.onerror = event => {
      if (!this.isCurrent(recognition, generation)) return
      this.recognition = undefined
      this.finalTranscript = ''
      this.clearDurationTimer()
      this.emit('error', errorMessage(event.error))
    }
    recognition.onend = () => {
      if (!this.isCurrent(recognition, generation)) return
      this.recognition = undefined
      this.clearDurationTimer()
      const finalTranscript = this.finalTranscript
      this.finalTranscript = ''
      if (finalTranscript.length > 0) {
        this.onFinalTranscript(finalTranscript)
        this.emit('idle', '已转成文字，请确认后发送', finalTranscript)
      } else {
        this.emit(this.enabled ? 'idle' : 'disabled')
      }
    }
    this.emit('listening', '正在启动麦克风')
    try {
      recognition.start()
      if (this.isCurrent(recognition, generation)) this.durationTimer = setTimeout(() => this.stop(), this.maxDurationMs)
      return true
    } catch {
      if (this.isCurrent(recognition, generation)) {
        this.recognition = undefined
        this.emit('error', '语音识别无法启动')
      }
      return false
    }
  }

  stop() {
    if (this.recognition === undefined || this.stopRequested) return false
    this.stopRequested = true
    this.clearDurationTimer()
    this.emit('transcribing', '正在转成文字')
    try {
      this.recognition.stop()
    } catch {
      this.cancel()
      this.emit('error', '语音识别无法停止')
    }
    return true
  }

  cancel() {
    const recognition = this.recognition
    this.generation += 1
    this.recognition = undefined
    this.finalTranscript = ''
    this.stopRequested = false
    this.clearDurationTimer()
    if (recognition !== undefined) {
      recognition.onstart = null
      recognition.onresult = null
      recognition.onerror = null
      recognition.onend = null
      try { recognition.abort() } catch {}
    }
    if (this.enabled && this.recognitionFactory !== undefined) this.emit('idle')
  }

  isCurrent(recognition, generation) {
    return this.recognition === recognition && this.generation === generation
  }

  clearDurationTimer() {
    if (this.durationTimer === undefined) return
    clearTimeout(this.durationTimer)
    this.durationTimer = undefined
  }

  emit(phase, message, transcript) {
    this.phase = phase
    this.onState({
      phase,
      enabled: this.enabled,
      supported: this.recognitionFactory !== undefined,
      ...(message === undefined ? {} : { message }),
      ...(transcript === undefined || transcript.length === 0 ? {} : { transcript }),
    })
  }
}
