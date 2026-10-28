import test from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SecureFiles } from '../src/secure-files.ts'
import type { ModelClient } from '../src/model/types.ts'
import { browserCaptureIdentity, describeBrowserCapture, storeBrowserCapture, validateBrowserCapture, MAX_BROWSER_CAPTURE_BYTES } from '../src/senses/browser-capture.ts'

function chunk(type: string, bytes: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), bytes]); let crc = 0xffffffff
  for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0) }
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4)
  length.writeUInt32BE(bytes.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([length, body, checksum])
}
function png(width = 1, height = 1, raw: Buffer = Buffer.from([0, 255, 0, 0, 255]), extra: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), extra, chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

test('browser PNG validator decodes bounded image and strips permitted metadata', async () => {
  const image = png(1, 1, undefined, chunk('sRGB', Buffer.from([0])))
  const result = await validateBrowserCapture(image, 'image/png')
  assert.equal(result.width, 1); assert.equal(result.height, 1)
  assert.deepEqual(result.image, png())
})

test('browser PNG rejects malformed, spoofed, animated and bomb payloads', async () => {
  const corrupt = png(); corrupt[45] ^= 1
  const cases = [Buffer.alloc(0), Buffer.from('<svg></svg>'), corrupt, png(4097), png(4096,4096), png(1,1,Buffer.alloc(1000)), png(1,1,Buffer.from([5,0,0,0,0])), png(1,1,undefined,chunk('acTL',Buffer.alloc(8))), png(1,1,undefined,chunk('tEXt',Buffer.from('secret'))), Buffer.concat([png(),Buffer.from('junk')]), Buffer.alloc(MAX_BROWSER_CAPTURE_BYTES+1)]
  for (const image of cases) await assert.rejects(validateBrowserCapture(image, 'image/png'))
  await assert.rejects(validateBrowserCapture(png(), 'image/jpeg'))
})

test('browser capture identity requires complete unambiguous session/turn/target', () => {
  assert.deepEqual(browserCaptureIdentity({ sessionId: 'a', turnId: 'b', target: 'screen' }), { sessionId:'a',turnId:'b',target:'screen' })
  for (const identity of [{}, {sessionId:'../a',turnId:'b',target:'screen'}, {sessionId:'a',turnId:'',target:'screen'}, {sessionId:'a',turnId:'b',target:'portal'}]) assert.throws(() => browserCaptureIdentity(identity))
})

test('browser capture storage is encrypted before touching disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-browser-capture-'))
  try {
    const secure = new SecureFiles(dir), capture = await validateBrowserCapture(png(), 'image/png')
    const stored = await storeBrowserCapture(capture, {sessionId:'session',turnId:'turn',target:'screen'}, dir, secure)
    const bytes = await readFile(stored.path)
    assert.ok(bytes.subarray(0,12).toString().startsWith('JARVIS-ENC1'))
    assert.deepEqual(secure.decryptBuffer(bytes), capture.image)
    assert.equal(stored.bytes, capture.image.length)
  } finally { await rm(dir, { recursive:true, force:true }) }
})

test('browser vision rejects remote and routing clients; supports cancellation', async () => {
  const capture = await validateBrowserCapture(png(), 'image/png'); let calls = 0
  const base = { isLocal:true, vision: async (image: Buffer) => { calls++; assert.deepEqual(image,capture.image); return 'local result' } }
  for (const client of [{...base,isLocal:false}, {...base,isLocal:undefined}, {...base,servingRemote:()=>true}, {...base,localClient:()=>base}]) {
    await assert.rejects(describeBrowserCapture(client as unknown as ModelClient,capture,'screen'), /local-only/)
  }
  assert.equal(calls,0)
  assert.equal(await describeBrowserCapture(base as unknown as ModelClient,capture,'screen'),'local result')
  const controller = new AbortController(); controller.abort(new Error('cancelled'))
  await assert.rejects(describeBrowserCapture(base as unknown as ModelClient,capture,'camera','',controller.signal), /cancelled/)
  assert.equal(calls,1)
})
