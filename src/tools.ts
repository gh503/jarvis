import { randomUUID } from 'node:crypto'
import { validateToolArguments } from './tool-schema.ts'
import type { ToolCall, ToolSchema } from './model/types.ts'
import type { ToolJournal } from './tool-journal.ts'
import type { EventBus } from './events.ts'

export interface ToolDefinition extends ToolSchema {
  definitionHash:string;usage:'local'|'shared';permission:'allow'|'ask'|'deny';effect:'read'|'write';destination:'local'|'remote'
  execute(args:Record<string,unknown>,context:{signal:AbortSignal;sessionId:string;turnId:string;callId:string}):Promise<{content:string;isError?:boolean}>
}
interface Execution {sessionId:string;turnId:string;step:number;call:ToolCall;signal:AbortSignal;allowedDefinitions:Map<string,string>;allowRemote:boolean;allowLocalResults:boolean}
export interface ToolOutcome {content:string;isError:boolean;localOnly:boolean;status:string}
interface Approval {id:string;sessionId:string;turnId:string;callId:string;name:string;args:unknown;expiresAt:number}
const safeObject=(value:unknown,depth=0):boolean=>{
  if(depth>20 || (typeof value==='number' && !Number.isFinite(value)) || (typeof value==='string' && value.includes('\u0000')))return false
  if(value && typeof value==='object')return Object.entries(value).every(([key,child])=>!['__proto__','constructor','prototype'].includes(key)&&safeObject(child,depth+1))
  return true
}
export class ToolRuntime {
  private readonly approvals=new Map<string,{value:Approval;resolve:(value:boolean)=>void}>()
  private readonly controllers=new Set<AbortController>()
  private readonly jobs=new Set<Promise<unknown>>()
  private readonly executions=new Set<Promise<unknown>>()
  private cancellationEpoch=0
  constructor(private readonly deps:{definitions:()=>ToolDefinition[];journal:ToolJournal;bus:EventBus}){}
  catalogue():ToolDefinition[]{return this.deps.definitions()}
  schemas(policy:{allowRemote:boolean;allowLocalResults:boolean}):ToolSchema[]{return this.catalogue().filter(d=>this.allowed(d,policy)).map(({name,description,parameters})=>({name,description,parameters}))}
  private allowed(d:ToolDefinition,p:{allowRemote:boolean;allowLocalResults:boolean}){return d.permission!=='deny'&&(p.allowRemote||d.destination==='local')&&(p.allowLocalResults||d.usage==='shared')}
  pending():Approval[]{return [...this.approvals.values()].map(x=>structuredClone(x.value))}
  approve(id:string,approved:boolean,identity?:{sessionId:string;turnId:string}):boolean{
    const entry=this.approvals.get(id)
    if(!entry||entry.value.expiresAt<=Date.now()||!identity||identity.sessionId!==entry.value.sessionId||identity.turnId!==entry.value.turnId)return false
    entry.resolve(approved);return true
  }
  cancelAll(){this.cancellationEpoch++;for(const entry of this.approvals.values())entry.resolve(false);for(const c of this.controllers)c.abort(new Error('工具执行已取消'))}
  async quiesce(){this.cancelAll();await Promise.allSettled([...this.jobs]);await Promise.allSettled([...this.executions])}
  execute(input:Execution):Promise<ToolOutcome>{const job=this.run(input);this.jobs.add(job);void job.finally(()=>this.jobs.delete(job)).catch(()=>{});return job}
  private async ask(input:Execution,args:unknown):Promise<boolean>{
    if(input.signal.aborted)return false
    const value:Approval={id:randomUUID(),sessionId:input.sessionId,turnId:input.turnId,callId:input.call.id,name:input.call.name,args,expiresAt:Date.now()+120000}
    return new Promise(resolve=>{
      const done=(approved:boolean)=>{clearTimeout(timer);input.signal.removeEventListener('abort',abort);this.approvals.delete(value.id);resolve(approved)}
      const abort=()=>done(false),timer=setTimeout(abort,120000)
      this.approvals.set(value.id,{value,resolve:done});input.signal.addEventListener('abort',abort,{once:true})
      this.deps.bus.emit('tool.approval',structuredClone(value) as unknown as Record<string,unknown>)
    })
  }
  private async run(input:Execution):Promise<ToolOutcome>{
    const cancellationEpoch=this.cancellationEpoch
    const identity={sessionId:input.sessionId,turnId:input.turnId,callId:input.call.id}
    const prior=this.deps.journal.getCall(input.sessionId,input.turnId,input.call.id)
    if(prior)return {content:prior.content||'此调用已记录，结果未知或仍在执行；不会重复执行。',status:prior.status,isError:prior.status!=='succeeded',localOnly:prior.localOnly}
    let definition=this.catalogue().find(d=>d.name===input.call.name)
    const initialBoundary=definition ? JSON.stringify([definition.usage,definition.destination,definition.effect,definition.parameters]) : ''
    const boundaryUnchanged=(d:ToolDefinition)=>JSON.stringify([d.usage,d.destination,d.effect,d.parameters])===initialBoundary
    let args:Record<string,unknown>={},validationError=''
    try{
      if(Buffer.byteLength(input.call.arguments)>65536)throw new Error('工具参数过大')
      const parsed:unknown=JSON.parse(input.call.arguments||'{}')
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||!safeObject(parsed))throw new Error('工具参数须为安全JSON对象')
      args=parsed as Record<string,unknown>
      if(!definition||input.allowedDefinitions.get(definition.name)!==definition.definitionHash||!this.allowed(definition,input))throw new Error('工具不可用、定义已变化或权限不足')
      const validation=await validateToolArguments(definition.parameters,args,input.signal)
      if(!validation.valid)throw new Error(validation.error??'工具参数不符合声明的结构')
    }catch(error){args={};validationError=error instanceof Error?error.message:String(error)}
    const localOnly=definition?.usage==='local'
    const started=this.deps.journal.startCall({...identity,step:input.step,name:input.call.name,args,definitionHash:definition?.definitionHash??'unavailable',localOnly})
    if(!started.created)return {content:'调用已存在，不会重复执行。',isError:true,localOnly,status:'unknown'}
    const finish=(status:'succeeded'|'failed'|'denied'|'cancelled'|'unknown',content:string,errorCode?:string):ToolOutcome=>{
      content=content.replaceAll('\u0000','�')
      const bounded=content.length>16000?content.slice(0,15000)+'\n[结果过长，已截断]\n'+content.slice(-700):content
      this.deps.journal.finishCall({...identity,status,content:bounded,errorCode,localOnly})
      this.deps.bus.emit('tool.result',{...identity,name:input.call.name,status,localOnly})
      return {content:bounded,status,localOnly,isError:status!=='succeeded'}
    }
    if(input.signal.aborted || cancellationEpoch!==this.cancellationEpoch)return finish('cancelled','工具未开始：回合已取消。','ABORTED_BEFORE_DISPATCH')
    if(validationError)return finish('denied',validationError,'INVALID_TOOL_CALL')
    if(input.signal.aborted||cancellationEpoch!==this.cancellationEpoch)return finish('cancelled','工具未开始：回合已取消。','ABORTED_BEFORE_DISPATCH')
    definition=this.catalogue().find(d=>d.name===input.call.name)
    if(!definition||input.allowedDefinitions.get(definition.name)!==definition.definitionHash||!this.allowed(definition,input)||!boundaryUnchanged(definition))return finish('denied','工具配置或权限已变化，未执行。','DEFINITION_CHANGED')
    let approvedForAsk=false
    if(definition.permission==='ask'){
      const approved=await this.ask(input,args)
      this.deps.journal.recordApproval(input.sessionId,input.turnId,input.call.id,{approved,at:Date.now()})
      approvedForAsk=approved
      if(!approved)return finish(input.signal.aborted||cancellationEpoch!==this.cancellationEpoch?'cancelled':'denied','用户未批准此操作，未执行。','APPROVAL_DENIED')
    }
    definition=this.catalogue().find(d=>d.name===input.call.name)
    if(input.signal.aborted||cancellationEpoch!==this.cancellationEpoch)return finish('cancelled','工具未开始：回合已取消。','ABORTED_BEFORE_DISPATCH')
    if(!definition||input.allowedDefinitions.get(definition.name)!==definition.definitionHash||!this.allowed(definition,input)||!boundaryUnchanged(definition))return finish('denied','工具配置或权限已变化，未执行。','DEFINITION_CHANGED')
    if(definition.permission==='ask'&&!approvedForAsk)return finish('denied','工具现在需要确认，未执行。','APPROVAL_REQUIRED')
    const controller=new AbortController();this.controllers.add(controller)
    const abort=()=>controller.abort(input.signal.reason??new Error('已取消'))
    input.signal.addEventListener('abort',abort,{once:true})
    const timeout=setTimeout(()=>controller.abort(new Error('工具执行超时')),60000)
    this.deps.bus.emit('tool.started',{...identity,name:definition.name})
    let abortListener:()=>void=()=>{}
    try{
      if(controller.signal.aborted)return finish('cancelled','工具未开始：回合已取消。','ABORTED_BEFORE_DISPATCH')
      const cancelled=new Promise<never>((_,reject)=>{abortListener=()=>reject(controller.signal.reason??new Error('已取消'));controller.signal.addEventListener('abort',abortListener,{once:true});if(controller.signal.aborted)abortListener()})
      const execution=definition.execute(structuredClone(args),{...identity,signal:controller.signal})
      this.executions.add(execution)
      void execution.finally(()=>this.executions.delete(execution)).catch(()=>{})
      const result=await Promise.race([execution,cancelled])
      if(controller.signal.aborted)throw controller.signal.reason
      return finish(result.isError?'failed':'succeeded',String(result.content))
    }catch(error){
      const unknown=definition.effect==='write'
      return finish(unknown?'unknown':controller.signal.aborted?'cancelled':'failed',unknown?'操作可能已执行，但未能确认结果。请核实外部状态，不会自动重试。':`工具失败：${error instanceof Error?error.message:String(error)}`,unknown?'TOOL_OUTCOME_UNKNOWN':'TOOL_FAILED')
    }finally{clearTimeout(timeout);input.signal.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',abortListener);this.controllers.delete(controller)}
  }
}
