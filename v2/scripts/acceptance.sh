#!/usr/bin/env bash
# End-to-end checks that do not need a human to click a portal dialog.
# The screen portal and microphone are tested separately in operations.md.
set -euo pipefail
BASE="${JARVIS_URL:-http://127.0.0.1:3081}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31mFAIL:\033[0m %s\n' "$*" >&2; exit 1; }
json() { python3 -c 'import json,sys; print(json.load(sys.stdin).get(sys.argv[1], ""))' "$1"; }

say "health"
HEALTH="$(curl -fsS --noproxy '*' "$BASE/api/health")"
echo "$HEALTH" | python3 -m json.tool
echo "$HEALTH" | grep -q '"ok":true' || fail "health is not ok"

say "text turn + local model"
TEXT="验收测试：用一句话回答，今天适合做什么？"
REPLY="$(curl -fsS --noproxy '*' -X POST "$BASE/api/chat" -H 'content-type: application/json' \
  -d "{\"text\":\"$TEXT\"}" | json reply)"
[ -n "$REPLY" ] || fail "empty reply"
printf 'reply: %s\n' "$REPLY"

say "cross-origin request is rejected"
CODE="$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' -X POST "$BASE/api/chat" -H 'content-type: application/json' -H 'Origin: https://evil.example' -d '{"text":"hi"}')"
[ "$CODE" = "403" ] || fail "cross-origin request returned $CODE"
echo "cross-origin ok (403)"

say "memory write / recall / delete"
MEM="验收记忆-$RANDOM：我的测试代号是 ORBIT-42。"
ID="$(curl -fsS --noproxy '*' -X POST "$BASE/api/memory" -H 'content-type: application/json' \
  -d "{\"content\":\"$MEM\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["item"]["id"])')"
FOUND="$(curl -fsS --noproxy '*' "$BASE/api/memory?query=ORBIT-42" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(sum(1 for item in d.get("items", []) if "ORBIT-42" in item.get("content", "")))')"
[ "$FOUND" -ge 1 ] || fail "memory was not recalled"
curl -fsS --noproxy '*' -X DELETE "$BASE/api/memory/$ID" >/dev/null
LEFT="$(curl -fsS --noproxy '*' "$BASE/api/memory?query=ORBIT-42" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(sum(1 for item in d.get("items", []) if "ORBIT-42" in item.get("content", "")))')"
[ "$LEFT" -eq 0 ] || fail "memory still recalled after delete"
echo "memory ok ($ID)"

say "confirmation-gated action"
curl -fsS --noproxy '*' -X POST "$BASE/api/chat" -H 'content-type: application/json'   -d '{"text":"打开 https://example.com/acceptance"}' >/dev/null
ACTION_ID="$(curl -fsS --noproxy '*' "$BASE/api/actions" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["items"][0]["id"] if d["items"] else "")')"
[ -n "$ACTION_ID" ] || fail "action was not proposed"
curl -fsS --noproxy '*' -X POST "$BASE/api/actions/$ACTION_ID/deny" -H 'content-type: application/json' -d '{}' >/dev/null
echo "action ok ($ACTION_ID)"

say "reminder add / complete"
DUE="$(date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%SZ)"
RID="$(curl -fsS --noproxy '*' -X POST "$BASE/api/reminders" -H 'content-type: application/json' \
  -d "{\"text\":\"验收提醒\",\"dueAt\":\"$DUE\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["reminder"]["id"])')"
curl -fsS --noproxy '*' -X POST "$BASE/api/reminders/$RID/complete" >/dev/null
echo "reminder ok ($RID)"

say "OCR worker"
node --experimental-transform-types --input-type=module - <<'NODE'
import { existsSync, copyFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { OcrClient } from './src/senses/ocr.ts'
const image = '/tmp/jarvis-acceptance-ocr.png'
try {
  execFileSync('python3', ['-c', `
from PIL import Image, ImageDraw, ImageFont
im = Image.new('RGB', (900, 220), 'white')
d = ImageDraw.Draw(im)
font = ImageFont.truetype('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', 42)
d.text((30, 60), '验收通过：Jarvis OCR 42', font=font, fill='black')
im.save('${image}')
`])
} catch {
  if (existsSync('/tmp/ocr-test.png')) copyFileSync('/tmp/ocr-test.png', image)
  else throw new Error('cannot create an OCR fixture image')
}
const ocr = new OcrClient({ pythonBin: 'python3', script: 'scripts/ocr_worker.py' })
await ocr.start()
const result = await ocr.recognize(image)
await ocr.close()
console.log(result.text)
if (!result.text.includes('42')) process.exit(1)
NODE

if [ -f /tmp/piper-test-16k.wav ]; then
  say "voice: ASR -> LLM -> TTS"
  curl -fsS --noproxy '*' -X POST "$BASE/api/voice" -H 'content-type: audio/wav' \
    --data-binary @/tmp/piper-test-16k.wav | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("transcript")); print(d.get("reply")); print(d.get("audioUrl"))' \
    | tee "$TMP/voice.txt"
  grep -q '/api/audio/' "$TMP/voice.txt" || fail "voice produced no audio URL"
else
  say "voice skipped (no /tmp/piper-test-16k.wav)"
fi

say "all unattended checks passed"
