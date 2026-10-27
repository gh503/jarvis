import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteSynthesizer, RemoteTranscriber } from '../src/voice/remote.ts'
import type { AsrProfile, TtsProfile } from '../src/voice/settings.ts'
import { mergeVoiceUpdate, VoiceSettingsStore } from '../src/voice/settings.ts'
import { EdgeSynthesizer } from '../src/voice/edge.ts'

function wavBuffer(ms = 100, rate = 16000): Buffer {
  const samples = Math.round(rate * ms / 1000)
  const data = Buffer.alloc(samples * 2)
  for (let index = 0; index < samples; index += 1) {
    data.writeInt16LE(Math.round(Math.sin(index / 8) * 1200), index * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ server: ReturnType<typeof createServer>; base: string }> {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  return { server, base: `http://127.0.0.1:${address.port}` }
}

const asrBase: AsrProfile = {
  id: 'remote', label: '远端 ASR', kind: 'remote', transport: 'http',
  baseUrl: '', model: 'gemini-3.5-transcribe', apiKey: 'gemini-key', language: 'zh', adapter: 'gemini',
}

const ttsBase: TtsProfile = {
  id: 'remote', label: '远端 TTS', kind: 'remote', baseUrl: '',
  model: 'gemini-3.8-flash-tts', voice: 'Kore', apiKey: 'gemini-key', adapter: 'gemini',
}

test('Gemini ASR sends inline audio and parses candidate text', async () => {
  let path = ''
  let key = ''
  let body: any = null
  const { server, base } = await listen((request, response) => {
    path = request.url ?? ''
    key = String(request.headers['x-goog-api-key'] ?? '')
    let raw = ''
    request.on('data', chunk => { raw += chunk })
    request.on('end', () => {
      body = JSON.parse(raw)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: '你好世界' }] } }] }))
    })
  })
  const transcriber = new RemoteTranscriber({ profile: { ...asrBase, baseUrl: `${base}/v1beta` }, ffmpeg: 'false' })
  try {
    const result = await transcriber.transcribe(wavBuffer(100), 'wav')
    assert.equal(result.text, '你好世界')
    assert.equal(path, '/v1beta/models/gemini-3.5-transcribe:generateContent')
    assert.equal(key, 'gemini-key')
    const part = body.contents[0].parts[1]
    assert.equal(part.inline_data.mime_type, 'audio/wav')
    assert.ok(part.inline_data.data.length > 100)
  } finally {
    server.close()
  }
})

test('Gemini TTS turns PCM inline audio into a WAV file', async () => {
  const rate = 24_000
  const pcm = wavBuffer(40, rate).subarray(44)
  let voice = ''
  const { server, base } = await listen((request, response) => {
    let raw = ''
    request.on('data', chunk => { raw += chunk })
    request.on('end', () => {
      const body = JSON.parse(raw)
      voice = body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: `audio/L16;codec=pcm;rate=${rate}`, data: pcm.toString('base64') } }] } }],
      }))
    })
  })
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-gemini-tts-'))
  try {
    const synthesizer = new RemoteSynthesizer({ profile: { ...ttsBase, baseUrl: `${base}/v1beta` } })
    const output = join(dir, 'reply.wav')
    await synthesizer.synthesize('你好', output)
    const wav = await readFile(output)
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
    assert.equal(wav.readUInt32LE(24), rate)
    assert.equal(voice, 'Kore')
    assert.ok(wav.length > pcm.length)
  } finally {
    await rm(dir, { recursive: true, force: true })
    server.close()
  }
})

test('Cloudflare ASR posts raw WAV to the account AI run endpoint', async () => {
  let path = ''
  let auth = ''
  let bytes = 0
  const expected = wavBuffer(80)
  const { server, base } = await listen((request, response) => {
    path = request.url ?? ''
    auth = String(request.headers.authorization ?? '')
    request.on('data', chunk => { bytes += chunk.length })
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ result: { text: '云端识别', language: 'zh' } }))
    })
  })
  const profile: AsrProfile = {
    ...asrBase, adapter: 'cloudflare', model: '@cf/openai/whisper',
    baseUrl: `${base}/client/v4/accounts/acct/ai/v1`, apiKey: 'cf-key',
  }
  const transcriber = new RemoteTranscriber({ profile, ffmpeg: 'false' })
  try {
    const result = await transcriber.transcribe(expected, 'wav')
    assert.equal(result.text, '云端识别')
    assert.equal(path, '/client/v4/accounts/acct/ai/run/@cf/openai/whisper')
    assert.equal(auth, 'Bearer cf-key')
    assert.equal(bytes, expected.length)
  } finally {
    server.close()
  }
})

test('Cloudflare TTS sends prompt/lang and saves returned WAV', async () => {
  const expected = wavBuffer(60)
  let body: any = null
  const { server, base } = await listen((request, response) => {
    let raw = ''
    request.on('data', chunk => { raw += chunk })
    request.on('end', () => {
      body = JSON.parse(raw)
      response.writeHead(200, { 'content-type': 'audio/wav' })
      response.end(expected)
    })
  })
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-cf-tts-'))
  const profile: TtsProfile = {
    ...ttsBase, adapter: 'cloudflare', model: '@cf/myshell-ai/melotts', voice: 'zh',
    baseUrl: `${base}/client/v4/accounts/acct/ai/v1`, apiKey: 'cf-key',
  }
  try {
    const synthesizer = new RemoteSynthesizer({ profile })
    const output = join(dir, 'reply.wav')
    await synthesizer.synthesize('你好', output)
    assert.deepEqual(await readFile(output), expected)
    assert.equal(body.prompt, '你好')
    assert.equal(body.lang, 'zh')
  } finally {
    await rm(dir, { recursive: true, force: true })
    server.close()
  }
})

test('voice settings support Edge TTS without an HTTP address and normalize native adapters', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-edge-settings-'))
  const store = new VoiceSettingsStore(join(dir, 'voice.json'), {
    asrModel: 'tiny', asrEngine: 'faster-whisper', asrLanguage: 'zh', ttsVoice: '/models/zh.onnx',
  })
  const base = await store.load()
  const settings = mergeVoiceUpdate(base, {
    tts: [
      { id: 'edge', kind: 'remote', adapter: 'edge', voice: 'zh-CN-XiaoxiaoNeural', model: '', baseUrl: '', apiKey: '' },
      { ...base.tts[0], apiKey: '' },
    ],
    asr: [
      { id: 'gemini', kind: 'remote', adapter: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.5-transcribe', transport: 'websocket' },
      { ...base.asr[0], apiKey: '' },
    ],
  })
  assert.equal(settings.tts[0].adapter, 'edge')
  assert.equal(settings.tts[0].baseUrl, '')
  assert.equal(settings.tts[0].model, 'edge-tts')
  assert.equal(settings.asr[0].transport, 'http')
  await store.save(settings)
  const loaded = await store.load()
  assert.equal(loaded.tts[0].adapter, 'edge')
  await rm(dir, { recursive: true, force: true })
})

test('Edge synthesizer reports whether the local command exists', async () => {
  const missing = new EdgeSynthesizer({ voice: 'zh-CN-XiaoxiaoNeural', ffmpeg: 'ffmpeg', bin: '/nonexistent/jarvis-edge-tts' })
  assert.equal(await missing.available(), false)
  const present = new EdgeSynthesizer({ voice: 'zh-CN-XiaoxiaoNeural', ffmpeg: 'ffmpeg', bin: 'sh' })
  assert.equal(await present.available(), true)
})
