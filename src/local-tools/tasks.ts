import { createHash, randomUUID } from 'node:crypto'
import { constants, accessSync, chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import type { EventBus } from '../events.ts'
import type { ToolDefinition } from '../tools.ts'

type Context = Parameters<ToolDefinition['execute']>[1]
type Result = Awaited<ReturnType<ToolDefinition['execute']>>
type Settings = { revision:number; shellEnabled:boolean; readRoots:string[]; writeRoots:string[]; outputDir:string; skillsDir:string|null }
export interface TaskQuestion { id:string; question:string; options?:{label:string;description?:string}[]; multiSelect?:boolean }
export interface PendingQuestion { id:string; sessionId:string; turnId:string; callId:string; questions:TaskQuestion[]; expiresAt:number }
interface Answers { answers:{id:string;selected:string[];custom?:string}[] }
interface ActiveJob { child:ChildProcess; done:Promise<void>; cancel:()=>void }
const MAX_OUTPUT=65536, MAX_SPILL=8*1024*1024
const result=(data:unknown,isError=false):Result=>({content:JSON.stringify(data),...(isError?{isError:true}:{})})
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
const keys=(value:Record<string,unknown>,allowed:string[])=>Object.keys(value).every(k=>allowed.includes(k))
const text=(value:unknown,max=8000):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=max&&!value.includes('\0')
const inside=(root:string,path:string)=>path===root||path.startsWith(root.endsWith(sep)?root:root+sep)
const schema=(properties:Record<string,unknown>,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false})
const stringSchema={type:'string',minLength:1,maxLength:8000}
const questionSchema=schema({questions:{type:'array',minItems:1,maxItems:4,items:schema({id:{...stringSchema,maxLength:128},question:stringSchema,options:{type:'array',minItems:1,maxItems:20,items:schema({label:{...stringSchema,maxLength:256},description:stringSchema},['label'])},multiSelect:{type:'boolean'}},['id','question'])}})
const jobSchema=schema({id:{...stringSchema,maxLength:128}})

/** Private, local-only task state. Questions are user data, never tool permission grants. */
export class TaskTools {
  private readonly db:DatabaseSync
  private readonly pending=new Map<string,{value:PendingQuestion;finish:(state:string,answer?:Answers)=>void}>()
  private readonly active=new Map<string,ActiveJob>()
  private readonly privateDir:string
  private readonly spills:string
  private sandboxReady=false
  private sandboxReason='Sandbox capability has not been checked'
  private initialization?:Promise<void>
  private closed=false
  private closing=false
  private readonly options:{file:string;bus:EventBus;settings:{snapshot():Settings}}
  constructor(options:{file:string;bus:EventBus;settings:{snapshot():Settings}}){
    this.options=options
    mkdirSync(dirname(resolve(options.file)),{recursive:true,mode:0o700})
    this.privateDir=realpathSync(dirname(resolve(options.file)))
    if(existsSync(options.file)&&lstatSync(options.file).isSymbolicLink())throw new Error('Task database must not be a symlink')
    const fd=openSync(options.file,constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW,0o600);closeSync(fd);chmodSync(options.file,0o600)
    this.spills=join(this.privateDir,'task-output')
    if(existsSync(this.spills)&&lstatSync(this.spills).isSymbolicLink())throw new Error('Task output must not be a symlink')
    mkdirSync(this.spills,{recursive:true,mode:0o700});chmodSync(this.spills,0o700)
    this.db=new DatabaseSync(options.file)
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS plans(session_id TEXT PRIMARY KEY,todos TEXT NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS questions(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,turn_id TEXT NOT NULL,call_id TEXT NOT NULL,prompt TEXT NOT NULL,answers TEXT,status TEXT NOT NULL,expires_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,turn_id TEXT NOT NULL,call_id TEXT NOT NULL,command TEXT NOT NULL,workdir TEXT NOT NULL,status TEXT NOT NULL,pid INTEGER,output TEXT NOT NULL DEFAULT '',output_bytes INTEGER NOT NULL DEFAULT 0,output_chars INTEGER NOT NULL DEFAULT 0,spill TEXT,spill_truncated INTEGER NOT NULL DEFAULT 0,exit_code INTEGER,signal TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      UPDATE questions SET status='cancelled',updated_at=${Date.now()} WHERE status='pending';
      UPDATE jobs SET status='interrupted',pid=NULL,updated_at=${Date.now()} WHERE status IN ('running','cancelling');`)
  }
  initialize():Promise<void>{
    return this.initialization??=new Promise(resolveProbe=>{
      try{accessSync('/usr/bin/bwrap',constants.X_OK);if(!lstatSync('/usr/bin/bwrap').isFile())throw new Error('not a regular executable')}
      catch{this.sandboxReason='Bubblewrap /usr/bin/bwrap is unavailable';resolveProbe();return}
      let settled=false
      const child=spawn('/usr/bin/bwrap',[...this.baseSandbox(),'/usr/bin/true'],{env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},stdio:'ignore',detached:true})
      const finish=(ok:boolean)=>{if(settled)return;settled=true;clearTimeout(timer);this.sandboxReady=ok;this.sandboxReason=ok?'Bubblewrap available: no network; shell access is restricted to generated output; file-tool grants do not grant shell access':'Bubblewrap isolation probe failed (user namespaces may be unavailable)';resolveProbe()}
      const timer=setTimeout(()=>{this.killGroup(child,'SIGKILL');finish(false)},3000)
      child.once('error',()=>finish(false));child.once('close',code=>finish(code===0))
    })
  }
  status(){const enabled=this.options.settings.snapshot().shellEnabled;const available=enabled&&this.sandboxReady&&!this.closed&&!this.closing,reason=this.sandboxReason;return {shellAvailable:this.sandboxReady,reason,shell:{enabled,available,reason},pendingQuestions:this.pending.size,runningJobs:this.active.size}}
  definitions():ToolDefinition[]{
    const revision=this.options.settings.snapshot().revision
    const tool=(name:string,description:string,parameters:Record<string,unknown>,execute:ToolDefinition['execute'],write=false):ToolDefinition=>({name,description,parameters,execute,usage:'local',destination:'local',permission:write?'ask':'allow',effect:write?'write':'read',definitionHash:createHash('sha256').update(JSON.stringify([name,parameters,revision,'tasks-v1'])).digest('hex')})
    const definitions=[
      {...tool('ask_user_question','Ask up to four structured questions and wait for a local user answer. Answers are private local data, not permissions.',questionSchema,(args,ctx)=>this.ask(args,ctx)),timeoutMs:240000},
      tool('todo_write','Replace the complete todo list for this session.',schema({todos:{type:'array',maxItems:100,items:schema({content:stringSchema,status:{enum:['pending','in_progress','completed']}})}}),async(args,ctx)=>{
        this.check(ctx);if(!Array.isArray(args.todos)||args.todos.length>100||args.todos.some(t=>!object(t)||!keys(t,['content','status'])||!text(t.content)||!['pending','in_progress','completed'].includes(String(t.status))))throw new Error('Invalid todo list')
        this.db.prepare('INSERT INTO plans VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET todos=excluded.todos,updated_at=excluded.updated_at').run(ctx.sessionId,JSON.stringify(args.todos),Date.now());this.options.bus.emit('task.plan',{sessionId:ctx.sessionId});return result(this.plan(ctx.sessionId))
      }),
      tool('todo_read','Read the todo list owned by this session.',schema({}),async(_args,ctx)=>{this.check(ctx);return result(this.plan(ctx.sessionId))}),
      tool('job_list','List local jobs owned by this session.',schema({}),async(_args,ctx)=>{this.check(ctx);return result(this.jobs(ctx.sessionId))}),
      tool('job_output','Read bounded output from a local job owned by this session.',jobSchema,async(args,ctx)=>{this.check(ctx);const row=this.job(String(args.id),ctx.sessionId);return row?result(row):result({error:'Job not found',status:404},true)}),
      tool('job_cancel','Cancel a local job owned by this session. Already performed filesystem writes are not rolled back.',jobSchema,async(args,ctx)=>{this.check(ctx);const found=this.cancelJob(String(args.id),ctx.sessionId);return found?result(this.job(String(args.id),ctx.sessionId)):result({error:'Job not found',status:404},true)}),
    ]
    if(this.status().shell.available)definitions.push(tool('shell_execute','Execute bash inside a network-isolated sandbox with access only to the generated output directory and read-only system binaries. File-tool read/write grants do not grant shell access. Writes require approval; cancellation does not undo writes.',schema({command:{...stringSchema,maxLength:16000},workdir:{...stringSchema,maxLength:4096},runInBackground:{type:'boolean'}},['command']),(args,ctx)=>this.shell(args,ctx),true))
    return definitions
  }
  private check(ctx:Context){if(this.closed||this.closing)throw new Error('Task tools closed');if(ctx.signal.aborted)throw new Error('Task cancelled before dispatch')}
  private validQuestions(value:unknown):value is TaskQuestion[]{
    if(!Array.isArray(value)||!value.length||value.length>4)return false
    const ids=new Set<string>()
    for(const q of value){
      if(!object(q)||!keys(q,['id','question','options','multiSelect'])||!text(q.id,128)||ids.has(q.id)||!text(q.question)||(q.multiSelect!==undefined&&typeof q.multiSelect!=='boolean'))return false
      ids.add(q.id)
      if(q.options!==undefined){if(!Array.isArray(q.options)||!q.options.length||q.options.length>20)return false;const labels=new Set<string>();for(const o of q.options){if(!object(o)||!keys(o,['label','description'])||!text(o.label,256)||labels.has(o.label)||(o.description!==undefined&&!text(o.description)))return false;labels.add(o.label)}}
    }
    return true
  }
  private async ask(args:Record<string,unknown>,ctx:Context):Promise<Result>{
    this.check(ctx);if(!keys(args,['questions'])||!this.validQuestions(args.questions))throw new Error('Invalid questions')
    const value:PendingQuestion={id:randomUUID(),sessionId:ctx.sessionId,turnId:ctx.turnId,callId:ctx.callId,questions:structuredClone(args.questions),expiresAt:Date.now()+120000}
    this.db.prepare('INSERT INTO questions VALUES(?,?,?,?,?,NULL,?,?,?)').run(value.id,value.sessionId,value.turnId,value.callId,JSON.stringify(value.questions),'pending',value.expiresAt,Date.now())
    return new Promise(resolveAnswer=>{
      let settled=false
      const finish=(state:string,answer?:Answers)=>{if(settled)return;settled=true;clearTimeout(timer);ctx.signal.removeEventListener('abort',abort);this.pending.delete(value.id);this.db.prepare('UPDATE questions SET answers=?,status=?,updated_at=? WHERE id=?').run(answer?JSON.stringify(answer):null,state,Date.now(),value.id);this.options.bus.emit('task.question.resolved',{id:value.id,sessionId:value.sessionId,turnId:value.turnId,status:state});resolveAnswer(result({id:value.id,status:state,...answer},state!=='answered'))}
      const abort=()=>finish('cancelled'),timer=setTimeout(()=>finish('expired'),120000)
      this.pending.set(value.id,{value,finish});ctx.signal.addEventListener('abort',abort,{once:true})
      if(ctx.signal.aborted){abort();return}
      this.options.bus.emit('task.question',structuredClone(value))
    })
  }
  pendingQuestions():PendingQuestion[]{return [...this.pending.values()].map(entry=>structuredClone(entry.value))}
  answer(id:string,identity:{sessionId:string;turnId:string},payload:unknown):boolean{
    const entry=this.pending.get(id)
    if(!entry||!identity||identity.sessionId!==entry.value.sessionId||identity.turnId!==entry.value.turnId)return false
    if(entry.value.expiresAt<=Date.now()){entry.finish('expired');return false}
    if(!object(payload)||!keys(payload,['answers'])||!Array.isArray(payload.answers)||payload.answers.length!==entry.value.questions.length)return false
    const seen=new Set<string>()
    for(const a of payload.answers){
      if(!object(a)||!keys(a,['id','selected','custom'])||!text(a.id,128)||seen.has(a.id)||!Array.isArray(a.selected)||a.selected.some(s=>!text(s,256))||new Set(a.selected).size!==a.selected.length||(a.custom!==undefined&&!text(a.custom,8000)))return false
      const q=entry.value.questions.find(q=>q.id===a.id);if(!q||(!q.multiSelect&&a.selected.length>1)||a.selected.some(s=>!q.options?.some(o=>o.label===s))||(!a.selected.length&&!a.custom))return false
      seen.add(a.id)
    }
    entry.finish('answered',structuredClone(payload) as unknown as Answers);return true
  }
  plan(sessionId:string){const row=this.db.prepare('SELECT todos,updated_at FROM plans WHERE session_id=?').get(sessionId);return {todos:row?JSON.parse(String(row.todos)):[],updatedAt:row?Number(row.updated_at):null}}
  private job(id:string,sessionId:string){const row=this.db.prepare('SELECT * FROM jobs WHERE id=? AND session_id=?').get(id,sessionId);return row?this.publicJob(row):undefined}
  private publicJob(row:Record<string,unknown>){return {id:String(row.id),sessionId:String(row.session_id),turnId:String(row.turn_id),callId:String(row.call_id),command:String(row.command),workdir:String(row.workdir),status:String(row.status),output:String(row.output),outputBytes:Number(row.output_bytes),outputChars:Number(row.output_chars),spillFile:row.spill,spillTruncated:!!row.spill_truncated,exitCode:row.exit_code,signal:row.signal,createdAt:Number(row.created_at),updatedAt:Number(row.updated_at)}}
  jobs(sessionId:string){return this.db.prepare('SELECT * FROM jobs WHERE session_id=? ORDER BY created_at DESC LIMIT 100').all(sessionId).map(row=>this.publicJob(row))}
  cancelJob(id:string,sessionId:string):boolean{if(!this.job(id,sessionId))return false;this.active.get(id)?.cancel();return true}
  private baseSandbox():string[]{
    const args=['--unshare-all','--unshare-net','--die-with-parent','--new-session','--clearenv','--setenv','PATH','/usr/bin:/bin','--setenv','LANG','C.UTF-8','--setenv','HOME','/tmp','--proc','/proc','--dev','/dev','--tmpfs','/tmp']
    for(const path of ['/usr','/bin','/lib','/lib64'])if(existsSync(path)){const real=realpathSync(path);if(real===path)args.push('--ro-bind',real,path);else args.push('--symlink',real,path)}
    return args
  }
  private roots(settings:Settings){
    const canonical=(path:string)=>{if(!isAbsolute(path)||!text(path,4096))throw new Error('Root must be an absolute directory');const real=realpathSync(path);if(!lstatSync(real).isDirectory())throw new Error('Root must be a directory');if(inside(real,this.privateDir)||(inside(this.privateDir,real)&&!inside(realpathSync(settings.outputDir),real))||inside(real,this.spills)||inside(this.spills,real)||['/proc','/sys','/dev'].some(p=>inside(p,real))||real==='/tmp'||real==='/')throw new Error('Root conflicts with private task storage or sandbox mounts');return real}
    // File-tool grants never grant shell access: file reads have secret filtering that
    // arbitrary shell commands cannot enforce. Only generated output is mounted.
    const reads:string[]=[],writes=[canonical(settings.outputDir)]
    for(const root of writes)if(['/usr','/bin','/lib','/lib64','/etc'].some(p=>inside(p,root)))throw new Error('System directories cannot be writable')
    return {reads,writes}
  }
  private async shell(args:Record<string,unknown>,ctx:Context):Promise<Result>{
    this.check(ctx);if(!this.status().shell.available)throw new Error('Sandbox shell unavailable')
    if(!keys(args,['command','workdir','runInBackground'])||!text(args.command,16000)||(args.workdir!==undefined&&!text(args.workdir,4096))||(args.runInBackground!==undefined&&typeof args.runInBackground!=='boolean'))throw new Error('Invalid shell arguments')
    const settings=this.options.settings.snapshot(),{reads,writes}=this.roots(settings)
    const cwd=realpathSync(args.workdir===undefined?settings.outputDir:String(args.workdir))
    if(!lstatSync(cwd).isDirectory()||![...reads,...writes].some(root=>inside(root,cwd)))throw new Error('Working directory is not approved')
    const sandbox=this.baseSandbox()
    // Bind parents before children so an explicit read-only child stays read-only.
    const mounts=[...reads.map(path=>({path,write:false})),...writes.map(path=>({path,write:true}))].sort((a,b)=>a.path.length-b.path.length)
    for(const mount of mounts)sandbox.push(mount.write?'--bind':'--ro-bind',mount.path,mount.path)
    sandbox.push('--chdir',cwd,'/bin/bash','--noprofile','--norc','-c',args.command)
    this.check(ctx)
    const id=randomUUID(),now=Date.now(),spill=join(this.spills,`${id}.log`)
    const fd=openSync(spill,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)
    this.db.prepare('INSERT INTO jobs(id,session_id,turn_id,call_id,command,workdir,status,spill,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,ctx.sessionId,ctx.turnId,ctx.callId,args.command,cwd,'running',spill,now,now)
    const child=spawn('/usr/bin/bwrap',sandbox,{cwd:'/',env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},stdio:['ignore','pipe','pipe'],detached:true})
    this.db.prepare('UPDATE jobs SET pid=? WHERE id=?').run(child.pid??null,id)
    let output=Buffer.alloc(0),bytes=0,chars=0,spilled=0,cancelled=false,settled=false,escalation:ReturnType<typeof setTimeout>|undefined
    let resolveDone!:()=>void
    const done=new Promise<void>(resolve=>{resolveDone=resolve})
    const capture=(chunk:Buffer|string)=>{const data=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);bytes+=data.length;chars+=data.toString('utf8').length;if(output.length<MAX_OUTPUT)output=Buffer.concat([output,data.subarray(0,MAX_OUTPUT-output.length)]);if(spilled<MAX_SPILL){const bounded=data.subarray(0,MAX_SPILL-spilled);try{writeSync(fd,bounded);spilled+=bounded.length}catch{spilled=MAX_SPILL}}this.db.prepare('UPDATE jobs SET output=?,output_bytes=?,output_chars=?,spill_truncated=?,updated_at=? WHERE id=?').run(output.toString('utf8'),bytes,chars,bytes>spilled?1:0,Date.now(),id)}
    const cancel=()=>{if(cancelled||settled)return;cancelled=true;this.db.prepare("UPDATE jobs SET status='cancelling',updated_at=? WHERE id=?").run(Date.now(),id);this.killGroup(child,'SIGTERM');escalation=setTimeout(()=>this.killGroup(child,'SIGKILL'),1000)}
    const finish=(code:number|null,signal:string|null,error?:Error)=>{
      if(settled)return;settled=true;if(escalation)clearTimeout(escalation);this.killGroup(child,'SIGKILL');ctx.signal.removeEventListener('abort',cancel)
      if(error)capture(Buffer.from(`\n${error.message}`));closeSync(fd)
      const status=cancelled?'cancelled':code===0?'succeeded':'failed'
      this.db.prepare('UPDATE jobs SET status=?,exit_code=?,signal=?,pid=NULL,updated_at=? WHERE id=?').run(status,code,signal,Date.now(),id)
      this.active.delete(id);this.options.bus.emit('task.job',{id,sessionId:ctx.sessionId,status});resolveDone()
    }
    this.active.set(id,{child,done,cancel});child.stdout?.on('data',capture);child.stderr?.on('data',capture);child.once('error',error=>finish(null,null,error));child.once('close',(code,signal)=>finish(code,signal));ctx.signal.addEventListener('abort',cancel,{once:true});if(ctx.signal.aborted)cancel()
    this.options.bus.emit('task.job',{id,sessionId:ctx.sessionId,status:'running'})
    if(!args.runInBackground){let timer:ReturnType<typeof setTimeout>|undefined;await Promise.race([done,new Promise<void>(resolve=>{timer=setTimeout(resolve,10000)})]);if(timer)clearTimeout(timer)}
    const job=this.job(id,ctx.sessionId);return result(job,cancelled||job?.status==='failed')
  }
  private killGroup(child:ChildProcess,signal:NodeJS.Signals){if(!child.pid)return;try{process.kill(-child.pid,signal)}catch{};try{child.kill(signal)}catch{}}
  cancelAll(){for(const question of [...this.pending.values()])question.finish('cancelled');for(const job of this.active.values())job.cancel()}
  async quiesce(){this.cancelAll();await Promise.allSettled([...this.active.values()].map(job=>job.done));if(this.initialization)await this.initialization}
  async clearSession(sessionId:string){for(const question of [...this.pending.values()])if(question.value.sessionId===sessionId)question.finish('cancelled');const running=this.db.prepare('SELECT id FROM jobs WHERE session_id=?').all(sessionId).map(job=>this.active.get(String(job.id))).filter((job):job is ActiveJob=>!!job);for(const job of running)job.cancel();await Promise.allSettled(running.map(job=>job.done));this.removeSpills(sessionId);for(const table of ['plans','questions','jobs'])this.db.prepare(`DELETE FROM ${table} WHERE session_id=?`).run(sessionId)}
  private removeSpills(sessionId?:string){const rows=sessionId===undefined?this.db.prepare('SELECT id,spill FROM jobs').all():this.db.prepare('SELECT id,spill FROM jobs WHERE session_id=?').all(sessionId);for(const row of rows){if(row.spill===null)continue;const target=resolve(String(row.spill));if(target!==join(this.spills,`${String(row.id)}.log`)||dirname(target)!==this.spills)throw new Error('Unexpected task output path');try{unlinkSync(target)}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}}}
  async clearAll(){await this.quiesce();this.removeSpills();this.db.exec('DELETE FROM plans; DELETE FROM questions; DELETE FROM jobs; VACUUM;')}
  exportSession(sessionId:string){return {plan:this.plan(sessionId),jobs:this.db.prepare('SELECT * FROM jobs WHERE session_id=? ORDER BY created_at').all(sessionId).map(row=>this.publicJob(row)).map(({spillFile,...job})=>job),questions:this.db.prepare('SELECT id,turn_id,call_id,prompt,answers,status,expires_at,updated_at FROM questions WHERE session_id=? ORDER BY updated_at').all(sessionId).map(row=>({id:row.id,turnId:row.turn_id,callId:row.call_id,questions:JSON.parse(String(row.prompt)),answers:row.answers?JSON.parse(String(row.answers)):null,status:row.status,expiresAt:row.expires_at,updatedAt:row.updated_at}))}}
  async close(){if(this.closed)return;this.closing=true;await this.quiesce();this.db.close();this.closed=true}
}
