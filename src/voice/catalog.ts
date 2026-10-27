/**
 * Voice catalogue: the single source of truth behind the "语音服务" section of
 * `/providers`, `/api/voice/catalog` and docs/voice-providers.md.
 *
 * Same rules as the model catalogue: public data only (no keys, no account
 * ids), conservative defaults, and an explicit `adapter` because the voice
 * layer is not uniformly OpenAI-compatible — Gemini and Cloudflare use their
 * own endpoints, Edge TTS is a local command, and vLLM/openedai-speech are
 * self-hosted.
 */
import type { AsrTransport } from './settings.ts'
import type { AsrAdapter, TtsAdapter } from './providers.ts'

export type VoiceKind = 'asr' | 'tts'
export type VoiceRegion = 'cn' | 'global' | 'local'
export type VoicePresetAdapter = 'auto' | AsrAdapter | TtsAdapter

export interface VoiceEntry {
  /** Stable id; `/providers` hands it to the settings form as `?voice=<id>`. */
  id: string
  name: string
  nameEn: string
  kind: VoiceKind
  region: VoiceRegion
  /** Which client implementation this preset targets. */
  adapter: VoicePresetAdapter
  /** ASR only. Remote ASR defaults to streaming; native adapters use http. */
  transport?: AsrTransport
  /** Empty for local engines and Edge TTS, which need no endpoint. */
  baseUrl: string
  model: string
  /** TTS voice name. Empty for ASR. */
  voice?: string
  /** Default transcription language code (ASR only). */
  language?: string
  keyUrl: string
  docsUrl: string
  freeTier: string
  summary: string
  setup: string[]
  cautions: string[]
  /** Reachable from mainland China without a proxy. */
  chinaDirect: boolean
  tags: string[]
}

const CATALOG: VoiceEntry[] = [
  // ------------------------------------------------------------------- ASR
  {
    id: 'local-faster-whisper',
    name: '本机 faster-whisper',
    nameEn: 'Local faster-whisper',
    kind: 'asr',
    region: 'local',
    adapter: 'auto',
    transport: 'http',
    baseUrl: '',
    model: 'small',
    language: 'zh',
    keyUrl: '',
    docsUrl: 'https://github.com/SYSTRAN/faster-whisper',
    freeTier: '完全免费，只用本机算力',
    summary: '默认方案：音频不出本机，CPU 可用，首次加载模型要几十秒。',
    setup: [
      '运行 npm run setup，或 pip install faster-whisper。',
      '在设置 → 语音里保持“本地引擎”。',
      '说出第一句话后，首次推理会慢一些，之后常驻内存。',
    ],
    cautions: [
      '模型越大越准也越慢；small 在普通笔记本上可用，tiny 更快但错字多。',
      '显存不足会自动落到 CPU，延迟明显上升。',
    ],
    chinaDirect: true,
    tags: ['离线', '免费', '隐私'],
  },
  {
    id: 'openai-whisper',
    name: 'OpenAI Whisper',
    nameEn: 'OpenAI Whisper',
    kind: 'asr',
    region: 'global',
    adapter: 'openai',
    transport: 'http',
    baseUrl: 'https://api.openai.com/v1',
    model: 'whisper-1',
    language: 'zh',
    keyUrl: 'https://platform.openai.com/api-keys',
    docsUrl: 'https://platform.openai.com/docs/guides/speech-to-text',
    freeTier: '无免费额度，按分钟计费（约 $0.006/分钟）',
    summary: '稳定、多语言、标点好；需要能直连 OpenAI。',
    setup: [
      '创建 API Key，确认账号已绑定支付方式。',
      '设置 → 语音 → ASR 选“远端服务”，服务商选 OpenAI 兼容。',
      '地址填 https://api.openai.com/v1，模型 whisper-1，粘贴 Key。',
    ],
    cautions: [
      '中国大陆无法直连；系统级代理用 HTTPS_PROXY，不要写进地址。',
      '上传的是整段音频，长录音按分钟累计费用。',
    ],
    chinaDirect: false,
    tags: ['多语言', '准确', '付费'],
  },
  {
    id: 'groq-whisper',
    name: 'Groq Whisper',
    nameEn: 'Groq Whisper',
    kind: 'asr',
    region: 'global',
    adapter: 'openai',
    transport: 'http',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'whisper-large-v3',
    language: 'zh',
    keyUrl: 'https://console.groq.com/keys',
    docsUrl: 'https://console.groq.com/docs/speech-to-text',
    freeTier: '有免费层，按速率限制',
    summary: '目前最快的转写之一，免费层够日常用；同样需要能直连。',
    setup: [
      '在 Groq 控制台创建 API Key（免费）。',
      '服务商选 OpenAI 兼容，地址 https://api.groq.com/openai/v1。',
      '模型填 whisper-large-v3 或 whisper-large-v3-turbo。',
    ],
    cautions: [
      '免费层有每分钟/每天的音频时长上限，超了返回 429。',
      '中国大陆无法直连。',
    ],
    chinaDirect: false,
    tags: ['快', '免费层', '多语言'],
  },
  {
    id: 'siliconflow-sensevoice',
    name: '硅基流动 SenseVoice',
    nameEn: 'SiliconFlow SenseVoice',
    kind: 'asr',
    region: 'cn',
    adapter: 'openai',
    transport: 'http',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'FunAudioLLM/SenseVoiceSmall',
    language: 'zh',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    docsUrl: 'https://docs.siliconflow.cn/cn/api-reference/audio/create-audio-transcriptions',
    freeTier: '该模型目前免费',
    summary: '国内直连、中文识别准、免费；英文混说也能应付。',
    setup: [
      '注册硅基流动并创建 API Key。',
      '服务商选 OpenAI 兼容，地址 https://api.siliconflow.cn/v1。',
      '模型填 FunAudioLLM/SenseVoiceSmall，语言 zh。',
    ],
    cautions: [
      '免费模型有并发限制，多人同时用会排队。',
      '模型名区分大小写，复制完整名称。',
    ],
    chinaDirect: true,
    tags: ['国内直连', '免费', '中文'],
  },
  {
    id: 'dashscope-paraformer',
    name: '阿里云百炼 Paraformer',
    nameEn: 'DashScope Paraformer',
    kind: 'asr',
    region: 'cn',
    adapter: 'openai',
    transport: 'http',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'paraformer-v2',
    language: 'zh',
    keyUrl: 'https://bailian.console.aliyun.com/',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/speech-recognition',
    freeTier: '新账号有试用额度，之后按量',
    summary: '中文长音频与方言强；但百炼的语音接口与其他家不完全一致。',
    setup: [
      '开通百炼并创建 API Key。',
      '先在控制台确认你的账号能调用“语音识别”服务。',
      '地址填兼容模式 https://dashscope.aliyuncs.com/compatible-mode/v1。',
    ],
    cautions: [
      '百炼的 OpenAI 兼容模式主要覆盖对话；转写走的是独立接口，若 /audio/transcriptions 返回 404，说明当前账号/模型不支持该路径，请改用硅基流动或本地方案。',
      '这是一个“可以试，但失败要能看懂原因”的预设，不保证开箱可用。',
    ],
    chinaDirect: true,
    tags: ['国内直连', '中文', '长音频'],
  },
  {
    id: 'gemini-audio',
    name: 'Google Gemini 音频',
    nameEn: 'Gemini audio',
    kind: 'asr',
    region: 'global',
    adapter: 'gemini',
    transport: 'http',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.0-flash',
    language: 'zh',
    keyUrl: 'https://aistudio.google.com/apikey',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/audio',
    freeTier: '免费层可用，有速率限制',
    summary: '把音频当多模态输入，顺带能理解语气；免费层友好。',
    setup: [
      '在 AI Studio 创建 API Key。',
      '服务商选 Gemini（原生），地址填 https://generativelanguage.googleapis.com/v1beta。',
      '模型填 gemini-2.0-flash。',
    ],
    cautions: [
      '免费层的数据会被用于改进产品；隐私内容请用本地方案。',
      '中国大陆无法直连。',
    ],
    chinaDirect: false,
    tags: ['多模态', '免费层'],
  },
  {
    id: 'cloudflare-whisper',
    name: 'Cloudflare Whisper',
    nameEn: 'Cloudflare Workers AI Whisper',
    kind: 'asr',
    region: 'global',
    adapter: 'cloudflare',
    transport: 'http',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1',
    model: '@cf/openai/whisper',
    language: 'zh',
    keyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    docsUrl: 'https://developers.cloudflare.com/workers-ai/models/whisper/',
    freeTier: '每天有免费 Neurons 配额',
    summary: '把 <ACCOUNT_ID> 换成账号 ID 即可，适合已经在用 Cloudflare 的人。',
    setup: [
      '创建带 Workers AI 权限的 API Token。',
      '把地址里的 <ACCOUNT_ID> 换成控制台右侧的账号 ID。',
      '服务商会自动识别为 Cloudflare，使用原生 /ai/run 端点。',
    ],
    cautions: [
      '模型名必须以 @cf/ 开头。',
      '免费额度按 Neurons 计算，长音频消耗更快。',
    ],
    chinaDirect: false,
    tags: ['免费层', '已有 Cloudflare'],
  },
  {
    id: 'selfhosted-funasr',
    name: '自建 FunASR（达摩院）',
    nameEn: 'Self-hosted FunASR',
    kind: 'asr',
    region: 'local',
    adapter: 'openai',
    transport: 'http',
    baseUrl: 'http://127.0.0.1:8000/v1',
    model: 'iic/SenseVoiceSmall',
    language: 'zh',
    keyUrl: '',
    docsUrl: 'https://github.com/modelscope/FunASR',
    freeTier: '自有算力，无调用费',
    summary: '中文与方言最强的开源方案之一，可以在内网完全离线跑。',
    setup: [
      '用 FunASR 的 runtime 启动服务（新版自带 OpenAI 兼容的 /v1/audio/transcriptions）。',
      '地址填 http://127.0.0.1:8000/v1，模型填 SenseVoiceSmall 对应的名字。',
      '局域网访问时把内网 IP 加进 JARVIS_ALLOWED_HOSTS。',
    ],
    cautions: [
      '需要 GPU 才有实用速度；CPU 上用 small 模型也能跑，但延迟高。',
      '不同版本的 FunASR 端点路径不一样，先用 curl 确认 /v1/audio/transcriptions。',
    ],
    chinaDirect: true,
    tags: ['自建', '内网', '中文', '免费'],
  },
  {
    id: 'selfhosted-whisper',
    name: '自建 Whisper（vLLM / 兼容服务）',
    nameEn: 'Self-hosted Whisper',
    kind: 'asr',
    region: 'local',
    adapter: 'openai',
    transport: 'http',
    baseUrl: 'http://127.0.0.1:8000/v1',
    model: 'whisper-large-v3-turbo',
    language: 'zh',
    keyUrl: '',
    docsUrl: 'https://docs.vllm.ai/en/latest/models/supported_models.html',
    freeTier: '自有算力，无调用费',
    summary: '有 GPU 又想留在内网时最合适；需要服务端实现 /audio/transcriptions。',
    setup: [
      '在服务器上启动支持音频的 OpenAI 兼容服务（如 vLLM 的 Whisper）。',
      '地址填 http://<内网IP>:8000/v1。',
      '把内网 IP 加进 JARVIS_ALLOWED_HOSTS，否则页面返回 421。',
    ],
    cautions: [
      '不是所有 vLLM 版本都支持 Whisper，先 curl 一下 /audio/transcriptions。',
      '内网 HTTP 没有 TLS，跨网段请套 VPN。',
    ],
    chinaDirect: true,
    tags: ['自建', '内网', '免费'],
  },

  // ------------------------------------------------------------------- TTS
  {
    id: 'local-piper',
    name: '本机 Piper',
    nameEn: 'Local Piper',
    kind: 'tts',
    region: 'local',
    adapter: 'auto',
    baseUrl: '',
    model: 'piper',
    voice: 'zh_CN-huayan-medium',
    keyUrl: '',
    docsUrl: 'https://github.com/rhasspy/piper',
    freeTier: '完全免费',
    summary: '默认方案：离线合成，音色自然度一般，但零延迟、零费用。',
    setup: [
      '运行 npm run setup 安装 Piper 与中文音色。',
      '设置 → 语音里保持“本地引擎”。',
      '想换音色就把 voice 换成 models/ 目录里的其他 .onnx 名字。',
    ],
    cautions: [
      '中文音色数量有限，情感表现弱。',
      '首次合成需要加载模型，第一句会慢。',
    ],
    chinaDirect: true,
    tags: ['离线', '免费', '隐私'],
  },
  {
    id: 'edge-tts',
    name: 'Edge TTS',
    nameEn: 'Edge TTS',
    kind: 'tts',
    region: 'global',
    adapter: 'edge',
    baseUrl: '',
    model: 'edge-tts',
    voice: 'zh-CN-XiaoxiaoNeural',
    keyUrl: '',
    docsUrl: 'https://github.com/rany2/edge-tts',
    freeTier: '免费，无需 Key',
    summary: '不花钱、音色多、中文自然；本质是调用微软的公开朗读服务。',
    setup: [
      '安装命令行：pip install edge-tts（或让 npm run setup 处理）。',
      '服务商选 Edge TTS，音色填 zh-CN-XiaoxiaoNeural（或其他中文音色）。',
      '不需要地址和 Key。',
    ],
    cautions: [
      '依赖第三方服务的可用性，可能随时限流或变更。',
      '不算隐私方案：文本会发到微软的朗读服务。',
    ],
    chinaDirect: true,
    tags: ['免费', '中文好', '无 Key'],
  },
  {
    id: 'openai-tts',
    name: 'OpenAI TTS',
    nameEn: 'OpenAI TTS',
    kind: 'tts',
    region: 'global',
    adapter: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini-tts',
    voice: 'alloy',
    keyUrl: 'https://platform.openai.com/api-keys',
    docsUrl: 'https://platform.openai.com/docs/guides/text-to-speech',
    freeTier: '无免费额度，按字符计费',
    summary: '音色自然、支持指令控制语气；需要能直连。',
    setup: [
      '创建 API Key。',
      '服务商选 OpenAI 兼容，地址 https://api.openai.com/v1。',
      '模型 gpt-4o-mini-tts（便宜）或 tts-1，音色 alloy / nova / shimmer。',
    ],
    cautions: [
      'gpt-4o-mini-tts 支持“用更快的语气说”这类指令，tts-1 不支持。',
      '中国大陆无法直连。',
    ],
    chinaDirect: false,
    tags: ['自然', '付费'],
  },
  {
    id: 'siliconflow-cosyvoice',
    name: '硅基流动 CosyVoice',
    nameEn: 'SiliconFlow CosyVoice',
    kind: 'tts',
    region: 'cn',
    adapter: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'FunAudioLLM/CosyVoice2-0.5B',
    voice: 'FunAudioLLM/CosyVoice2-0.5B:alex',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    docsUrl: 'https://docs.siliconflow.cn/cn/api-reference/audio/create-speech',
    freeTier: '有免费额度，之后很便宜',
    summary: '国内直连的中文 TTS，音色多，价格低。',
    setup: [
      '创建 API Key。',
      '服务商选 OpenAI 兼容，地址 https://api.siliconflow.cn/v1。',
      '模型填 FunAudioLLM/CosyVoice2-0.5B，音色按文档的“模型:音色”格式填。',
    ],
    cautions: [
      '音色名必须带模型前缀，例如 FunAudioLLM/CosyVoice2-0.5B:alex；只填 alex 会 400。',
      '可用音色以控制台/文档为准，写错会返回错误而不是静默换音色。',
    ],
    chinaDirect: true,
    tags: ['国内直连', '中文', '便宜'],
  },
  {
    id: 'gemini-tts',
    name: 'Google Gemini TTS',
    nameEn: 'Gemini TTS',
    kind: 'tts',
    region: 'global',
    adapter: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.5-flash-preview-tts',
    voice: 'Kore',
    keyUrl: 'https://aistudio.google.com/apikey',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/speech-generation',
    freeTier: '免费层可用，有速率限制',
    summary: '音色自然、支持多说话人；预览模型可能变动。',
    setup: [
      '创建 API Key。',
      '服务商选 Gemini，地址 https://generativelanguage.googleapis.com/v1beta。',
      '模型填 gemini-2.5-flash-preview-tts，音色 Kore / Puck / Charon。',
    ],
    cautions: [
      '这是 preview 模型，名字和配额可能变；失效时换成文档里的当前名称。',
      '免费层数据会用于改进产品。',
    ],
    chinaDirect: false,
    tags: ['自然', '多说话人', '预览'],
  },
  {
    id: 'cloudflare-tts',
    name: 'Cloudflare MeloTTS',
    nameEn: 'Cloudflare MeloTTS',
    kind: 'tts',
    region: 'global',
    adapter: 'cloudflare',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1',
    model: '@cf/myshell-ai/melotts',
    voice: 'zh',
    keyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    docsUrl: 'https://developers.cloudflare.com/workers-ai/models/melotts/',
    freeTier: '每天有免费 Neurons 配额',
    summary: '多语言、已经用 Cloudflare 的话可以顺手开。',
    setup: [
      '创建带 Workers AI 权限的 Token。',
      '地址里的 <ACCOUNT_ID> 换成账号 ID。',
      '模型 @cf/myshell-ai/melotts，音色填语言代码（zh / en）。',
    ],
    cautions: [
      '音色参数是语言而不是人名，填 Xiaoxiao 之类会失败。',
      '免费额度按 Neurons 计。',
    ],
    chinaDirect: false,
    tags: ['免费层', '多语言'],
  },
  {
    id: 'groq-tts',
    name: 'Groq PlayAI TTS',
    nameEn: 'Groq PlayAI TTS',
    kind: 'tts',
    region: 'global',
    adapter: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'playai-tts',
    voice: 'Fritz-PlayAI',
    keyUrl: 'https://console.groq.com/keys',
    docsUrl: 'https://console.groq.com/docs/text-to-speech',
    freeTier: '有免费层，按速率限制',
    summary: '速度极快；但只支持英文（少量阿拉伯语）音色。',
    setup: [
      '创建 API Key。',
      '服务商选 OpenAI 兼容，地址 https://api.groq.com/openai/v1。',
      '模型 playai-tts，音色如 Fritz-PlayAI。',
    ],
    cautions: [
      '中文文本会读成英文腔或直接失败——中文场景请用 CosyVoice / Edge / Piper。',
      '中国大陆无法直连。',
    ],
    chinaDirect: false,
    tags: ['快', '仅英文', '免费层'],
  },
  {
    id: 'selfhosted-openai-tts',
    name: '自建 OpenAI 兼容 TTS',
    nameEn: 'Self-hosted OpenAI-compatible TTS',
    kind: 'tts',
    region: 'local',
    adapter: 'openai',
    baseUrl: 'http://127.0.0.1:8001/v1',
    model: 'tts-1',
    voice: 'alloy',
    keyUrl: '',
    docsUrl: 'https://github.com/matatonic/openedai-speech',
    freeTier: '自有算力，无调用费',
    summary: 'openedai-speech / XTTS 这类服务都能接；模型与音色由你的服务决定。',
    setup: [
      '启动一个实现 /audio/speech 的 OpenAI 兼容 TTS 服务。',
      '地址填 http://<内网IP>:8001/v1，模型/音色按该服务文档填。',
      '内网地址加进 JARVIS_ALLOWED_HOSTS。',
    ],
    cautions: [
      '不同实现的音色名不通用，先看它自己的 /docs。',
      '内网 HTTP 无 TLS，跨网段请套 VPN。',
    ],
    chinaDirect: true,
    tags: ['自建', '内网', '免费'],
  },
]

export function voiceCatalog(): VoiceEntry[] {
  return CATALOG.map(entry => ({ ...entry, setup: [...entry.setup], cautions: [...entry.cautions], tags: [...entry.tags] }))
}

export function voiceGuide(id: string): VoiceEntry | undefined {
  return voiceCatalog().find(entry => entry.id === id)
}

export function validateVoiceCatalog(entries: VoiceEntry[] = CATALOG): string[] {
  const problems: string[] = []
  const ids = new Set<string>()
  for (const entry of entries) {
    if (!entry.id || !/^[a-z0-9-]+$/.test(entry.id)) problems.push(`${entry.id || '(空 id)'}: id 只能用小写字母、数字和连字符`)
    if (ids.has(entry.id)) problems.push(`${entry.id}: id 重复`)
    ids.add(entry.id)
    if (!entry.name.trim()) problems.push(`${entry.id}: 缺少名称`)
    if (!entry.summary.trim()) problems.push(`${entry.id}: 缺少一句话说明`)
    if (entry.setup.length < 2) problems.push(`${entry.id}: 至少需要两步接入说明`)
    if (entry.region === 'local') {
      if (entry.baseUrl && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(entry.baseUrl)) {
        problems.push(`${entry.id}: 本机条目只能指向 loopback`)
      }
    } else if (entry.adapter === 'edge') {
      // Edge TTS is a local command; it deliberately has no endpoint.
    } else if (!/^https?:\/\//.test(entry.baseUrl)) {
      problems.push(`${entry.id}: 远端条目必须有 http(s) 地址`)
    }
    if (entry.region === 'global' && entry.baseUrl && !entry.baseUrl.startsWith('https://')) {
      problems.push(`${entry.id}: 国际条目应使用 https`)
    }
    if (entry.kind === 'asr' && !entry.model.trim()) problems.push(`${entry.id}: ASR 需要默认模型`)
    if (entry.kind === 'tts' && !entry.model.trim()) problems.push(`${entry.id}: TTS 需要默认模型`)
    if (entry.adapter === 'edge' && entry.kind !== 'tts') problems.push(`${entry.id}: Edge 只用于 TTS`)
    if (entry.kind === 'asr' && entry.adapter === 'edge') problems.push(`${entry.id}: ASR 不支持 Edge 适配器`)
    if (entry.region !== 'local' && !entry.keyUrl.trim() && entry.adapter !== 'edge') problems.push(`${entry.id}: 缺少 Key 申请地址`)
    if (!entry.docsUrl.startsWith('https://')) problems.push(`${entry.id}: 文档地址需要 https`)
    if (entry.kind === 'asr' && !['zh', 'en', 'auto'].includes(entry.language ?? 'zh')) problems.push(`${entry.id}: 语言默认值不常见（${entry.language}）`)
    if (!entry.setup.every(step => step.trim().length > 0)) problems.push(`${entry.id}: 存在空的接入步骤`)
  }
  return problems
}

export function voiceByKind(kind: VoiceKind, entries: VoiceEntry[] = CATALOG): VoiceEntry[] {
  return entries.filter(entry => entry.kind === kind)
}
