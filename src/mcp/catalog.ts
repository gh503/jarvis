import { fileURLToPath } from 'node:url'
import type { PresetDefinition } from './presets.ts'
import type { ServerInput } from './settings.ts'

const key=(key:string,label='API Key',help='凭据只保存在本机，不会返回到浏览器或模型。')=>({key,label,secret:true,required:true,help})
const connectionNote='验证连接仅检查 MCP 握手和工具发现，不保证账号余额或每项资源权限；实际查询可能消耗服务商配额。'
const readonlyNote='此预置仅开放已核验的查询工具；新增或写入工具默认禁止。返回内容默认仅供本地模型使用。'
export const mcpCatalog:PresetDefinition[]=[
  {id:'amap',name:'高德地图',category:'life',description:'查询地点、公交与驾车路线、距离及天气；支持酒店和景点位置搜索。',available:true,readOnly:true,version:1,
    fields:[key('apiKey','Web 服务 Key','请选择“Web服务”类型，不是 JavaScript API 安全密钥。')],
    toolPolicy:{permittedReadTools:['maps_regeocode','maps_geo','maps_ip_location','maps_weather','maps_bicycling','maps_direction_walking','maps_direction_driving','maps_direction_transit_integrated','maps_distance','maps_text_search','maps_around_search','maps_search_detail']},
    help:{credentialsUrl:'https://console.amap.com/dev/key',docsUrl:'https://lbs.amap.com/api/mcp-server/gettingstarted',revokeUrl:'https://console.amap.com/dev/key',setup:['登录高德开放平台，进入应用管理。','创建应用并添加 Key，服务平台选择“Web服务”。','将 Key 粘贴到这里，保存并验证连接，然后启用。'],usage:['查询杭州西湖附近的景点。','比较明早从指定地址到杭州东站的公交和驾车路线。','查苏州工业园区附近的酒店位置。'],limitations:[connectionNote,readonlyNote,'酒店 POI 不包含实时房价、房态或订单；导航链接不代表已打车或购票。','受账号认证、配额及商业许可限制，以高德控制台为准。','不自动获取设备定位；请在问题中提供出发地、目的地或城市。']}},
  {id:'qweather',name:'和风天气',category:'life',description:'按城市查询实况和未来天气；由 Jarvis 适配官方天气 API。',available:true,readOnly:true,version:1,
    fields:[key('apiKey'),{key:'apiHost',label:'账号 API Host',secret:false,required:true,placeholder:'例如 abc.xy.qweatherapi.com',help:'从和风控制台设置中复制主机名，不填 https:// 或路径。'}],
    toolPolicy:{permittedReadTools:['weather_city_lookup','weather_current','weather_daily']},
    help:{credentialsUrl:'https://console.qweather.com/project',docsUrl:'https://dev.qweather.com/docs/configuration/api-host/',revokeUrl:'https://console.qweather.com/project',setup:['在和风控制台创建项目，添加 API KEY 凭据并复制。','在控制台设置中复制账号专属 API Host，填写第二个字段。','保存、验证连接后启用。密钥和额度在首次真实查询时由服务商校验。'],usage:['查南京今天的天气。','杭州未来三天是否下雨？','查询指定经纬度的天气预报。'],limitations:[connectionNote,readonlyNote,'这是 Jarvis 自有 MCP 适配器，不是和风发布的官方 MCP。使用官方 REST 接口，保留来源标注。','城市查询、实况和预报分别计费，以账号套餐与官方配额为准。','官方已公告后续 API Key 调用限制；需要长期高额度时应按官方要求迁移认证方案。','不批量下载或建立地理位置数据库。']}},
  {id:'tavily',name:'Tavily 搜索',category:'general',description:'搜索公开资料并提取网页内容，提供来源链接。',available:true,readOnly:true,version:1,fields:[key('apiKey')],
    toolPolicy:{permittedReadTools:['tavily_search','tavily_extract']},
    help:{credentialsUrl:'https://app.tavily.com/home',docsUrl:'https://docs.tavily.com/documentation/mcp',revokeUrl:'https://app.tavily.com/home',setup:['登录 Tavily 控制台，在 API Keys 中创建并复制密钥。','填写密钥后保存、验证并启用。','需要撤销时在 Tavily 控制台删除对应密钥。'],usage:['查本周某行业的最新消息，并附来源。','读取指定公开网页并总结重点。'],limitations:[connectionNote,readonlyNote,'搜索词和目标 URL 会发送给 Tavily；不要在查询中放入未授权的个人或公司资料。','查询和提取消耗服务商配额；本预置不开放批量爬取或自动研究任务。']}},
  {id:'context7',name:'Context7 技术文档',category:'developer',description:'查询软件库与框架的文档和版本相关用法。',available:true,readOnly:true,version:1,fields:[key('apiKey')],
    toolPolicy:{permittedReadTools:['resolve-library-id','query-docs']},
    help:{credentialsUrl:'https://context7.com/dashboard',docsUrl:'https://context7.com/docs/resources/all-clients',revokeUrl:'https://context7.com/dashboard',setup:['打开 Context7 Dashboard，在 API Keys 中创建密钥。','不要为普通文档查询启用 Management access。','复制密钥到这里，保存、验证并启用。'],usage:['查当前 React 文档中的 useEffect 用法。','查询指定版本数据库客户端的事务示例。'],limitations:[connectionNote,readonlyNote,'库名和查询文字发送到 Context7；不要附带私有源代码或凭据。','可查询版本和调用限额取决于服务商数据及套餐。']}},
  {id:'github',name:'GitHub',category:'developer',description:'查询指定仓库的文件、Issue、Pull Request 和研发进度。',available:true,readOnly:true,version:1,fields:[key('pat','Fine-grained PAT')],
    toolPolicy:{permittedReadTools:['get_me','get_file_contents','search_code','search_repositories','list_branches','list_commits','get_commit','list_tags','get_tag','get_latest_release','list_releases','get_release_by_tag','list_issues','issue_read','search_issues','list_pull_requests','pull_request_read','search_pull_requests']},
    help:{credentialsUrl:'https://github.com/settings/personal-access-tokens/new',docsUrl:'https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md',revokeUrl:'https://github.com/settings/personal-access-tokens',setup:['创建 Fine-grained personal access token，设置明确的到期时间。','选择资源所有者和需要使用的仓库，不选全部仓库。','按需授予 Contents、Issues、Pull requests 的只读权限；组织可能需要管理员批准。','复制 Token，保存、验证并启用。'],usage:['列出指定仓库尚未处理的 Issue。','总结某个 Pull Request 的变更与讨论。','查指定仓库文件中的配置说明。'],limitations:[connectionNote,readonlyNote,'同时向官方 MCP 请求只读工具集，并在 Jarvis 再次限制工具名。','Token 有效不等于对所有仓库有权限；不能访问未授权的仓库。','当前预置不开放提交代码、合并 PR 或删除内容。']}},
  {id:'notion',name:'Notion',category:'office',description:'查询已授权的页面和知识库；当前支持特定套餐的 MCP Token。',available:true,readOnly:true,version:1,fields:[key('mcpToken','Notion MCP Token','仅适用官方提供 MCP Token 的工作区。普通 REST Integration Token 不可替代。')],
    toolPolicy:{permittedReadTools:['notion-search','notion-fetch','notion-get-self','notion-get-tool-access']},
    help:{credentialsUrl:'https://www.notion.so/developers',docsUrl:'https://developers.notion.com/guides/mcp/get-started-with-mcp',revokeUrl:'https://www.notion.so/developers',setup:['确认你是支持 MCP Token 的 Business / Enterprise 工作区所有者。','在 Notion Developer portal 选择 New MCP token，按官方提示创建。','将 MCP Token 填入这里；若账号没有此入口，请勿填写普通 Integration Token。','普通用户的 OAuth 授权流程暂未接入 Jarvis。'],usage:['搜索工作区中关于某项目的页面。','读取指定 Notion 页面并总结待办。'],limitations:[connectionNote,readonlyNote,'仅对符合 Notion 套餐及管理员条件的账号开放 Token 接入；不承诺所有账号可用。','撤销请在 Notion 的 Token/工作区客户端管理处操作；删除本机凭据不会自动撤销服务商授权。','当前预置不修改页面或数据库。']}},
  {id:'feishu',name:'飞书文档',category:'office',description:'通过企业自建应用读取已授权的新版云文档与知识库节点。',available:true,readOnly:true,version:1,
    fields:[{key:'appId',label:'App ID',secret:false,required:true,placeholder:'cli_…',help:'在飞书开放平台自建应用的凭证页面获取。'},key('appSecret','App Secret')],
    toolPolicy:{permittedReadTools:['feishu_document_read','feishu_wiki_node']},
    help:{credentialsUrl:'https://open.feishu.cn/app',docsUrl:'https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document/raw_content',revokeUrl:'https://open.feishu.cn/app',setup:['在飞书开放平台创建企业自建应用，复制 App ID 和 App Secret。','按官方 API 页面申请文档内容读取和知识库节点读取所需权限，发布并完成企业审批。','将需要读取的目标文档或知识库节点授权给应用；应用权限不等于你的个人权限。','保存凭据、验证连接并启用；聊天时提供文档 ID 或知识库节点 Token。'],usage:['读取指定飞书新版文档 ID 并总结。','解析知识库节点 Token，确认其对应的文档。'],limitations:[connectionNote,readonlyNote,'这是 Jarvis 对飞书官方 API 的适配器，使用应用身份，不是个人账号 OAuth。','暂不支持全文搜索、个人私有文档、表格编辑、文件上传下载或发送消息。','只支持新版 docx 文档正文；知识库节点若指向其他文件类型，不会冒充已读取。','重置或撤销 App Secret 请在官方应用凭证管理中操作；删除本地凭据不会影响其他客户端。']}},
  {id:'atlassian',name:'Jira / Confluence',category:'office',description:'查询项目需求、缺陷和团队知识库；需要组织允许 API Token 登录。',available:true,readOnly:true,version:1,
    fields:[{key:'email',label:'Atlassian 账号邮箱',secret:false,required:true,help:'必须与 API Token 所属账号一致。'},key('apiToken','Scoped API Token')],
    toolPolicy:{permittedReadTools:['atlassianUserInfo','getAccessibleAtlassianResources','getJiraIssue','searchJiraIssuesUsingJql','getConfluenceContent','searchConfluence']},
    help:{credentialsUrl:'https://id.atlassian.com/manage-profile/security/api-tokens',docsUrl:'https://support.atlassian.com/atlassian-ai-gateway/docs/configure-authentication-via-api-token/',revokeUrl:'https://id.atlassian.com/manage-profile/security/api-tokens',setup:['请组织管理员在 Rovo MCP Server 的认证设置中允许 API Token 登录。','在账号安全设置中创建带范围的 API Token，设置有效期。','按需只选 read:jira:agent-interface、search:jira:agent-interface、read:confluence:agent-interface、search:confluence:agent-interface。','填写账号邮箱和 Token，保存、验证并启用。查询时明确指定组织或站点。'],usage:['查询指定 Jira 项目尚未关闭的问题。','搜索 Confluence 中的项目说明。'],limitations:[connectionNote,readonlyNote,'组织政策、IP 白名单及产品权限仍然生效。','不开放通用执行、写入或删除工具；普通 OAuth 登录暂未实现。']}},
  {id:'wps',name:'WPS 办公',category:'office',description:'计划接入 WPS 云文档；当前尚无已核验的可部署 MCP 配置。',available:false,readOnly:true,fields:[],
    help:{credentialsUrl:'https://open.wps.cn/',docsUrl:'https://open.wps.cn/',setup:['当前不收集 WPS 凭据。后续以官方可用接口及授权条件为准。'],usage:['本地文件工具可以管理文件；完整 Office 格式处理与 WPS 云端接入是不同能力。'],limitations:['尚未核验 MCP 端点、认证和工具清单，因此不提供假连接按钮。']}},
  {id:'travel-booking',name:'酒店与票务预订',category:'life',description:'当前提供地图位置与路线查询；交易服务等待正式接入。',available:false,readOnly:true,fields:[],
    help:{credentialsUrl:'https://lbs.amap.com/api/mcp-server/summary',docsUrl:'https://lbs.amap.com/api/mcp-server/summary',setup:['查询酒店或景点位置可先启用高德地图。'],usage:['找目的地附近的酒店与景点，并规划出行路线。'],limitations:['尚未接入实时房态、票价、下单或付款服务。地图信息不能替代预订平台确认。']}},
]

export function buildPresetConfig(id:string,credentials:Record<string,string>,mode:'read'|'write'):ServerInput {
  if(mode!=='read')throw new Error('This preset is read-only')
  for(const value of Object.values(credentials))if(typeof value!=='string'||value.length>8192||/[\r\n\0]/.test(value))throw new Error('Invalid credential')
  const base={id:`preset-${id}`,enabled:false,destination:'remote' as const,tools:{}}
  const remote=(url:string,headers:Record<string,string>):ServerInput=>({...base,transport:'streamable-http',url,headers})
  switch(id){
    case 'amap':return remote(`https://mcp.amap.com/mcp?key=${encodeURIComponent(credentials.apiKey)}`,{})
    case 'tavily':return remote('https://mcp.tavily.com/mcp/',{Authorization:`Bearer ${credentials.apiKey}`})
    case 'context7':return remote('https://mcp.context7.com/mcp',{Authorization:`Bearer ${credentials.apiKey}`})
    case 'github':return remote('https://api.githubcopilot.com/mcp/',{Authorization:`Bearer ${credentials.pat}`,'X-MCP-Readonly':'true','X-MCP-Toolsets':'repos,issues,pull_requests,users'})
    case 'notion':return remote('https://mcp.notion.com/mcp',{Authorization:`Bearer ${credentials.mcpToken}`})
    case 'atlassian':{
      if(!/^[^\s:@]+@[^\s:@]+\.[^\s:@]+$/.test(credentials.email))throw new Error('Invalid account email')
      return remote('https://mcp.atlassian.com/v2/mcp',{Authorization:`Basic ${Buffer.from(`${credentials.email}:${credentials.apiToken}`).toString('base64')}`})
    }
    case 'feishu':{
      if(!/^[A-Za-z0-9_-]{1,128}$/.test(credentials.appId))throw new Error('Invalid application ID')
      return {...base,transport:'stdio',command:process.execPath,args:['--experimental-transform-types',fileURLToPath(new URL('./providers/feishu.ts',import.meta.url))],env:{FEISHU_APP_ID:credentials.appId,FEISHU_APP_SECRET:credentials.appSecret}}
    }
    case 'qweather':{
      const host=credentials.apiHost.toLowerCase()
      if(host.length>253||!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+qweatherapi\.com$/.test(host))throw new Error('Invalid weather API host')
      return {...base,transport:'stdio',command:process.execPath,args:['--experimental-transform-types',fileURLToPath(new URL('./providers/qweather.ts',import.meta.url))],env:{QWEATHER_API_KEY:credentials.apiKey,QWEATHER_API_HOST:host}}
    }
    default:throw new Error('Preset unavailable')
  }
}
