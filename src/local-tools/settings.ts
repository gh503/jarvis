import { absolute, normalizeDirectory } from './scoped-filesystem.ts'
import { atomicPrivateJson, readPrivateJson, preparePrivateDirectory, withPrivateFileLock } from './private-storage.ts'
export { absolute, openDirectory, normalizeDirectory, scopedFilesystemCapability } from './scoped-filesystem.ts'
export { atomicPrivateJson } from './private-storage.ts'
export interface LocalSettingsSnapshot { revision:number; readRoots:string[]; writeRoots:string[]; outputDir:string; webEnabled:boolean; shellEnabled:boolean; skillsDir:string|null }
export type LocalSettingsUpdate = Partial<Omit<LocalSettingsSnapshot,'revision'>> & {expectedRevision:number}
const queues = new Map<string,Promise<unknown>>()
export function serialized<T>(key:string,fn:()=>T|Promise<T>):Promise<T> {
  const next=(queues.get(key)??Promise.resolve()).catch(()=>{}).then(fn)
  queues.set(key,next); void next.finally(()=>{if(queues.get(key)===next)queues.delete(key)}).catch(()=>{}); return next
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
    const value=readPrivateJson(this.file,65536)
    return value===undefined?undefined:this.validate(value as LocalSettingsSnapshot,undefined,true)
  }
  async load():Promise<void>{await serialized(this.file,()=>withPrivateFileLock(this.file,()=>{
    const existing=this.readDisk()
    if(existing){this.value=existing;return}
    const outputDir=preparePrivateDirectory(this.defaultOutputDir)
    const value={revision:0,readRoots:[],writeRoots:[],outputDir,webEnabled:false,shellEnabled:false,skillsDir:null}
    atomicPrivateJson(this.file,value,65536);this.value=value
  }))}
  snapshot():LocalSettingsSnapshot {if(!this.value)throw new Error('LocalToolSettings.load() is required');return structuredClone(this.value)}
  async reset():Promise<LocalSettingsSnapshot>{return this.update({expectedRevision:this.snapshot().revision,readRoots:[],writeRoots:[],webEnabled:false,shellEnabled:false,skillsDir:null})}
  async update(input:LocalSettingsUpdate):Promise<LocalSettingsSnapshot>{return serialized(this.file,()=>withPrivateFileLock(this.file,()=>{
    const current=this.readDisk();if(!current)throw new Error('Settings missing; load first')
    if(input.expectedRevision!==current.revision)throw Object.assign(new Error('Settings revision conflict'),{code:'REVISION_CONFLICT',statusCode:409})
    if(Object.hasOwn(input,'outputDir'))throw new Error('outputDir is immutable; it cannot be changed through settings updates')
    const allowed=['expectedRevision','readRoots','writeRoots','webEnabled','shellEnabled','skillsDir'];if(Object.keys(input).some(k=>!allowed.includes(k)))throw new Error('Unknown settings field')
    const {expectedRevision,...patch}=input
    const next=this.validate({...current,...patch,revision:current.revision+1},current);atomicPrivateJson(this.file,next,65536);this.value=next;return this.snapshot()
  }))}
}
