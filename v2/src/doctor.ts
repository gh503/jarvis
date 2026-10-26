import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { loadConfig, ensureRuntimeDirs } from './config.ts'
import { OllamaClient } from './model/ollama.ts'
import { fileExists } from './voice/media.ts'
import { commandExists, runProcess } from './util/process.ts'

interface Check {
  name: string
  ok: boolean
  required: boolean
  detail: string
}

const checks: Check[] = []

function add(name: string, ok: boolean, detail: string, required = true): void {
  checks.push({ name, ok, required, detail })
}

async function main(): Promise<void> {
  add('Node.js >= 24', Number(process.versions.node.split('.')[0]) >= 24, process.versions.node)
  let config
  try {
    config = loadConfig()
    ensureRuntimeDirs(config)
    add('configuration', true, `${config.host}:${config.port}, data=${config.dataDir}`)
  } catch (error) {
    add('configuration', false, error instanceof Error ? error.message : String(error))
    print()
    process.exitCode = 1
    return
  }

  const model = new OllamaClient(config.ollama.url, {
    model: config.ollama.model,
    visionModel: config.ollama.visionModel,
    embedModel: config.ollama.embedModel,
  })
  const health = await model.health(4000)
  add('Ollama reachable', health.ok, health.ok ? config.ollama.url : health.error ?? 'not reachable')
  if (health.ok) {
    const names = health.models.map(item => item.name)
    add(`LLM model ${config.ollama.model}`, names.some(name => name === config.ollama.model || name.startsWith(`${config.ollama.model}:`)), names.join(', ') || 'no models')
    add(`vision model ${config.ollama.visionModel}`, names.some(name => name === config.ollama.visionModel || name.startsWith(`${config.ollama.visionModel}:`)), names.join(', ') || 'no models', false)
    add(`embedding model ${config.ollama.embedModel}`, names.some(name => name === config.ollama.embedModel || name.startsWith(`${config.ollama.embedModel}:`)), names.join(', ') || 'no models', false)
  }

  add('ffmpeg', await commandExists('ffmpeg'), config.voice.ffmpeg)
  add('arecord', await commandExists(config.voice.arecord), config.voice.arecord, false)
  try {
    await access('/dev/video0')
    add('camera /dev/video0', true, 'present')
  } catch {
    add('camera /dev/video0', false, 'missing; camera look unavailable', false)
  }
  add('Piper binary', await fileExists(config.voice.piperBin), config.voice.piperBin)
  add('Piper voice', await fileExists(config.voice.piperVoice), config.voice.piperVoice)

  if (config.voice.asrEngine === 'faster-whisper') {
    try {
      const version = await runProcess(config.voice.pythonBin, ['-c', 'import faster_whisper; print(faster_whisper.__version__)'], { timeoutMs: 8000 })
      add('faster-whisper', true, version.stdout.trim() || 'installed')
    } catch (error) {
      add('faster-whisper', false, error instanceof Error ? error.message : String(error), true)
    }
    add('ASR worker', await fileExists(config.voice.fasterWhisperScript), config.voice.fasterWhisperScript)
    try {
      await runProcess(config.voice.pythonBin, ['-c', 'import rapidocr_onnxruntime; print("ok")'], { timeoutMs: 8000 })
      add('RapidOCR', true, 'installed')
    } catch (error) {
      add('RapidOCR', false, error instanceof Error ? error.message : String(error), false)
    }
  } else {
    add('whisper.cpp', await fileExists(config.voice.whisperBin), config.voice.whisperBin)
    add('whisper model', await fileExists(config.voice.whisperModel), config.voice.whisperModel)
  }

  const portal = join(import.meta.dirname, '..', 'scripts', 'screen_capture.py')
  add('OCR worker', await fileExists(config.voice.ocrScript), config.voice.ocrScript)
  add('screen portal helper', await fileExists(portal), portal)
  try {
    const python = await runProcess(config.voice.pythonBin, ['-c', 'import gi; gi.require_version("Gio","2.0"); print("ok")'], { timeoutMs: 5000 })
    add('Python Gio (portal)', python.stdout.trim() === 'ok', 'ok')
  } catch (error) {
    add('Python Gio (portal)', false, error instanceof Error ? error.message : String(error), false)
  }

  add('memory database', await fileExists(join(config.dataDir, 'jarvis.db')), join(config.dataDir, 'jarvis.db'), false)

  print()
  const failed = checks.filter(check => !check.ok && check.required)
  process.exitCode = failed.length ? 1 : 0
}

function print(): void {
  for (const check of checks) {
    const mark = check.ok ? '✓' : check.required ? '✗' : '!'
    console.log(`${mark} ${check.name.padEnd(28)} ${check.detail}`)
  }
  const failed = checks.filter(check => !check.ok && check.required)
  console.log('')
  console.log(failed.length ? `${failed.length} required check(s) failed.` : 'Core checks passed.')
}

void main().catch(error => {
  console.error(error)
  process.exit(1)
})