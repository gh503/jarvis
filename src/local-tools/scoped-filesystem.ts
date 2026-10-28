import { constants as C, openSync, closeSync, mkdirSync, realpathSync } from 'node:fs'
import { resolve, isAbsolute, sep } from 'node:path'

export function scopedFilesystemCapability() {
  const supported=process.platform==='linux'
  return {supported,platform:process.platform,reason:supported?null:`Scoped file and skill access is unavailable on ${process.platform}: a native descriptor-relative filesystem backend is required. Settings and other application features remain available.`}
}
export function requireScopedFilesystem():void {
  const capability=scopedFilesystemCapability()
  if(!capability.supported)throw Object.assign(new Error(capability.reason!),{code:'SCOPED_FILESYSTEM_UNAVAILABLE'})
}
export function absolute(path:string):string {
  if(typeof path!=='string'||!isAbsolute(path)||path.includes('\0'))throw new Error('An absolute path is required')
  if(path.split(sep==='\\'?/[\\/]/:/\//).includes('..'))throw new Error('Parent traversal is forbidden')
  return resolve(path)
}
/** Linux directory descriptors pin every component; procfd is used only internally. */
export function openDirectory(path:string,create=false):number {
  requireScopedFilesystem()
  let fd=openSync('/',C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW)
  try {
    for(const part of absolute(path).split('/').filter(Boolean)) {
      const child=`/proc/self/fd/${fd}/${part}`
      if(create){try{mkdirSync(child,{mode:0o700})}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e}}
      const next=openSync(child,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);closeSync(fd);fd=next
    }
    return fd
  }catch(e){closeSync(fd);throw e}
}
export function normalizeDirectory(path:string,create=false):string {
  const normalized=absolute(path)
  if(['/proc','/sys','/dev'].some(root=>normalized===root||normalized.startsWith(root+'/')))throw new Error('Special filesystem roots are forbidden')
  const fd=openDirectory(normalized,create)
  try{if(realpathSync(`/proc/self/fd/${fd}`)!==normalized)throw new Error('Directory changed during authorization');return normalized}finally{closeSync(fd)}
}
