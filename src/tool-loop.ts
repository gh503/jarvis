import type { ChatMessage, ChatOptions, ModelClient, ToolCall, ToolSchema } from './model/types.ts'
import { estimateMessagesTokens, estimateTextTokens } from './model/context-budget.ts'
import type { ToolRuntime } from './tools.ts'
import type { ToolJournal } from './tool-journal.ts'

export interface ToolLoopInput {
  client:ModelClient; options:ChatOptions; messages:ChatMessage[]; schemas:ToolSchema[]
  allowedDefinitions:Map<string,string>;runtime:ToolRuntime;journal:ToolJournal
  sessionId:string;turnId:string;allowRemote:boolean;allowLocalResults:boolean
  contextWindow:number;maxTokens:number;check():void
  delta(text:string):void;notice(text:string):void
}
export interface ToolLoopResult {text:string;calls:string[];localOnly:boolean;uncertain:boolean}

/** One user turn: complete tool calls are recorded before dispatch and never replayed. */
export async function runToolLoop(input:ToolLoopInput):Promise<ToolLoopResult> {
  if(!input.client.toolStream) throw new Error('当前模型未提供原生工具调用接口')
  const messages=structuredClone(input.messages)
  const calls:string[]=[]
  let localOnly=false,uncertain=false,finalText=''
  const deadline=Date.now()+180_000
  let schemas=[...input.schemas]
  let schemaTokens=estimateTextTokens(JSON.stringify(schemas))+32
  let budget=input.contextWindow-input.maxTokens-Math.max(128,Math.ceil(input.contextWindow*.08))-schemaTokens
  for(let step=0;step<8;step++) {
    input.check()
    if(Date.now()>deadline) throw new Error('本轮工具执行已达到时间上限，请查看执行记录后继续。')
    if(estimateMessagesTokens(messages)>budget) {
      // Preserve call/result pairing. Shrink only older result bodies, never tool arguments.
      for(const message of messages) if(message.role==='tool' && message.content.length>600) message.content=message.content.slice(0,400)+'\n[工具结果已缩短，完整记录可在本轮工具详情查看]\n'+message.content.slice(-150)
      if(estimateMessagesTokens(messages)>budget) throw new Error('工具上下文达到模型容量，已停止继续调用；已完成操作保存在执行记录中。')
    }
    input.journal.beginStep({sessionId:input.sessionId,turnId:input.turnId,step,requestMessages:messages,tools:schemas})
    let text='',finish=false,finishReason=''
    const proposed:ToolCall[]=[]
    const stepDefinitions=new Map([...input.allowedDefinitions].filter(([name])=>schemas.some(s=>s.name===name)))
    for await(const event of input.client.toolStream(messages,{...input.options,tools:schemas,numCtx:input.contextWindow,maxTokens:input.maxTokens})) {
      input.check()
      if(event.type==='text') {text+=event.text}
      if(event.type==='tool-call') proposed.push(event.call)
      if(event.type==='finish') {
        finish=true
        finishReason=event.reason
        if(event.reason==='length') throw new Error('模型输出达到长度上限，本步骤未执行工具操作。')
      }
    }
    input.check()
    if(!finish) throw new Error('模型工具响应未正常结束，未执行操作。')
    if(finishReason==='tool-calls'&&!proposed.length)throw new Error('模型声明了工具调用但未返回调用内容。')
    if(proposed.length && finishReason!=='tool-calls')throw new Error('模型工具调用结束状态不一致，未执行操作。')
    input.journal.recordAssistant({sessionId:input.sessionId,turnId:input.turnId,step,text,toolCalls:proposed})
    if(!proposed.length) {
      finalText=text.trim()
      if(finalText) input.delta(finalText)
      return {text:finalText,calls,localOnly,uncertain}
    }
    if(calls.length+proposed.length>16) throw new Error('本轮工具调用达到数量上限，后续操作未执行。')
    messages.push({role:'assistant',content:text,toolCalls:proposed})
    for(const call of proposed) {
      input.check()
      input.notice(`正在调用 ${call.name}`)
      const result=await input.runtime.execute({sessionId:input.sessionId,turnId:input.turnId,step,call,signal:input.options.signal ?? AbortSignal.timeout(180000),allowedDefinitions:stepDefinitions,allowRemote:input.allowRemote,allowLocalResults:input.allowLocalResults})
      calls.push(call.id)
      localOnly ||= result.localOnly
      uncertain ||= result.status==='unknown'
      input.check()
      messages.push({role:'tool',toolCallId:call.id,name:call.name,content:result.content})
      // Once local data enters, it cannot be sent to remote tools later in the same turn.
      if(result.localOnly) input.allowRemote=false
      if(call.name==='tool_search'&&!result.isError){
        const found=JSON.parse(result.content) as {tools?:Array<{name:string}>}
        const available=input.runtime.schemas({allowRemote:input.allowRemote,allowLocalResults:input.allowLocalResults})
        const discovered=(found.tools??[]).map(t=>available.find(d=>d.name===t.name)).filter((t):t is ToolSchema=>Boolean(t))
        if(discovered.length){
          const candidates=[...discovered,...schemas.filter(s=>!discovered.some(d=>d.name===s.name))]
          const cap=Math.floor(input.contextWindow*.3)
          const next:ToolSchema[]=[]
          for(const candidate of candidates)if(estimateTextTokens(JSON.stringify([...next,candidate]))+32<=cap)next.push(candidate)
          if(next.some(s=>discovered.some(d=>d.name===s.name))){
            schemas=next
            schemaTokens=estimateTextTokens(JSON.stringify(schemas))+32
            budget=input.contextWindow-input.maxTokens-Math.max(128,Math.ceil(input.contextWindow*.08))-schemaTokens
            for(const d of input.runtime.catalogue())if(schemas.some(s=>s.name===d.name)&&!input.allowedDefinitions.has(d.name))input.allowedDefinitions.set(d.name,d.definitionHash)
            messages[messages.length-1].content+='\n已加载工具：'+schemas.filter(s=>discovered.some(d=>d.name===s.name)).map(s=>s.name).join(', ')
          } else messages[messages.length-1].content+='\n工具定义超过当前模型容量，未加载；请切换更大上下文的模型。'
        } else messages[messages.length-1].content+='\n没有符合本轮隐私权限的工具可加载。'
      }
      if(result.status==='unknown') {
        const text='工具操作的结果尚不确定，可能已经执行。我已停止后续操作，请先核实外部状态；不会自动重试。'
        input.delta(text)
        return {text,calls,localOnly,uncertain:true}
      }
    }
  }
  const text='已达到本轮工具步骤上限，后续操作未执行。已完成操作可在工具记录中查看。'
  input.delta(text)
  return {text,calls,localOnly,uncertain:true}
}
