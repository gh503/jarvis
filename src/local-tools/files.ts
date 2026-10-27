import { constants as C, openSync, closeSync, fstatSync, readSync, readdirSync, lstatSync, rmdirSync, writeFileSync, fsyncSync, renameSync, unlinkSync, opendirSync, realpathSync, linkSync } from 'node:fs'
import { basename, dirname, join, relative, extname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { EventBus } from '../events.ts'
import type { ToolDefinition } from '../tools.ts'
import { LocalToolSettings, absolute, openDirectory, serialized, atomicPrivateJson } from './settings.ts'
const MAX=1024*1024
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex')
const within=(root:string,path:string)=>path===root||path.startsWith(root==='/'?'/':root+'/')
const forbidden=(path:string)=>path.split('/').some(p=>/^(?:\.git|node_modules|\.ssh|\.gnupg|\.aws|\.azure|\.config|\.kube|\.jarvis-.*|\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx)|.*(?:credentials|secrets?|tokens?|model[-_]config).*)$/i.test(p))||['/proc','/sys','/dev'].some(r=>within(r,path))
function text(bytes:Buffer):string {if(bytes.includes(0))throw new Error('Binary data is not supported');try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{throw new Error('File is not valid UTF-8')}}
interface Handle {path:string;parent:number;target:string;close:()=>void;check:()=>void}
interface Artifact {artifactId:string;sessionId:string;path:string;name:string;size:number;sha256:string;mime:string;managed?:boolean}
interface Backup {id:string;path:string;content:string;version:string;sessionId:string}
/** Linux-only, no subprocesses or network. One catalog owner per process is required.
 * Pinned O_NOFOLLOW descriptors defeat symlink substitution. Node has no atomic
 * compare-and-rename primitive: hostile external writers or directory relocation
 * after the final ancestry check remain outside the guarantee. Internal writes
 * are serialized. Backups and catalog are private but not encrypted at rest.
 */
export class FileTools {
  private catalog:Artifact[]=[]
  private catalogLoaded=false
  constructor(private readonly deps:{settings:LocalToolSettings;bus?:EventBus;storageFile?:string;localVision?:(bytes:Buffer,prompt:string,signal:AbortSignal)=>Promise<string>}){}
  private authorize(input:string,write=false):Handle {
    const path=absolute(input),settings=this.deps.settings.snapshot()
    const privateDirs=[dirname(this.deps.settings.file),dirname(this.storagePath())]
    if(forbidden(path)||path===this.deps.settings.file||path===this.storagePath()||within(this.privatePath('history'),path)||(!within(settings.outputDir,path)&&privateDirs.some(root=>within(root,path))))throw new Error('Protected path is forbidden')
    const roots=[...(write?settings.writeRoots:[...settings.readRoots,...settings.writeRoots]),settings.outputDir]
    if(!roots.some(root=>within(root,path)))throw new Error('Path is outside permitted roots')
    const parent=openDirectory(dirname(path)),target=`/proc/self/fd/${parent}/${basename(path)}`
    const check=()=>{if(realpathSync(`/proc/self/fd/${parent}`)!==dirname(path))throw new Error('Parent directory moved during operation');const verify=openDirectory(dirname(path));try{const a=fstatSync(verify),b=fstatSync(parent);if(a.ino!==b.ino||a.dev!==b.dev)throw new Error('Parent directory changed')}finally{closeSync(verify)}}
    try {check();return {path,parent,target,close:()=>closeSync(parent),check}}catch(e){closeSync(parent);throw e}
  }
  private bytes(handle:Handle,max=MAX):Buffer {
    handle.check();const fd=openSync(handle.target,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK)
    try {const stat=fstatSync(fd);if(!stat.isFile()||stat.nlink!==1)throw new Error('Only regular files without hard links are supported');if(stat.size>max)throw new Error('File exceeds byte limit');const out=Buffer.alloc(max+1);let total=0;while(total<out.length){const n=readSync(fd,out,total,out.length-total,null);if(!n)break;total+=n}if(total>max)throw new Error('File exceeds byte limit');const result=out.subarray(0,total);if(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/.test(result.toString('utf8')))throw new Error('Private key material is forbidden');return result}finally{closeSync(fd)}
  }
  private read(path:string,max=MAX):Buffer {const h=this.authorize(path);try{return this.bytes(h,max)}finally{h.close()}}
  private storagePath():string {return absolute(this.deps.storageFile??join(dirname(this.deps.settings.file),'local-files.json'))}
  private privatePath(_name:string):string {return join(dirname(this.storagePath()),'file-history')}
  async readArtifact(id:string,sessionId:string):Promise<{name:string;mime:string;bytes:Buffer}>{const item=await this.artifact(id,sessionId);return {name:item.name,mime:item.mime,bytes:item.buffer}}
  private clear(sessionId?:string):void {
    this.loadCatalog()
    for(const item of this.catalog.filter(a=>(sessionId===undefined||a.sessionId===sessionId)&&a.managed)) {
      // Only app-created output artifacts are owned; imported sources are never removed.
      if(dirname(absolute(item.path))!==this.deps.settings.snapshot().outputDir)continue
      const h=this.authorize(item.path,true)
      try {const bytes=this.bytes(h,8*MAX);if(hash(bytes)!==item.sha256)continue;h.check();unlinkSync(h.target)}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}finally{h.close()}
    }
    let history:number|undefined
    try {history=openDirectory(this.privatePath('history'));const base=`/proc/self/fd/${history}`
      for(const name of readdirSync(base)) {if(!/^[a-f0-9-]{36}\.json$/.test(name))continue;const target=join(base,name);const fd=openSync(target,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);let owned=sessionId===undefined
        try {const stat=fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.size>2*MAX)throw new Error('Invalid private history entry');if(!owned){const b=Buffer.alloc(2*MAX+1),n=readSync(fd,b,0,b.length,0);owned=(JSON.parse(b.subarray(0,n).toString()) as Backup).sessionId===sessionId}}finally{closeSync(fd)}
        if(owned)unlinkSync(target)
      }
      fsyncSync(history)
    }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}finally{if(history!==undefined)closeSync(history)}
    this.catalog=sessionId===undefined?[]:this.catalog.filter(a=>a.sessionId!==sessionId);atomicPrivateJson(this.storagePath(),this.catalog)
  }
  clearSession(sessionId:string):void {this.clear(sessionId)}
  clearAll():void {
    const output=absolute(this.deps.settings.snapshot().outputDir)
    if(output.split('/').filter(Boolean).length<3||[dirname(this.deps.settings.file),dirname(this.storagePath())].some(p=>within(output,p)))throw new Error('Unsafe generated workspace for erase')
    const erase=(fd:number)=>{const base=`/proc/self/fd/${fd}`;for(const name of readdirSync(base)){const target=join(base,name),st=lstatSync(target);if(st.isDirectory()){const child=openSync(target,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);try{erase(child)}finally{closeSync(child)}rmdirSync(target)}else unlinkSync(target)}fsyncSync(fd)}
    let fd:number|undefined;try{fd=openDirectory(output);if(realpathSync(`/proc/self/fd/${fd}`)!==output)throw new Error('Workspace changed during erase');erase(fd)}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}finally{if(fd!==undefined)closeSync(fd)}
    this.clear()
  }
  close():void {}
  private loadCatalog(){if(this.catalogLoaded)return;const file=this.storagePath();let fd:number|undefined,parent:number|undefined;try{parent=openDirectory(dirname(file));fd=openSync(`/proc/self/fd/${parent}/${basename(file)}`,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);if(!fstatSync(fd).isFile()||fstatSync(fd).size>4*MAX)throw new Error('Invalid artifact catalog');const bytes=Buffer.alloc(4*MAX+1);const n=readSync(fd,bytes,0,bytes.length,0);this.catalog=JSON.parse(bytes.subarray(0,n).toString()) as Artifact[];if(!Array.isArray(this.catalog))throw new Error('Invalid artifact catalog')}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}finally{if(fd!==undefined)closeSync(fd);if(parent!==undefined)closeSync(parent)}this.catalogLoaded=true}
  artifacts(sessionId:string):Artifact[]{this.loadCatalog();return structuredClone(this.catalog.filter(a=>a.sessionId===sessionId))}
  async artifact(id:string,sessionId:string):Promise<Artifact & {buffer:Buffer}>{this.loadCatalog();const item=this.catalog.find(a=>a.artifactId===id&&a.sessionId===sessionId);if(!item)throw new Error('Artifact not found');const buffer=this.read(item.path,8*MAX);if(hash(buffer)!==item.sha256)throw new Error('Artifact version changed');return {...item,buffer}}
  private present(path:string,sessionId:string,managed=false):Artifact {this.loadCatalog();const bytes=this.read(path,8*MAX);const item:Artifact={artifactId:randomUUID(),sessionId,managed,path:absolute(path),name:basename(path),size:bytes.length,sha256:hash(bytes),mime:({'.txt':'text/plain','.md':'text/markdown','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'} as Record<string,string>)[extname(path).toLowerCase()]??'application/octet-stream'};this.catalog.push(item);try{atomicPrivateJson(this.storagePath(),this.catalog)}catch(e){this.catalog.pop();throw e}this.deps.bus?.emit('artifact.created',{...item});return item}
  private save(path:string,content:string,expected:unknown,signal:AbortSignal,sessionId:string):{path:string;version:string;backupId?:string} {
    if(typeof content!=='string'||Buffer.byteLength(content)>MAX)throw new Error('Content exceeds 1 MiB limit')
    const h=this.authorize(path,true);let temp:string|undefined
    try {
      signal.throwIfAborted();let old:Buffer|undefined
      try{old=this.bytes(h)}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}
      if(old ? typeof expected!=='string'||hash(old)!==expected : expected!==undefined&&expected!==null)throw new Error('File version conflict; expectedVersion is required for existing files')
      let backupId:string|undefined
      if(old){backupId=randomUUID();const backup:Backup={id:backupId,sessionId,path:h.path,content:old.toString('base64'),version:hash(old)};atomicPrivateJson(join(this.privatePath('.jarvis-history'),backupId+'.json'),backup)}
      temp=`/proc/self/fd/${h.parent}/.jarvis-${randomUUID()}.tmp`
      const fd=openSync(temp,C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o600)
      try{writeFileSync(fd,content);fsyncSync(fd)}finally{closeSync(fd)}
      signal.throwIfAborted();h.check()
      if(old){if(hash(this.bytes(h))!==expected)throw new Error('File version conflict');renameSync(temp,h.target)}
      else { // link is an atomic no-clobber publish; unlike rename it cannot replace a newly created file.
        linkSync(temp,h.target);unlinkSync(temp)
      }
      temp=undefined;fsyncSync(h.parent);this.loadCatalog();let changed=false;for(const item of this.catalog){if(item.managed&&item.path===h.path){item.sha256=hash(content);item.size=Buffer.byteLength(content);changed=true}}if(changed)atomicPrivateJson(this.storagePath(),this.catalog);return {path:h.path,version:hash(content),...(backupId?{backupId}:{})}
    }finally{if(temp)try{unlinkSync(temp)}catch{}h.close()}
  }
  private restore(id:string,path:string,expected:unknown,signal:AbortSignal,sessionId:string){if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('Invalid backup ID');const parent=openDirectory(this.privatePath('.jarvis-history'));let fd:number|undefined;try{fd=openSync(`/proc/self/fd/${parent}/${id}.json`,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);if(!fstatSync(fd).isFile()||fstatSync(fd).size>2*MAX)throw new Error('Invalid backup');const b=Buffer.alloc(2*MAX+1),n=readSync(fd,b,0,b.length,0);const record=JSON.parse(b.subarray(0,n).toString()) as Backup;if(record.path!==absolute(path)||record.id!==id)throw new Error('Backup target mismatch');const bytes=Buffer.from(record.content,'base64');if(hash(bytes)!==record.version)throw new Error('Backup corrupted');return this.save(path,text(bytes),expected,signal,sessionId)}finally{if(fd!==undefined)closeSync(fd);closeSync(parent)}}
  private scan(path:string,args:Record<string,unknown>,signal:AbortSignal,search:boolean){
    const start=Date.now(),results:unknown[]=[];let files=0,bytes=0,truncated=false
    const query=typeof args.query==='string'?args.query:'';if(search&&!query)throw new Error('A non-empty literal query is required')
    const visit=(dir:string,depth:number)=>{signal.throwIfAborted();if(Date.now()-start>=10000||files>=2000||bytes>=8*MAX){truncated=true;return}
      const h=this.authorize(dir);let fd:number|undefined
      try{fd=openSync(h.target,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);const directory=opendirSync(`/proc/self/fd/${fd}`);try{let entry;while((entry=directory.readSync())!==null){
        signal.throwIfAborted();if(Date.now()-start>=10000||files>=2000||bytes>=8*MAX){truncated=true;break}
        const child=join(dir,entry.name);if((!args.includeHidden&&entry.name.startsWith('.'))||forbidden(child)||entry.isSymbolicLink()||(!entry.isDirectory()&&!entry.isFile()))continue
        files++;try{const auth=this.authorize(child);auth.close()}catch{continue}
        if(entry.isDirectory()){if(!search)results.push({path:child,type:'directory'});if((search||args.recursive)&&depth<8)visit(child,depth+1);else if(search||args.recursive)truncated=true}
        else if(!search)results.push({path:child,type:'file'})
        else if(args.mode!=='contents'){if(entry.name.includes(query))results.push({path:child})}
        else {try {const data=this.read(child,Math.min(MAX,8*MAX-bytes));bytes+=data.length;const lines=text(data).split('\n');for(let i=0;i<lines.length;i++)if(lines[i]!.includes(query)){results.push({path:child,line:i+1,text:lines[i]!.slice(0,500)});if(results.length>=2000){truncated=true;return}}}catch{}}
        if(results.length>=2000){truncated=true;break}
      }}finally{directory.closeSync()}}finally{if(fd!==undefined)closeSync(fd);h.close()}}
    visit(absolute(path),0);return {results,truncated,filesScanned:files,bytesScanned:bytes}
  }
  definitions():ToolDefinition[]{
    const str={type:'string'},integer={type:'integer',minimum:1},path={path:str},version={expectedVersion:str}
    const def=(name:string,description:string,properties:Record<string,unknown>,required:string[],write:boolean,run:(a:Record<string,unknown>,c:Parameters<ToolDefinition['execute']>[1])=>unknown|Promise<unknown>):ToolDefinition=>{
      const parameters={type:'object',properties,required,additionalProperties:false};return {name,description,parameters,definitionHash:hash(JSON.stringify({name,parameters,revision:this.deps.settings.snapshot().revision})),usage:'local',permission:write?'ask':'allow',effect:write?'write':'read',destination:'local',execute:async(a,c)=>{c.signal.throwIfAborted();const action=async()=>({content:JSON.stringify(await run(a,c))});return write?serialized(this.deps.settings.file+':files',action):action()}}
    }
    const definitions=[
      def('file_list','List permitted files; symlinks and secret paths are excluded.',{...path,recursive:{type:'boolean'},includeHidden:{type:'boolean'}},['path'],false,(a,c)=>this.scan(String(a.path),a,c.signal,false)),
      def('file_search','Search literal names or UTF-8 contents. Bounded to depth 8, 2000 files, 8 MiB and 10 seconds.',{...path,query:str,mode:{type:'string',enum:['name','contents']},includeHidden:{type:'boolean'}},['path','query'],false,(a,c)=>this.scan(String(a.path),a,c.signal,true)),
      def('file_read','Read UTF-8 text up to 1 MiB. offset and limit are 1-based line offset and line count; returns SHA256 version.',{...path,offset:integer,limit:{...integer,maximum:10000}},['path'],false,a=>{const bytes=this.read(String(a.path)),lines=text(bytes).split('\n');const offset=Number(a.offset??1),limit=Number(a.limit??200);if(!Number.isSafeInteger(offset)||offset<1||!Number.isSafeInteger(limit)||limit<1||limit>10000)throw new Error('Invalid line range');return {path:absolute(String(a.path)),version:hash(bytes),size:bytes.length,totalLines:lines.length,offset,endLine:Math.min(lines.length,offset+limit-1),content:lines.slice(offset-1,offset-1+limit).join('\n')}}),
      def('file_write','Create a text file exclusively or replace an existing version. Replacements create private recovery backups.',{...path,content:str,...version},['path','content'],true,(a,c)=>this.save(String(a.path),a.content as string,a.expectedVersion,c.signal,c.sessionId)),
      def('file_edit','Replace one unique literal occurrence in an expected file version.',{...path,oldString:str,newString:str,...version},['path','oldString','newString','expectedVersion'],true,(a,c)=>{const h=this.authorize(String(a.path),true);let bytes:Buffer;try{bytes=this.bytes(h)}finally{h.close()}if(hash(bytes)!==a.expectedVersion)throw new Error('File version conflict');const content=text(bytes),old=a.oldString as string;if(!old||content.indexOf(old)<0||content.indexOf(old,content.indexOf(old)+1)>=0)throw new Error('oldString must match exactly once');return this.save(String(a.path),content.replace(old,()=>a.newString as string),a.expectedVersion,c.signal,c.sessionId)}),
      def('file_restore','Restore a private backup to its original permitted path with version checking.',{...path,backupId:str,...version},['path','backupId','expectedVersion'],true,(a,c)=>this.restore(String(a.backupId),String(a.path),a.expectedVersion,c.signal,c.sessionId)),
      def('artifact_create','Create a UTF-8 artifact in the configured output directory and register it for this session.',{name:str,content:str},['name','content'],true,(a,c)=>{const name=String(a.name);if(name!==basename(name)||!name||name==='.'||name==='..'||name.startsWith('.'))throw new Error('Artifact name must be a safe basename');const path=join(this.deps.settings.snapshot().outputDir,name);this.save(path,a.content as string,undefined,c.signal,c.sessionId);return this.present(path,c.sessionId,true)}),
      def('artifact_present','Register a permitted regular file as an artifact for this session. Does not interpret images.',path,['path'],false,(a,c)=>this.present(String(a.path),c.sessionId)),
    ]
    if(this.deps.localVision)definitions.push(def('image_inspect','Interpret a permitted local image with the configured local vision model.',{...path,prompt:str},['path','prompt'],false,async(a,c)=>{const bytes=this.read(String(a.path),8*MAX);if(!(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes[0]===255&&bytes[1]===216||bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'))throw new Error('Only PNG, JPEG and WebP images are supported');return {path:absolute(String(a.path)),interpretation:await this.deps.localVision!(bytes,String(a.prompt),c.signal)}}))
    return definitions
  }
}
