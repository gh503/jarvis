import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OcrClient } from '../src/senses/ocr.ts'
import { FasterWhisperTranscriber } from '../src/voice/faster-whisper.ts'

// A real subprocess checks the worker launch environment and binary protocol;
// no Python or model install is needed for this portability contract.
const worker = `
if (process.env.PYTHONUTF8 !== '1' || process.env.PYTHONIOENCODING !== 'utf-8' || process.env.PYTHONUNBUFFERED !== '1') {
  console.log(JSON.stringify({ready:false,error:'missing UTF8 environment'})); process.exit(1);
}
console.log(JSON.stringify({ready:true}));
let buffer = Buffer.alloc(0);
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  if (buffer.length < 8 || buffer.length < 8 + buffer.readUInt32BE(4)) return;
  const id = buffer.readUInt32BE(0);
  const payload = buffer.subarray(8, 8 + buffer.readUInt32BE(4)).toString('utf8');
  console.log(JSON.stringify({id,text:payload,lines:[payload],language:'zh',durationMs:1}));
});
`

test('OCR and ASR subprocesses force UTF8 and roundtrip Unicode worker output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-worker-utf8-'))
  const script = join(dir, 'worker 中文.cjs')
  await writeFile(script, worker)
  const ocr = new OcrClient({ pythonBin: process.execPath, script })
  const asr = new FasterWhisperTranscriber({ pythonBin: process.execPath, script, model: 'test', language: 'zh', ffmpeg: 'unused' })
  try {
    const path = join(dir, '图片 café 😀.png')
    assert.equal((await ocr.recognize(path)).text, path)
    assert.equal((await asr.transcribe(Buffer.from('语音 café 😀', 'utf8'))).text, '语音 café 😀')
  } finally {
    await ocr.close()
    await asr.close()
    await rm(dir, { recursive: true, force: true })
  }
})
