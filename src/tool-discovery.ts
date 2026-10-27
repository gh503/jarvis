import { createHash } from 'node:crypto'
import type { ToolDefinition } from './tools.ts'

/** Discovery returns names only; the loop separately authorizes and budgets activation. */
export function discoveryTool(definitions:()=>ToolDefinition[]):ToolDefinition {
  const parameters={type:'object',properties:{query:{type:'string',minLength:1,maxLength:200}},required:['query'],additionalProperties:false}
  return {name:'tool_search',description:'按服务器、工具名称或任务关键词查找可用的内置和MCP工具。结果中的工具将在下一步按权限和上下文容量加载。',parameters,
    definitionHash:createHash('sha256').update(JSON.stringify(parameters)+'v1').digest('hex'),usage:'shared',permission:'allow',effect:'read',destination:'local',
    async execute(args){
      const query=String(args.query).toLowerCase().trim(),tokens=query.split(/[\s,，。]+/).filter(Boolean)
      if(!query)return {content:JSON.stringify({tools:[],note:'请输入具体关键词。'})}
      const tools=definitions().filter(d=>d.name!=='tool_search'&&d.permission!=='deny').map(d=>{
        const name=d.name.toLowerCase(),haystack=(name+' '+d.description).toLowerCase()
        return {d,score:(name===query||name.split('__').includes(query)?100:name.includes(query)?20:0)+tokens.reduce((n,t)=>n+(name.includes(t)?5:haystack.includes(t)?1:0),0)}
      }).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||(a.d.name<b.d.name?-1:a.d.name>b.d.name?1:0)).slice(0,5)
      return {content:JSON.stringify({tools:tools.map(({d})=>({name:d.name,description:d.description.slice(0,300)})),note:'名称发现不代表已经获得执行权限。'})}
    },
  }
}
