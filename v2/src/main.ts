import { join } from 'node:path'
import { AttentionManager } from './attention.ts'
import { loadConfig, ensureRuntimeDirs } from './config.ts'
import { ActionManager } from './actions.ts'
import { Conversation } from './conversation.ts'
import { EventBus } from './events.ts'
import { createLogger, defaultLogFile } from './logger.ts'
import { MemoryStore } from './memory/store.ts'
import { OllamaClient } from './model/ollama.ts'
import { ProactivePolicy } from './proactive/policy.ts'
import { ReminderScheduler, ReminderStore } from './proactive/reminders.ts'
import { CameraCapture } from './senses/camera.ts'
import { OcrClient } from './senses/ocr.ts'
import { ScreenCapture } from './senses/screen.ts'
import { JarvisServer } from './server.ts'
import { WhisperTranscriber } from './voice/asr.ts'
import { FasterWhisperTranscriber } from './voice/faster-whisper.ts'
import { PiperSynthesizer } from './voice/tts.ts'

async function main(): Promise<void> {
  const config = loadConfig()
  ensureRuntimeDirs(config)
  const logger = createLogger((process.env.JARVIS_LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error' | undefined) ?? 'info', defaultLogFile(config.dataDir))
  const bus = new EventBus(300)
  const attention = new AttentionManager(bus)
  const model = new OllamaClient(config.ollama.url, {
    model: config.ollama.model,
    visionModel: config.ollama.visionModel,
    embedModel: config.ollama.embedModel,
    keepAlive: config.ollama.keepAlive,
  })
  const memory = new MemoryStore({
    file: join(config.dataDir, 'jarvis.db'),
    embedder: model,
    bus,
    logger: logger.child('memory'),
  })
  const reminders = new ReminderStore(join(config.dataDir, 'jarvis.db'), bus)
  const transcriber =
    config.voice.asrEngine === 'whisper.cpp'
      ? new WhisperTranscriber({
          whisperBin: config.voice.whisperBin,
          model: config.voice.whisperModel,
          ffmpeg: config.voice.ffmpeg,
          logger: logger.child('asr'),
        })
      : new FasterWhisperTranscriber({
          pythonBin: config.voice.pythonBin,
          script: config.voice.fasterWhisperScript,
          model: config.voice.fasterWhisperModel,
          language: 'zh',
          ffmpeg: config.voice.ffmpeg,
          logger: logger.child('asr'),
        })
  const synthesizer = new PiperSynthesizer({
    piperBin: config.voice.piperBin,
    voice: config.voice.piperVoice,
    logger: logger.child('tts'),
  })
  const screen = new ScreenCapture(config, logger.child('screen'))
  const camera = new CameraCapture(config, logger.child('camera'))
  const ocr = new OcrClient({ pythonBin: config.voice.pythonBin, script: config.voice.ocrScript, logger: logger.child('ocr') })
  const actions = new ActionManager({
    bus,
    logger: logger.child('actions'),
    auditFile: join(config.dataDir, 'audit', 'actions.jsonl'),
  })
  const policy = new ProactivePolicy(config)
  const conversation = new Conversation({
    config,
    bus,
    attention,
    memory,
    model,
    transcriber,
    synthesizer,
    screen,
    camera,
    ocr,
    actions,
    reminders,
    policy,
    logger: logger.child('conversation'),
  })

  await conversation.initialize()
  // The chat/TTS path is warm before the UI opens. Whisper/OCR workers start
  // in the background so launch is not held hostage to their model load; by
  // the time a person has clicked the mic they are normally ready.
  if (transcriber instanceof FasterWhisperTranscriber) {
    void transcriber.start().catch(error => logger.warn('ASR warm-up failed', { error: String(error) }))
  }
  void ocr.start().catch(error => logger.warn('OCR warm-up failed', { error: String(error) }))

  const scheduler = new ReminderScheduler(reminders, reminder => conversation.handleReminder(reminder), bus)
  scheduler.start()

  const server = new JarvisServer({
    config,
    bus,
    attention,
    conversation,
    actions,
    memory,
    reminders,
    policy,
    logger: logger.child('server'),
  })
  const { url } = await server.start()
  logger.info(`Jarvis v${config.version} listening`, {
    url,
    model: config.ollama.model,
    asr: config.voice.asrEngine,
    mode: config.host === '127.0.0.1' ? 'local-only' : 'network',
  })
  if (config.host !== '127.0.0.1') {
    logger.info(`remote access token file: ${join(config.dataDir, 'auth-token')}`)
  }

  const cleanup = setInterval(() => {
    void conversation.cleanupAudio().catch(() => undefined)
    void conversation.cleanupCaptures().catch(() => undefined)
  }, 30 * 60 * 1000)
  cleanup.unref()

  let stopping = false
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return
    stopping = true
    logger.info('shutting down', { signal })
    clearInterval(cleanup)
    scheduler.stop()
    conversation.cancel()
    await server.close().catch(() => undefined)
    await transcriber.close?.().catch(() => undefined)
    await synthesizer.close().catch(() => undefined)
    await ocr.close().catch(() => undefined)
    reminders.close()
    memory.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})