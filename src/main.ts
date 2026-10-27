import { join } from 'node:path'
import { AttentionManager } from './attention.ts'
import { loadConfig, ensureRuntimeDirs } from './config.ts'
import { ActionManager } from './actions.ts'
import { Conversation } from './conversation.ts'
import { SessionStore } from './sessions.ts'
import { ProfileStore } from './profile.ts'
import { ToolJournal } from './tool-journal.ts'
import { ToolRuntime } from './tools.ts'
import { builtinTools } from './builtin-tools.ts'
import { discoveryTool } from './tool-discovery.ts'
import { McpManager } from './mcp/manager.ts'
import { McpPresets } from './mcp/presets.ts'
import { reminderTools } from './reminder-tools.ts'
import { LocalToolSettings } from './local-tools/settings.ts'
import { FileTools } from './local-tools/files.ts'
import { TaskTools } from './local-tools/tasks.ts'
import { personalTools } from './local-tools/personal.ts'
import { calculationTools } from './local-tools/calculate.ts'
import { skillTools } from './local-tools/skills.ts'
import { WebTools } from './local-tools/web.ts'
import { describeCapture } from './senses/vision.ts'
import { EventBus } from './events.ts'
import { createLogger, defaultLogFile } from './logger.ts'
import { BriefScheduler } from './brief.ts'
import { Notifier } from './notify.ts'
import { TuningStore } from './tuning.ts'
import { TelemetryCollector } from './telemetry.ts'
import { MemoryStore } from './memory/store.ts'
import { ModelRouter, createModelClient } from './model/router.ts'
import { ModelSettingsStore } from './model/settings.ts'
import { ProactivePolicy } from './proactive/policy.ts'
import { ReminderScheduler, ReminderStore } from './proactive/reminders.ts'
import { CameraCapture } from './senses/camera.ts'
import { OcrClient } from './senses/ocr.ts'
import { ScreenCapture } from './senses/screen.ts'
import { JarvisServer } from './server.ts'
import { SecureFiles } from './secure-files.ts'
import { WhisperTranscriber } from './voice/asr.ts'
import { FasterWhisperTranscriber } from './voice/faster-whisper.ts'
import { PiperSynthesizer } from './voice/tts.ts'
import { VoiceRuntime } from './voice/runtime.ts'
import { VoiceHealthStore } from './voice/health.ts'
import { VoiceSettingsStore } from './voice/settings.ts'

async function main(): Promise<void> {
  process.umask(0o077)
  const config = loadConfig()
  ensureRuntimeDirs(config)
  const secure = new SecureFiles(config.dataDir)
  secure.encryptDirectory(join(config.dataDir, 'captures'))
  secure.encryptDirectory(join(config.dataDir, 'audio'))
  secure.encryptJsonl(join(config.dataDir, 'telemetry.jsonl'))
  const logger = createLogger((process.env.JARVIS_LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error' | undefined) ?? 'info', defaultLogFile(config.dataDir))
  const bus = new EventBus(300)
  const tuning = new TuningStore(join(config.dataDir, 'tuning.json'), config)
  await tuning.load()
  const attention = new AttentionManager(bus, tuning)
  const telemetry = new TelemetryCollector(bus, { file: join(config.dataDir, 'telemetry.jsonl'), secure })
  const modelSettings = new ModelSettingsStore(join(config.dataDir, 'model-config.json'), {
    local: {
      baseUrl: config.ollama.url,
      model: config.ollama.model,
      visionModel: config.ollama.visionModel,
      embedModel: config.ollama.embedModel,
      keepAlive: config.ollama.keepAlive,
    },
  })
  const savedModels = await modelSettings.load()
  const activeProfile = savedModels.profiles.find(item => item.id === savedModels.active) ?? savedModels.profiles[0]
  const localProfile = savedModels.profiles.find(item => item.id === 'local') ?? activeProfile
  const localModel = createModelClient(localProfile)
  const model = new ModelRouter(
    activeProfile.id === 'local' ? localModel : createModelClient(activeProfile),
    activeProfile,
    logger.child('model'),
    { embedding: localModel, vision: localModel },
    {
      loadSettings: () => modelSettings.load(),
      persistCooldown: (id, entry) => modelSettings.setCooldown(id, entry),
      emit: (event, payload) => bus.emit(event, payload),
    },
  )
  const memory = new MemoryStore({
    file: join(config.dataDir, 'jarvis.db'),
    // Memory and profile content never leaves the machine for embeddings.
    embedder: {model:localModel.embedModel,embed:async(text:string)=>localModel.isLocal===true?localModel.embed(text):null},
    bus,
    tuning,
    logger: logger.child('memory'),
  })
  const profile = new ProfileStore(memory)
  const sessions = new SessionStore({ file: join(config.dataDir, 'sessions.db') })
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
    getVoiceParams: () => ({
      lengthScale: tuning.number('voice.lengthScale'),
      noiseScale: tuning.number('voice.noiseScale'),
      noiseW: tuning.number('voice.noiseW'),
      maxChars: Math.round(tuning.number('voice.maxChars')),
    }),
  })
  const voiceSettings = new VoiceSettingsStore(join(config.dataDir, 'voice-config.json'), {
    asrModel: config.voice.asrEngine === 'faster-whisper' ? config.voice.fasterWhisperModel : config.voice.whisperModel,
    asrEngine: config.voice.asrEngine,
    asrLanguage: 'zh',
    ttsVoice: config.voice.piperVoice,
  })
  const voiceHealth = new VoiceHealthStore(join(config.dataDir, 'voice-health.json'))
  const voice = new VoiceRuntime({
    store: voiceSettings,
    localTranscriber: transcriber,
    localSynthesizer: synthesizer,
    ffmpeg: config.voice.ffmpeg,
    logger: logger.child('voice'),
    health: voiceHealth,
    emit: (event, payload) => bus.emit(event, payload),
  })
  await voice.initialize()
  const screen = new ScreenCapture(config, logger.child('screen'))
  const camera = new CameraCapture(config, logger.child('camera'))
  const ocr = new OcrClient({ pythonBin: config.voice.pythonBin, script: config.voice.ocrScript, logger: logger.child('ocr') })
  const actions = new ActionManager({
    bus,
    logger: logger.child('actions'),
    auditFile: join(config.dataDir, 'audit', 'actions.jsonl'),
  })
  const toolJournal = new ToolJournal(sessions)
  const mcp = new McpManager({file:join(config.dataDir,'mcp-config.json'),onChanged:()=>bus.emit('mcp.changed',{at:Date.now()})})
  await mcp.initialize()
  const presets = new McpPresets({manager:mcp})
  const localSettings = new LocalToolSettings(join(config.dataDir,'local-tools.json'),join(config.dataDir,'artifacts'))
  await localSettings.load()
  const localVision = async (bytes:Buffer,prompt:string,signal:AbortSignal) => {
    const client=model.localClient()
    if(client.isLocal!==true)throw new Error('图像分析需要经过验证的本地模型。')
    signal.throwIfAborted()
    return client.vision(bytes,prompt,{signal})
  }
  const fileTools = new FileTools({settings:localSettings,bus,storageFile:join(config.dataDir,'local-files.json'),localVision})
  const taskTools = new TaskTools({file:join(config.dataDir,'local-tasks.db'),bus,settings:localSettings})
  await taskTools.initialize()
  const webTools = new WebTools({settings:localSettings})
  const inspect = async (target:'screen'|'camera',prompt:string,signal:AbortSignal):Promise<string> => {
    const client=model.localClient()
    if(client.isLocal!==true)throw new Error('屏幕和摄像头只能使用本地模型。')
    signal.throwIfAborted()
    const capture=await (target==='screen'?screen:camera).capture(join(config.dataDir,'captures'))
    try {signal.throwIfAborted();return await describeCapture(client,capture,prompt,signal,ocr,target==='camera')}
    finally {await secure.encryptFile(capture.path)}
  }
  const builtins = [
    ...builtinTools({memory,reminders,actions}).filter(d=>!d.name.startsWith('reminder')&&d.name!=='open_target'),
    ...reminderTools(reminders),...calculationTools(),
    ...personalTools({memory,sessions,profile,inspectScreen:(prompt,signal)=>inspect('screen',prompt,signal),inspectCamera:(prompt,signal)=>inspect('camera',prompt,signal)}),
  ]
  const definitions=()=>[...builtins,...fileTools.definitions(),...taskTools.definitions(),...webTools.definitions(),...skillTools({settings:localSettings}),...mcp.definitions()]
  const tools = new ToolRuntime({definitions:()=>[discoveryTool(definitions),...definitions()],journal:toolJournal,bus})
  const policy = new ProactivePolicy(config)
  const conversation = new Conversation({
    tools, toolJournal,
    config,
    bus,
    attention,
    memory,
    sessions,
    profile,
    model,
    transcriber: voice,
    synthesizer: voice,
    voice,
    screen,
    camera,
    ocr,
    actions,
    reminders,
    policy,
    tuning,
    secure,
    modelSettings,
    logger: logger.child('conversation'),
  })

  // Start the slow local workers immediately, in parallel with the model and
  // TTS warm-up. The HTTP server can open while Whisper is still loading; the
  // status endpoint now reports `voice.asrState` so the UI can explain why the
  // first utterance is queued instead of looking frozen.
  if (voice.status().asr.kind === 'local') {
    void voice.start().catch(error => logger.warn('ASR warm-up failed', { error: String(error) }))
  }
  void ocr.start().catch(error => logger.warn('OCR warm-up failed', { error: String(error) }))
  await conversation.initialize()

  const scheduler = new ReminderScheduler(reminders, reminder => conversation.handleReminder(reminder), bus)
  const briefScheduler = new BriefScheduler(memory, reminders, bus, process.env.JARVIS_BRIEF_TIME || '08:30', process.env.JARVIS_CALENDAR_ICS, logger.child('brief'))
  const notifier = new Notifier(logger.child('notify'))
  bus.on('reminder.due', event => {
    if (policy.isQuiet() || policy.isFocus()) return
    const reminder = (event.data as { reminder?: { text?: string } }).reminder
    if (reminder?.text) notifier.send('Jarvis · 提醒', reminder.text)
  })
  bus.on('brief.ready', event => {
    if (policy.isQuiet() || policy.isFocus()) return
    const brief = (event.data as { brief?: { headline?: string } }).brief
    if (brief?.headline) notifier.send('Jarvis · 今日简报', brief.headline)
  })

  const server = new JarvisServer({
    localSettings, fileTools, taskTools,
    tools, toolJournal, mcp, presets,
    config,
    bus,
    attention,
    conversation,
    models: model,
    modelSettings,
    voiceSettings,
    voice,
    tuning,
    telemetry,
    actions,
    memory,
    sessions,
    profile,
    reminders,
    policy,
    secure,
    logger: logger.child('server'),
  })
  const { url } = await server.start()
  // Start schedulers only after the server and desktop-notification handlers are
  // live. Otherwise an overdue reminder is consumed at boot with nobody listening.
  scheduler.start()
  briefScheduler.start()
  logger.info(`Jarvis v${config.version} listening`, {
    url,
    model: model.model,
    asr: voice.status().asr.label,
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

  // Consolidation is a background maintenance job, never on the chat path.
  // Exact duplicates, supersedes chains and expired proposals are safe to
  // retire automatically; the evidence stays in memory_events.
  const consolidate = setInterval(() => {
    void memory.consolidate()
      .then(stats => logger.info('memory consolidated', { ...stats }))
      .catch(error => logger.warn('memory consolidation failed', { error: String(error) }))
  }, 6 * 60 * 60 * 1000)
  consolidate.unref()
  setTimeout(() => {
    void memory.consolidate()
      .then(stats => logger.info('memory consolidated', { ...stats }))
      .catch(error => logger.warn('memory consolidation failed', { error: String(error) }))
  }, 5 * 60 * 1000).unref()

  let stopping = false
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return
    stopping = true
    logger.info('shutting down', { signal })
    clearInterval(cleanup)
    clearInterval(consolidate)
    scheduler.stop()
    briefScheduler.stop()
    await conversation.quiesce()
    await taskTools.close()
    await mcp.close()
    await server.close().catch(() => undefined)
    await voice.close().catch(() => undefined)
    await ocr.close().catch(() => undefined)
    reminders.close()
    memory.close()
    sessions.close()
    telemetry.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})