/**
 * Provider catalogue: the single source of truth behind the in-app
 * "模型服务" page, `/api/providers/catalog` and docs/providers-guide.md.
 *
 * Everything here is public: no keys, no account ids, no per-user data. The
 * entries are deliberately conservative about model names — every provider
 * that supports `GET /models` should be configured through "获取模型列表"
 * rather than by copying a name that may be retired next month.
 */
import type { LlmProtocol } from './types.ts'
import type { ProviderKind } from './settings.ts'

export type ProviderRegion = 'cn' | 'global' | 'local'

export interface ProviderEntry {
  /** Stable id; the settings page uses it to prefill a profile. */
  id: string
  name: string
  nameEn: string
  region: ProviderRegion
  kind: ProviderKind
  protocol: LlmProtocol
  /** Leave `${...}` placeholders when the provider needs an account id. */
  baseUrl: string
  /** Suggested first model. Empty means "use 获取模型列表". */
  model: string
  keyUrl: string
  docsUrl: string
  /** Console where billing/quota lives. */
  consoleUrl: string
  freeTier: string
  summary: string
  setup: string[]
  cautions: string[]
  /** Reachable from mainland China without a proxy. */
  chinaDirect: boolean
  supportsModelList: boolean
  tags: string[]
}

function entry(value: ProviderEntry): ProviderEntry {
  return value
}

const CATALOG: ProviderEntry[] = [
  // ---------------------------------------------------------------- 国内
  entry({
    id: 'deepseek',
    name: 'DeepSeek',
    nameEn: 'DeepSeek',
    region: 'cn',
    kind: 'openai',
    protocol: 'chat-completions',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    docsUrl: 'https://api-docs.deepseek.com/',
    consoleUrl: 'https://platform.deepseek.com/usage',
    freeTier: '新账号通常有试用额度，之后按量计费',
    summary: '中文能力好、价格低，OpenAI 兼容，适合作为日常默认供应商。',
    setup: [
      '注册并完成实名认证，在「API keys」创建密钥（只显示一次）。',
      '把密钥填进 Jarvis 的「API Key」，地址保持默认。',
      '点「获取模型列表」选择 deepseek-chat 或 deepseek-reasoner，保存。',
    ],
    cautions: ['充值余额为 0 时所有请求都会返回 402，界面会提示额度不足并可自动切换到下一个供应商。'],
    chinaDirect: true,
    supportsModelList: true,
    tags: ['便宜', '中文好', '推理'],
  }),
  entry({
    id: 'siliconflow',
    name: '硅基流动',
    nameEn: 'SiliconFlow',
    region: 'cn',
    kind: 'openai',
    protocol: 'chat-completions',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: '',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    docsUrl: 'https://docs.siliconflow.cn/',
    consoleUrl: 'https://cloud.siliconflow.cn/account/ak',
    freeTier: '部分开源模型有免费额度',
    summary: '一个 Key 用上 DeepSeek、Qwen、GLM 等大量开源模型，也能做语音合成。',
    setup: [
      '在「API 密钥」新建密钥。',
      '地址保持默认，点「获取模型列表」挑一个模型（例如 DeepSeek 或 Qwen 系列）。',
      '想用语音合成时，在「语音」标签把 TTS 选成 OpenAI 兼容 + 同一个地址。',
    ],
    cautions: ['模型名带厂商前缀（如 deepseek-ai/…、Qwen/…），手填容易错，优先用列表。'],
    chinaDirect: true,
    supportsModelList: true,
    tags: ['模型多', '可语音', '开源模型'],
  }),
  entry({
    id: 'dashscope',
    name: '通义千问（阿里云百炼）',
    nameEn: 'Alibaba DashScope',
    region: 'cn',
    kind: 'openai',
    protocol: 'chat-completions',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope',
    consoleUrl: 'https://bailian.console.aliyun.com/',
    freeTier: '新用户有免费额度（按模型和地区不同）',
    summary: '阿里云的大模型平台，Qwen 系列 + 视觉模型齐全，走 OpenAI 兼容模式最省事。',
    setup: [
      '在百炼控制台创建 API-KEY（注意选择与模型一致的地域）。',
      '地址填 compatible-mode 这条（不要用旧的 dashscope 原生地址）。',
      '点「获取模型列表」选 qwen-plus / qwen-max，需要看图就再选视觉模型。',
    ],
    cautions: ['百炼是“模型订阅 + 按量”混合计费，欠费会直接 403。'],
    chinaDirect: true,
    supportsModelList: true,
    tags: ['视觉', '中文', '阿里云'],
  }),
  entry({
    id: 'zhipu',
    name: '智谱 GLM',
    nameEn: 'Zhipu AI',
    region: 'cn',
    kind: 'openai',
    protocol: 'chat-completions',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-plus',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    docsUrl: 'https://open.bigmodel.cn/dev/api',
    consoleUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    freeTier: '部分轻量模型免费',
    summary: 'GLM 系列，中文写作和工具调用稳定，有免费模型可以先用起来。',
    setup: [
      '在「个人中心 → API Keys」新建密钥。',
      '地址保持默认（注意结尾是 /v4，不是 /v1）。',
      '点「获取模型列表」选 glm-4-plus 或轻量免费模型。',
    ],
    cautions: ['免费模型有并发限制，长时间对话可能排队。'],
    chinaDirect: true,
    supportsModelList: true,
    tags: ['中文', '免费额度', '工具调用'],
  }),
  entry({
    id: 'moonshot',
    name: 'Kimi（月之暗面）',
    nameEn: 'Moonshot AI',
    region: 'cn',
    kind: 'openai',
    protocol: 'chat-completions',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    docsUrl: 'https://platform.moonshot.cn/docs',
    consoleUrl: 'https://platform.moonshot.cn/console',
    freeTier: '新用户赠送额度，之后按量计费',
    summary: '长文本理解强，适合把长文档、会议记录丢给它总结。',
    setup: [
      '在控制台「API Key 管理」新建密钥。',
      '地址与模型保持默认（长上下文选 32k / 128k 版本）。',
      '保存后建议把「场景 → 长文档」的供应商指向它。',
    ],
    cautions: ['不同上下文长度的模型价格差别很大，长文档场景注意额度消耗。'],
    chinaDirect: true,
    supportsModelList: true,
    tags: ['长文本', '中文'],
  }),
  entry({
    id: 'volcengine',
    name: '火山方舟（豆包）',
    nameEn: 'Volcengine Ark',
    region: 'cn',
    kind: 'openai',
    protocol: 'chat-completions',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: '',
    keyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    docsUrl: 'https://www.volcengine.com/docs/82379/1330626',
    consoleUrl: 'https://console.volcengine.com/ark',
    freeTier: '每个模型有赠送额度（以控制台为准）',
    summary: '字节跳动的大模型平台，豆包系列延迟低，适合语音对话和日常问答。',
    setup: [
      '开通「火山方舟」，在 API Key 页面创建密钥。',
      '先在控制台创建“推理接入点”，把接入点 ID 当作模型名。',
      '地址填北京的 OpenAI 兼容地址；在别的地域要换域名。',
    ],
    cautions: ['模型名不是 doubao-xxx，而是你在控制台创建的接入点 ID（ep-…），填错会 404。'],
    chinaDirect: true,
    supportsModelList: false,
    tags: ['低延迟', '豆包', '语音'],
  }),
  entry({
    id: 'hunyuan',
    name: '腾讯混元',
    nameEn: 'Tencent Hunyuan',
    region: 'cn',
    kind: 'openai',
    protocol: 'chat-completions',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    model: 'hunyuan-turbos-latest',
    keyUrl: 'https://console.cloud.tencent.com/hunyuan/api-key',
    docsUrl: 'https://cloud.tencent.com/document/product/1729/111007',
    consoleUrl: 'https://console.cloud.tencent.com/hunyuan',
    freeTier: '新用户有免费额度',
    summary: '腾讯云混元，OpenAI 兼容入口，已经用腾讯云的用户开箱即用。',
    setup: [
      '在混元控制台开通服务并创建 API Key。',
      '地址保持默认，模型选 hunyuan-turbos-latest 或其它版本。',
      '保存后可在「场景」里单独指定。',
    ],
    cautions: ['需要先在控制台开通服务，否则即使有 Key 也会返回未开通错误。'],
    chinaDirect: true,
    supportsModelList: true,
    tags: ['腾讯云', '中文'],
  }),
  entry({
    id: 'qianfan',
    name: '百度千帆（文心）',
    nameEn: 'Baidu Qianfan',
    region: 'cn',
    kind: 'openai',
    protocol: 'chat-completions',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    model: 'ernie-4.5-turbo-128k',
    keyUrl: 'https://console.bce.baidu.com/iam/#/iam/apikey/list',
    docsUrl: 'https://cloud.baidu.com/doc/WENXINWORKSHOP/s/Fm2vrveyu',
    consoleUrl: 'https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application',
    freeTier: '部分模型有免费额度',
    summary: '文心一言系列，v2 接口是 OpenAI 兼容的，比旧版千帆 SDK 简单得多。',
    setup: [
      '在百度智能云创建 API Key（IAM 里），并开通千帆服务。',
      '地址必须用 v2 这条，旧版地址不走 OpenAI 协议。',
      '模型名从「获取模型列表」里选，手填容易遇到版本后缀问题。',
    ],
    cautions: ['百度云有两个 AppID/Key 体系，认准 IAM API Key，不要用应用的 AK/SK。'],
    chinaDirect: true,
    supportsModelList: true,
    tags: ['文心', '百度云'],
  }),
  entry({
    id: 'minimax',
    name: 'MiniMax',
    nameEn: 'MiniMax',
    region: 'cn',
    kind: 'openai',
    protocol: 'chat-completions',
    baseUrl: 'https://api.minimaxi.com/v1',
    model: 'MiniMax-Text-01',
    keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    docsUrl: 'https://platform.minimaxi.com/document/guides/chat-model/prologue',
    consoleUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    freeTier: '新用户有试用额度',
    summary: '长上下文 + 语音能力，适合需要超长输入或语音合成的场景。',
    setup: [
      '在「接口密钥」页面创建 Key。',
      '地址用 api.minimaxi.com；老账号如果是 api.minimax.chat 再改。',
      '模型名从列表选，语音合成在「语音」标签单独配置。',
    ],
    cautions: ['新版域名是 minimaxi.com，老文档里的 minimax.chat 仍可用但可能逐步迁移。'],
    chinaDirect: true,
    supportsModelList: true,
    tags: ['长上下文', '语音'],
  }),
  entry({
    id: 'stepfun',
    name: '阶跃星辰',
    nameEn: 'StepFun',
    region: 'cn',
    kind: 'openai',
    protocol: 'chat-completions',
    baseUrl: 'https://api.stepfun.com/v1',
    model: 'step-2-16k',
    keyUrl: 'https://platform.stepfun.com/interface-key',
    docsUrl: 'https://platform.stepfun.com/docs/overview/concept',
    consoleUrl: 'https://platform.stepfun.com/',
    freeTier: '新用户赠送额度',
    summary: 'Step 系列多模态模型，OpenAI 兼容，图片理解可用。',
    setup: [
      '在「接口密钥」创建 Key。',
      '地址与模型保持默认，需要看图就在视觉模型里填 step-1v 系列。',
      '保存后试一句带图的问题验证。',
    ],
    cautions: ['多模态模型要单独填「视觉模型」，否则图片会走文字模型报错。'],
    chinaDirect: true,
    supportsModelList: true,
    tags: ['多模态', '视觉'],
  }),
  entry({
    id: 'baichuan',
    name: '百川智能',
    nameEn: 'Baichuan',
    region: 'cn',
    kind: 'openai',
    protocol: 'chat-completions',
    baseUrl: 'https://api.baichuan-ai.com/v1',
    model: 'Baichuan4',
    keyUrl: 'https://platform.baichuan-ai.com/console/apikey',
    docsUrl: 'https://platform.baichuan-ai.com/docs/api',
    consoleUrl: 'https://platform.baichuan-ai.com/console/apikey',
    freeTier: '新用户有免费额度',
    summary: 'Baichuan 系列，中文医疗、法律语料表现不错。',
    setup: [
      '在控制台创建 API Key。',
      '地址与模型保持默认。',
      '点「获取模型列表」确认可用版本。',
    ],
    cautions: ['部分模型需要企业认证后才能调用。'],
    chinaDirect: true,
    supportsModelList: true,
    tags: ['中文', '垂直领域'],
  }),

  // ---------------------------------------------------------------- 国际
  entry({
    id: 'openai',
    name: 'OpenAI',
    nameEn: 'OpenAI',
    region: 'global',
    kind: 'openai',
    protocol: 'chat-completions',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
    docsUrl: 'https://platform.openai.com/docs/api-reference',
    consoleUrl: 'https://platform.openai.com/usage',
    freeTier: '无免费额度，需绑定支付方式',
    summary: '生态最完整，工具调用与结构化输出最稳；需要能访问 openai.com。',
    setup: [
      '在「API keys」创建项目密钥（sk-…）。',
      '地址保持默认，点「获取模型列表」选模型。',
      '如果所在网络需要代理，请在本机设置 HTTP(S)_PROXY，不要在地址里写代理。',
    ],
    cautions: ['中国大陆无法直连，需要自备合规网络；也不要把它设成唯一供应商。'],
    chinaDirect: false,
    supportsModelList: true,
    tags: ['工具调用', '生态'],
  }),
  entry({
    id: 'anthropic',
    name: 'Anthropic Claude',
    nameEn: 'Anthropic',
    region: 'global',
    kind: 'openai',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-5',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    docsUrl: 'https://docs.anthropic.com/en/api/messages',
    consoleUrl: 'https://console.anthropic.com/settings/usage',
    freeTier: '无免费额度',
    summary: '长文写作与代码审阅质量高，Jarvis 走原生 Messages 协议（不是 OpenAI 兼容层）。',
    setup: [
      '在 Settings → API Keys 创建密钥（sk-ant-…）。',
      '协议选「Anthropic Messages」，地址不要带 /v1。',
      '模型名手填（该厂商不提供 OpenAI 风格的模型列表）。',
    ],
    cautions: ['协议选错会 404；Anthropic 不支持 OpenAI 的 /chat/completions。'],
    chinaDirect: false,
    supportsModelList: false,
    tags: ['长文', '代码'],
  }),
  entry({
    id: 'gemini',
    name: 'Google Gemini',
    nameEn: 'Google',
    region: 'global',
    kind: 'openai',
    protocol: 'chat-completions',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    model: '',
    keyUrl: 'https://aistudio.google.com/apikey',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/openai',
    consoleUrl: 'https://aistudio.google.com/',
    freeTier: '有免费层（会使用数据改进产品）',
    summary: '免费层慷慨，多模态能力强；用 OpenAI 兼容入口即可接入。',
    setup: [
      '在 Google AI Studio 创建 API Key。',
      '地址用 /v1beta/openai/（注意结尾斜杠），协议选 Chat Completions。',
      '点「获取模型列表」选 gemini-…-flash 之类的模型。',
    ],
    cautions: ['免费层的数据会被用于改进产品，隐私内容请换付费层或本地模型。'],
    chinaDirect: false,
    supportsModelList: true,
    tags: ['免费层', '多模态'],
  }),
  entry({
    id: 'openrouter',
    name: 'OpenRouter',
    nameEn: 'OpenRouter',
    region: 'global',
    kind: 'openai',
    protocol: 'chat-completions',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
    keyUrl: 'https://openrouter.ai/keys',
    docsUrl: 'https://openrouter.ai/docs',
    consoleUrl: 'https://openrouter.ai/activity',
    freeTier: '带 :free 的模型有每日额度',
    summary: '一个 Key 调几十家模型，适合先比较再决定长期用谁。',
    setup: [
      '注册后在 Keys 页面创建 Key。',
      '地址保持默认，模型名形如 厂商/模型（如 openai/gpt-4o-mini）。',
      '想用免费模型就在名字后加 :free，注意每天请求上限。',
    ],
    cautions: ['免费模型有每日上限；部分模型会因上游限流而偶发 503。'],
    chinaDirect: false,
    supportsModelList: true,
    tags: ['聚合', '比价', '免费模型'],
  }),
  entry({
    id: 'groq',
    name: 'Groq',
    nameEn: 'Groq',
    region: 'global',
    kind: 'openai',
    protocol: 'chat-completions',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    keyUrl: 'https://console.groq.com/keys',
    docsUrl: 'https://console.groq.com/docs',
    consoleUrl: 'https://console.groq.com/usage',
    freeTier: '有免费层，速率受限',
    summary: '推理速度极快，适合“边说话边出字”的语音对话。',
    setup: [
      '在 Groq Console 创建 API Key。',
      '地址必须带 /openai/v1。',
      '点「获取模型列表」选模型；语音识别也可以用它（whisper-large-v3）。',
    ],
    cautions: ['中文语音合成不支持，TTS 请换 SilicFlow / Gemini / Edge。'],
    chinaDirect: false,
    supportsModelList: true,
    tags: ['快', '免费层', '语音识别'],
  }),
  entry({
    id: 'mistral',
    name: 'Mistral',
    nameEn: 'Mistral AI',
    region: 'global',
    kind: 'openai',
    protocol: 'chat-completions',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-large-latest',
    keyUrl: 'https://console.mistral.ai/api-keys',
    docsUrl: 'https://docs.mistral.ai/',
    consoleUrl: 'https://console.mistral.ai/',
    freeTier: '有免费实验层',
    summary: '欧洲供应商，多语言与代码能力均衡。',
    setup: [
      '在 Console 创建 API Key。',
      '地址保持默认，模型选 mistral-large-latest 或 -small-latest。',
      '保存后可用「测试连接」验证。',
    ],
    cautions: ['免费层有速率限制，生产使用请升级套餐。'],
    chinaDirect: false,
    supportsModelList: true,
    tags: ['欧洲', '多语言'],
  }),
  entry({
    id: 'xai',
    name: 'xAI Grok',
    nameEn: 'xAI',
    region: 'global',
    kind: 'openai',
    protocol: 'chat-completions',
    baseUrl: 'https://api.x.ai/v1',
    model: 'grok-4',
    keyUrl: 'https://console.x.ai/team/default/api-keys',
    docsUrl: 'https://docs.x.ai/docs',
    consoleUrl: 'https://console.x.ai/',
    freeTier: '无免费额度',
    summary: 'Grok 系列，OpenAI 兼容，适合新闻/实时话题类问答。',
    setup: [
      '在 xAI Console 创建 API Key。',
      '地址保持默认，模型选 grok-4 或更轻的型号。',
      '保存后用一句话验证。',
    ],
    cautions: ['账号需要所在地区可用；部分模型有内容策略限制。'],
    chinaDirect: false,
    supportsModelList: true,
    tags: ['实时', '英文'],
  }),
  entry({
    id: 'together',
    name: 'Together AI',
    nameEn: 'Together',
    region: 'global',
    kind: 'openai',
    protocol: 'chat-completions',
    baseUrl: 'https://api.together.xyz/v1',
    model: '',
    keyUrl: 'https://api.together.xyz/settings/api-keys',
    docsUrl: 'https://docs.together.ai/',
    consoleUrl: 'https://api.together.xyz/settings/billing',
    freeTier: '注册赠送少量额度',
    summary: '开源模型托管平台，模型多、价格透明，适合跑 Llama / Qwen / DeepSeek。',
    setup: [
      '在 Settings → API Keys 创建密钥。',
      '地址保持默认，点「获取模型列表」选模型（名字形如 meta-llama/…）。',
      '保存后可把它作为故障转移的第二顺位。',
    ],
    cautions: ['模型列表很长，界面里用搜索框过滤。'],
    chinaDirect: false,
    supportsModelList: true,
    tags: ['开源模型', '托管'],
  }),
  entry({
    id: 'fireworks',
    name: 'Fireworks AI',
    nameEn: 'Fireworks',
    region: 'global',
    kind: 'openai',
    protocol: 'chat-completions',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    model: '',
    keyUrl: 'https://fireworks.ai/account/api-keys',
    docsUrl: 'https://docs.fireworks.ai/',
    consoleUrl: 'https://fireworks.ai/account/billing',
    freeTier: '赠送少量试用额度',
    summary: '低延迟托管推理，支持自定义部署；适合需要吞吐的场景。',
    setup: [
      '在 Account → API Keys 创建密钥。',
      '地址保持默认（注意是 /inference/v1）。',
      '点「获取模型列表」选模型，名字形如 accounts/fireworks/models/…。',
    ],
    cautions: ['路径与 OpenAI 不同，少写 /inference 会 404。'],
    chinaDirect: false,
    supportsModelList: true,
    tags: ['低延迟', '吞吐'],
  }),
  entry({
    id: 'cloudflare',
    name: 'Cloudflare Workers AI',
    nameEn: 'Cloudflare',
    region: 'global',
    kind: 'openai',
    protocol: 'chat-completions',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1',
    model: '@cf/openai/gpt-oss-120b',
    keyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    docsUrl: 'https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/',
    consoleUrl: 'https://dash.cloudflare.com/',
    freeTier: '每天有免费配额（Neurons）',
    summary: '用 Cloudflare 账号额度跑开源模型，还能做语音识别与合成。',
    setup: [
      '创建 API Token（权限至少 Workers AI: Read）。',
      '把地址里的 <ACCOUNT_ID> 换成你的账号 ID（控制台右侧可复制）。',
      '点「获取模型列表」时 Jarvis 会用账号级搜索接口列出可用模型。',
    ],
    cautions: ['地址里必须有账号 ID；Token 权限不足时列表会是空的。'],
    chinaDirect: false,
    supportsModelList: true,
    tags: ['免费配额', '语音', '边缘'],
  }),

  // ---------------------------------------------------------------- 本地
  entry({
    id: 'ollama',
    name: 'Ollama（本机）',
    nameEn: 'Ollama',
    region: 'local',
    kind: 'ollama',
    protocol: 'chat-completions',
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:3b',
    keyUrl: 'https://ollama.com/download',
    docsUrl: 'https://ollama.com/library',
    consoleUrl: 'https://ollama.com/library',
    freeTier: '完全免费，只用电和硬盘',
    summary: '默认选项：不联网、不上传，3B 模型在普通笔记本上就能跑。',
    setup: [
      '安装 Ollama，然后执行 ollama pull qwen2.5:3b。',
      '地址保持 127.0.0.1:11434，点「获取模型列表」。',
      '显存 8GB 以上可以换 7B/14B，速度会慢一些但更聪明。',
    ],
    cautions: ['首次拉模型需要下载几个 GB；磁盘不足会失败。'],
    chinaDirect: true,
    supportsModelList: true,
    tags: ['本地', '隐私', '免费'],
  }),
  entry({
    id: 'lmstudio',
    name: 'LM Studio（本机）',
    nameEn: 'LM Studio',
    region: 'local',
    kind: 'openai',
    protocol: 'chat-completions',
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: '',
    keyUrl: 'https://lmstudio.ai/download',
    docsUrl: 'https://lmstudio.ai/docs/app/api',
    consoleUrl: 'https://lmstudio.ai/',
    freeTier: '免费（图形界面 + 本地模型）',
    summary: '图形化本地模型管理器，Windows/macOS 上比 Ollama 更好上手。',
    setup: [
      '安装 LM Studio，下载一个模型并启动本地服务器。',
      '地址填 http://127.0.0.1:1234/v1，Key 可以留空。',
      '点「获取模型列表」选当前已加载的模型。',
    ],
    cautions: ['必须先点“Start Server”，否则连接会被拒绝。'],
    chinaDirect: true,
    supportsModelList: true,
    tags: ['本地', '图形界面', 'Windows'],
  }),
  entry({
    id: 'vllm',
    name: 'vLLM / 自建推理',
    nameEn: 'vLLM',
    region: 'local',
    kind: 'openai',
    protocol: 'chat-completions',
    baseUrl: 'http://127.0.0.1:8000/v1',
    model: '',
    keyUrl: 'https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html',
    docsUrl: 'https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html',
    consoleUrl: 'https://docs.vllm.ai/',
    freeTier: '自建，无调用费',
    summary: '自己部署在服务器/工作站上的 OpenAI 兼容服务，适合有 GPU 的用户。',
    setup: [
      '在目标机器上启动 vLLM 的 OpenAI 兼容服务。',
      '地址填服务地址（局域网请用 IP，不要写 localhost）。',
      '把「允许远端视觉」按需打开，否则图片不会发出去。',
    ],
    cautions: ['局域网地址需要加进 JARVIS_ALLOWED_HOSTS，否则页面会被 421 拒绝。'],
    chinaDirect: true,
    supportsModelList: true,
    tags: ['自建', 'GPU', '内网'],
  }),
]

export function providerCatalog(): ProviderEntry[] {
  return CATALOG.map(item => ({ ...item, setup: [...item.setup], cautions: [...item.cautions], tags: [...item.tags] }))
}

export function providerGuide(id: string): ProviderEntry | undefined {
  return CATALOG.find(item => item.id === id)
}

const ID_PATTERN = /^[a-z0-9-]{1,32}$/

/** Used by tests and by the server at boot; throws on a broken entry. */
export function validateCatalog(entries: ProviderEntry[] = CATALOG): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const item of entries) {
    if (!ID_PATTERN.test(item.id)) problems.push(`${item.id}: id 不合法`)
    if (seen.has(item.id)) problems.push(`${item.id}: id 重复`)
    seen.add(item.id)
    if (!item.name.trim()) problems.push(`${item.id}: 缺少名称`)
    if (!['cn', 'global', 'local'].includes(item.region)) problems.push(`${item.id}: region 不合法`)
    if (!['ollama', 'openai'].includes(item.kind)) problems.push(`${item.id}: kind 不合法`)
    if (!['chat-completions', 'responses', 'anthropic'].includes(item.protocol)) problems.push(`${item.id}: protocol 不合法`)
    for (const key of ['baseUrl', 'keyUrl', 'docsUrl', 'consoleUrl'] as const) {
      const value = item[key]
      if (!/^https?:\/\//.test(value)) problems.push(`${item.id}: ${key} 不是 http(s) 地址`)
    }
    if (item.setup.length < 2) problems.push(`${item.id}: 至少要有两步引导`)
    if (!item.summary.trim()) problems.push(`${item.id}: 缺少一句话说明`)
    if (!item.freeTier.trim()) problems.push(`${item.id}: 缺少费用说明`)
    if (item.region === 'local' && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(item.baseUrl)) {
      problems.push(`${item.id}: 本地供应商应指向 127.0.0.1`)
    }
    if (item.region !== 'local' && /127\.0\.0\.1|localhost/.test(item.baseUrl)) {
      problems.push(`${item.id}: 远端供应商不应指向本机`)
    }
  }
  return problems
}
