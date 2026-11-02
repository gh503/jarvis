import { lstatSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { absolute, normalizeDirectory } from './scoped-filesystem.ts'
import { NativeFilesystem } from './native-filesystem.ts'
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
// Compare the helper's pinned handle with exact metadata on both sides of init.
// Checking every component also rejects symlink ancestors, including junctions.
function nativeRootIdentity(root:string):string {
  for(let component=root;;component=dirname(component)){
    const stat=lstatSync(component,{bigint:true})
    if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error('Native root must be a directory without symlink components')
    if(dirname(component)===component)break
  }
  if(realpathSync(root)!==root)throw new Error('Native root must be its canonical directory')
  const stat=lstatSync(root,{bigint:true})
  if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error('Native root changed during authorization')
  return `${stat.dev}:${stat.ino}`
}
async function verifyNativeRoots(roots:string[]):Promise<void> {
  if(roots.length===0)return
  const before=roots.map(nativeRootIdentity)
  const opened=await NativeFilesystem.start(roots)
  try{
    for(let i=0;i<roots.length;i++){
      const identity=opened.identities[i]
      if(!identity||`${identity.device}:${identity.inode}`!==before[i]||nativeRootIdentity(roots[i]!)!==before[i])throw new Error('Native root changed during authorization')
    }
  }finally{await opened.filesystem.disposeAsync()}
  if(roots.some((root,i)=>nativeRootIdentity(root)!==before[i]))throw new Error('Native root changed during authorization')
}
export class LocalToolSettings {
  private value:LocalSettingsSnapshot|undefined
  readonly file:string
  constructor(file:string,private readonly defaultOutputDir:string){this.file=absolute(file)}
  private validate(value:LocalSettingsSnapshot,previous?:LocalSettingsSnapshot,persisted=false,nativeSkillVerified=false,nativeReadVerified=false):LocalSettingsSnapshot {
    if(!Number.isSafeInteger(value.revision)||value.revision<0||typeof value.webEnabled!=='boolean'||typeof value.shellEnabled!=='boolean')throw new Error('Invalid local tool settings')
    const directory=(path:string,retained=false)=>{const normalized=absolute(path);if(['/proc','/sys','/dev'].some(root=>normalized===root||normalized.startsWith(root+'/')))throw new Error('Special filesystem roots are forbidden');return persisted||retained?normalized:normalizeDirectory(normalized)}
    const roots=(v:unknown,old:string[]=[])=>{if(!Array.isArray(v)||v.some(x=>typeof x!=='string'))throw new Error('Invalid roots');return [...new Set(v.map(x=>directory(x,old.includes(absolute(x)))))]}
    if(value.skillsDir!==null&&typeof value.skillsDir!=='string')throw new Error('Invalid skillsDir')
    return {revision:value.revision,readRoots:roots(value.readRoots,nativeReadVerified?value.readRoots:previous?.readRoots),writeRoots:roots(value.writeRoots,previous?.writeRoots),outputDir:directory(value.outputDir,previous?.outputDir===value.outputDir),webEnabled:value.webEnabled,shellEnabled:value.shellEnabled,skillsDir:value.skillsDir===null?null:directory(value.skillsDir,nativeSkillVerified||previous?.skillsDir===value.skillsDir)}
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
  async update(input:LocalSettingsUpdate):Promise<LocalSettingsSnapshot>{return serialized(this.file,()=>withPrivateFileLock(this.file,async()=>{
    const current=this.readDisk();if(!current)throw new Error('Settings missing; load first')
    if(input.expectedRevision!==current.revision)throw Object.assign(new Error('Settings revision conflict'),{code:'REVISION_CONFLICT',statusCode:409})
    if(Object.hasOwn(input,'outputDir'))throw new Error('outputDir is immutable; it cannot be changed through settings updates')
    const allowed=['expectedRevision','readRoots','writeRoots','webEnabled','shellEnabled','skillsDir'];if(Object.keys(input).some(k=>!allowed.includes(k)))throw new Error('Unknown settings field')
    const {expectedRevision,...patch}=input
    const native=process.platform==='win32'||process.platform==='darwin'
    // Validate every input before starting any process; persisted validation only
    // normalizes paths and deliberately does not probe retained directories.
    const candidate=this.validate({...current,...patch,revision:current.revision+1},undefined,true)
    if(native&&Object.hasOwn(patch,'writeRoots')&&candidate.writeRoots.length)throw Object.assign(new Error('Native writeRoots are unavailable'),{code:'SCOPED_FILESYSTEM_UNAVAILABLE'})
    const nativeRead=native&&Object.hasOwn(patch,'readRoots')
    const nativeSkill=native&&candidate.skillsDir!==null&&candidate.skillsDir!==current.skillsDir
    if(nativeRead&&candidate.readRoots.length>16)throw new Error('Native readRoots supports at most 16 roots')
    const next=this.validate(candidate,current,false,nativeSkill,nativeRead)
    if(nativeRead)await verifyNativeRoots(next.readRoots)
    if(nativeSkill)await verifyNativeRoots([next.skillsDir!])
    atomicPrivateJson(this.file,next,65536);this.value=next;return this.snapshot()
  }))}
}
