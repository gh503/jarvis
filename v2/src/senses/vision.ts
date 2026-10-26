import { readFile } from 'node:fs/promises'
import type { ModelClient } from '../model/ollama.ts'
import type { OcrClient } from './ocr.ts'
import type { Capture } from './screen.ts'

const MAX_IMAGE_BYTES = 12 * 1024 * 1024

/** Keep the OCR prompt small enough for a 3B model on CPU/4 GB VRAM. */
export function selectOcrExcerpt(text: string, query: string, maxChars = 2800): string {
  if (text.length <= maxChars) return text
  const lines = text.split(/\n+/).map(line => line.trim()).filter(Boolean)
  const queryChars = new Set([...query].filter(char => /[\p{L}\p{N}]/u.test(char)))
  const scored = lines.map((line, index) => ({
    line, index,
    score: [...queryChars].filter(char => line.includes(char)).length * 4 + (index < 8 ? 2 : 0),
  })).sort((a, b) => b.score - a.score)
  const chosen = new Set<number>()
  let used = 0
  for (const item of scored) {
    if (used + item.line.length + 1 > maxChars) continue
    chosen.add(item.index)
    used += item.line.length + 1
  }
  if (chosen.size === 0) return text.slice(0, maxChars)
  return lines.filter((_line, index) => chosen.has(index)).join('\n').slice(0, maxChars)
}

async function describeText(
  client: ModelClient,
  text: string,
  mode: string,
  userText: string,
  signal?: AbortSignal,
): Promise<string> {
  const prompt = [
    `这是从用户${mode}里本地 OCR 出来的文字（可能有错字、漏字或顺序问题）。`,
    '只根据这些文字回答用户；不要编造文字里没有的条款、数字或人名。',
    '如果文字不足以回答，直接说“画面里的文字不够”，并指出你看到了什么主题。',
    '用中文，先给结论，再给必要的细节。',
    '',
    `用户说：${userText || '帮我看看这个。'}`,
    '',
    'OCR 文字：',
    selectOcrExcerpt(text, userText),
  ].join('\n')
  return await client.chatOnce([{ role: 'user', content: prompt }], {
    signal,
    timeoutMs: 35_000,
    temperature: 0.2,
    numCtx: 4096,
  })
}

async function describeImage(
  client: ModelClient,
  capture: Capture,
  userText: string,
  signal?: AbortSignal,
): Promise<string> {
  const image = await readFile(capture.path)
  if (image.byteLength > MAX_IMAGE_BYTES) {
    throw new Error('画面太大，已拒绝发送；请缩小窗口后重试')
  }
  const mode = capture.source === 'camera' ? '摄像头画面' : '当前屏幕'
  const prompt = [
    `这是用户的${mode}。请先快速判断画面里最重要的内容，再回答用户。`,
    '要求：',
    '1. 只描述你真正看得见的内容；看不清就说看不清，不要猜。',
    '2. 如果画面里有文字，尽量准确引用关键行，不要编造条款、数字或人名。',
    '3. 用中文、口语化，先给结论，再给必要的细节。',
    '4. 如果涉及隐私（密码、证件号、私人聊天），只提醒风险，不复述具体值。',
    '',
    `用户说：${userText || '帮我看看这个。'}`,
  ].join('\n')
  return await client.vision(image, prompt, {
    signal,
    timeoutMs: 120_000,
    temperature: 0.2,
  })
}

export async function describeCapture(
  client: ModelClient,
  capture: Capture,
  userText: string,
  signal?: AbortSignal,
  ocr?: OcrClient,
  allowVision = false,
): Promise<string> {
  if (ocr && (capture.source === 'camera' || capture.source === 'portal' || capture.source === 'x11')) {
    let ocrFailed = false
    try {
      const result = await ocr.recognize(capture.path)
      if (result.text.trim().length >= 6) {
        return await describeText(client, result.text, capture.source === 'camera' ? '摄像头画面' : '当前屏幕', userText, signal)
      }
      if (!allowVision) {
        return '屏幕里没有读到可识别的文字。如果这是一张图片或视频，可以对我说“用视觉看屏幕”，我再调用视觉模型。'
      }
    } catch {
      ocrFailed = true
    }
    if (ocrFailed && !allowVision && capture.source !== 'camera') {
      return '本地 OCR 没有跑起来；为了不让你等两分钟，我先不调用视觉模型。可以运行 npm run doctor 检查 RapidOCR，或对我说“用视觉看屏幕”。'
    }
  }
  return await describeImage(client, capture, userText, signal)
}
