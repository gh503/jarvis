import { constants as C, openSync, closeSync, fstatSync, fchmodSync, mkdirSync, realpathSync, readFileSync, writeFileSync, fsyncSync, renameSync, unlinkSync } from 'node:fs'
import { resolve, isAbsolute, dirname, basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface LocalSettingsSnapshot { revision:number; readRoots:string[]; writeRoots:string[]; outputDir:string; webEnabled:boolean; shellEnabled:boolean; skillsDir:string|null }
export type LocalSettingsUpdate = Partial<Omit<LocalSettingsSnapshot,'revision'>> & {expectedRevision:number}
const queues = new Map<string,Promise<unknown>>()
export function serialized<T>(key:string,fn:()=>T|Promise<T>):Promise<T> {
  const next=(queues.get(key)??Promise.resolve()).catch(()=>{}).then(fn)
  queues.set(key,next); void next.finally(()=>{if(queues.get(key)===next)queues.delete(key)}).catch(()=>{}); return next
}
export function absolute(path:string):string {
  if(typeof path!=='string'||!isAbsolute(path)||path.includes('\0'))throw new Error('An absolute path is required')
  if(path.split('/').includes('..'))throw new Error('Parent traversal is forbidden')
  return resolve(path)
}
/** Linux directory descriptors pin every component; procfd is used only internally. */
export function openDirectory(path:string,create=false):number {
  if(process.platform!=='linux')throw new Error('Scoped filesystem tools require Linux')
  let fd=openSync('/',C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW)
  try {
    for(const part of absolute(path).split('/').filter(Boolean)) {
      const child=`/proc/self/fd/${fd}/${part}`
      if(create) {try{mkdirSync(child,{mode:0o700})}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e}}
      const next=openSync(child,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW); closeSync(fd); fd=next
    }
    return fd
  }catch(e){closeSync(fd);throw e}
}
export function normalizeDirectory(path:string,create=false):string {
  const normalized=absolute(path)
  if(['/proc','/sys','/dev'].some(root=>normalized===root||normalized.startsWith(root+'/')))throw new Error('Special filesystem roots are forbidden')
  const fd=openDirectory(normalized,create)
  try {if(realpathSync(`/proc/self/fd/${fd}`)!==normalized)throw new Error('Directory changed during authorization');return normalized}finally{closeSync(fd)}
}
export function atomicPrivateJson(file:string,value:unknown):void {
  const fd=openDirectory(dirname(absolute(file)),true),base=`/proc/self/fd/${fd}`,tmp=join(base,`.jarvis-${randomUUID()}.tmp`)
  let out:number|undefined
  try {out=openSync(tmp,C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o600);writeFileSync(out,JSON.stringify(value));fsyncSync(out);closeSync(out);out=undefined;renameSync(tmp,join(base,basename(file)));fsyncSync(fd)}
  finally {if(out!==undefined)closeSync(out);try{unlinkSync(tmp)}catch{}closeSync(fd)}
}
export class LocalToolSettings {
  private value:LocalSettingsSnapshot|undefined
  readonly file:string
  constructor(file:string,private readonly defaultOutputDir:string){this.file=absolute(file)}
  private validate(value:LocalSettingsSnapshot,previous?:LocalSettingsSnapshot,persisted=false):LocalSettingsSnapshot {
    if(!Number.isSafeInteger(value.revision)||value.revision<0||typeof value.webEnabled!=='boolean'||typeof value.shellEnabled!=='boolean')throw new Error('Invalid local tool settings')
    const directory=(path:string,retained=false)=>{const normalized=absolute(path);if(['/proc','/sys','/dev'].some(root=>normalized===root||normalized.startsWith(root+'/')))throw new Error('Special filesystem roots are forbidden');return persisted||retained?normalized:normalizeDirectory(normalized)}
    const roots=(v:unknown,old:string[]=[])=>{if(!Array.isArray(v)||v.some(x=>typeof x!=='string'))throw new Error('Invalid roots');return [...new Set(v.map(x=>directory(x,old.includes(absolute(x)))))]}
    if(value.skillsDir!==null&&typeof value.skillsDir!=='string')throw new Error('Invalid skillsDir')
    return {revision:value.revision,readRoots:roots(value.readRoots,previous?.readRoots),writeRoots:roots(value.writeRoots,previous?.writeRoots),outputDir:directory(value.outputDir,previous?.outputDir===value.outputDir),webEnabled:value.webEnabled,shellEnabled:value.shellEnabled,skillsDir:value.skillsDir===null?null:directory(value.skillsDir,previous?.skillsDir===value.skillsDir)}
  }
  private readDisk():LocalSettingsSnapshot|undefined {
    let parent:number|undefined,fd:number|undefined
    try {parent=openDirectory(dirname(this.file));fd=openSync(`/proc/self/fd/${parent}/${basename(this.file)}`,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);const stat=fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.size>65536)throw new Error('Invalid settings file');fchmodSync(fd,0o600);return this.validate(JSON.parse(readFileSync(fd,'utf8')) as LocalSettingsSnapshot,undefined,true)}
    catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e}
    finally {if(fd!==undefined)closeSync(fd);if(parent!==undefined)closeSync(parent)}
  }
  async load():Promise<void>{await serialized(this.file,()=>{
    const existing=this.readDisk()
    if(existing){this.value=existing;return}
    const outputDir=normalizeDirectory(this.defaultOutputDir,true)
    const value={revision:0,readRoots:[],writeRoots:[],outputDir,webEnabled:false,shellEnabled:false,skillsDir:null}
    atomicPrivateJson(this.file,value);this.value=value
  })}
  snapshot():LocalSettingsSnapshot {if(!this.value)throw new Error('LocalToolSettings.load() is required');return structuredClone(this.value)}
  async reset():Promise<LocalSettingsSnapshot>{return this.update({expectedRevision:this.snapshot().revision,readRoots:[],writeRoots:[],webEnabled:false,shellEnabled:false,skillsDir:null})}
  async update(input:LocalSettingsUpdate):Promise<LocalSettingsSnapshot>{return serialized(this.file,()=>{
    const current=this.readDisk();if(!current)throw new Error('Settings missing; load first')
    if(input.expectedRevision!==current.revision)throw Object.assign(new Error('Settings revision conflict'),{code:'REVISION_CONFLICT',statusCode:409})
    if(Object.hasOwn(input,'outputDir'))throw new Error('outputDir is immutable; it cannot be changed through settings updates')
    const allowed=['expectedRevision','readRoots','writeRoots','webEnabled','shellEnabled','skillsDir'];if(Object.keys(input).some(k=>!allowed.includes(k)))throw new Error('Unknown settings field')
    const {expectedRevision,...patch}=input
    const next=this.validate({...current,...patch,revision:current.revision+1},current);atomicPrivateJson(this.file,next);this.value=next;return this.snapshot()
  })}
}
