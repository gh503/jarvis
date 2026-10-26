import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { RemoteSynthesizer, RemoteTranscriber } from '../src/voice/remote.ts'
import type { AsrProfile, TtsProfile } from '../src/voice/settings.ts'

function wavBuffer(ms = 100): Buffer {
  const samples = Math.round(16000 * ms / 1000)
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
  header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(32000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

const asrProfile: AsrProfile = {
  id: 'remote', label: '远端 ASR', kind: 'remote', transport: 'http',
  baseUrl: '', model: 'whisper-1', apiKey: 'sk-test', language: 'zh',
}

test('remote ASR HTTP posts multipart audio and parses JSON', async () => {
  let contentType = ''
  let auth = ''
  const server = createServer((request, response) => {
    contentType = String(request.headers['content-type'] ?? '')
    auth = String(request.headers.authorization ?? '')
    request.on('data', () => undefined)
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ text: '你好世界', language: 'zh' }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  const transcriber = new RemoteTranscriber({
    profile: { ...asrProfile, baseUrl: `http://127.0.0.1:${address.port}/v1` },
    ffmpeg: 'false',
  })
  try {
    const result = await transcriber.transcribe(wavBuffer(100), 'wav')
    assert.equal(result.text, '你好世界')
    assert.equal(result.language, 'zh')
    assert.ok((result.audioMs ?? 0) >= 90)
    assert.match(contentType, /multipart\/form-data/)
    assert.equal(auth, 'Bearer sk-test')
  } finally {
    server.close()
  }
})

test('remote ASR WebSocket streams start, PCM frames and end', async () => {
  const messages: string[] = []
  let binaryBytes = 0
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>(resolve => wss.once('listening', () => resolve()))
  const address = wss.address()
  if (!address || typeof address === 'string') throw new Error('no ws port')
  wss.on('connection', socket => {
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
        binaryBytes += bytes.length
        return
      }
      const text = data.toString()
      messages.push(text)
      const parsed = JSON.parse(text) as { type?: string }
      if (parsed.type === 'end') {
        socket.send(JSON.stringify({ type: 'partial', text: '你' }))
        socket.send(JSON.stringify({ type: 'final', text: '你好', language: 'zh' }))
      }
    })
  })
  const transcriber = new RemoteTranscriber({
    profile: { ...asrProfile, transport: 'websocket', baseUrl: `ws://127.0.0.1:${address.port}/v1/stream` },
    ffmpeg: 'false',
  })
  try {
    const result = await transcriber.transcribe(wavBuffer(120), 'wav')
    assert.equal(result.text, '你好')
    assert.ok(binaryBytes > 0)
    assert.equal(messages.some(item => item.includes('"start"')), true)
    assert.equal(messages.some(item => item.includes('"end"')), true)
  } finally {
    await new Promise<void>(resolve => wss.close(() => resolve()))
  }
})

test('remote TTS saves the returned audio', async () => {
  const expected = wavBuffer(40)
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', chunk => { raw += chunk })
    request.on('end', () => {
      assert.ok(raw.includes('"input":"你好"'))
      response.writeHead(200, { 'content-type': 'audio/wav' })
      response.end(expected)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-tts-test-'))
  const profile: TtsProfile = {
    id: 'remote', label: '远端 TTS', kind: 'remote', baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: 'tts-1', voice: 'alloy', apiKey: 'sk-tts',
  }
  const synthesizer = new RemoteSynthesizer({ profile })
  try {
    const output = join(dir, 'reply.wav')
    await synthesizer.synthesize('你好', output)
    assert.deepEqual(await readFile(output), expected)
  } finally {
    await synthesizer.close()
    await rm(dir, { recursive: true, force: true })
    server.close()
  }
})
