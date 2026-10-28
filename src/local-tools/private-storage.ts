import { constants as C, openSync, closeSync, fstatSync, fchmodSync, lstatSync, mkdirSync, readSync, writeFileSync, fsyncSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { absolute, openDirectory, normalizeDirectory } from './scoped-filesystem.ts'

/** Only for application-owned private data. The portable branch trusts the OS
 * account's private data directory/ACL; it is NOT an external filesystem sandbox.
 * Linux retains component-pinned, no-follow access. */
function privateParent(file:string,create=false){
  const directory=dirname(absolute(file))
  if(process.platform==='linux'){
    const fd=openDirectory(directory,create)
    return {base:`/proc/self/fd/${fd}`,sync:()=>fsyncSync(fd),close:()=>closeSync(fd)}
  }
  if(create)mkdirSync(directory,{recursive:true,mode:0o700})
  if(!lstatSync(directory).isDirectory())throw new Error('Private storage parent must be a directory')
  return {base:directory,sync:()=>{
    // Windows does not support opening/fsyncing directories through node:fs.
    if(process.platform==='win32')return
    const fd=openSync(directory,C.O_RDONLY);try{fsyncSync(fd)}finally{closeSync(fd)}
  },close:()=>{}}
}
export function preparePrivateDirectory(directory:string):string {
  if(process.platform==='linux')return normalizeDirectory(directory,true)
  const normalized=absolute(directory)
  mkdirSync(normalized,{recursive:true,mode:0o700})
  if(!lstatSync(normalized).isDirectory())throw new Error('Private storage must be a directory')
  return normalized
}
function checkFile(fd:number,maxBytes:number):void {
  const stat=fstatSync(fd)
  if(!stat.isFile()||stat.nlink!==1||stat.size>maxBytes)throw new Error('Invalid private JSON file (regular, unlinked and bounded file required)')
}
export function readPrivateJson(file:string,maxBytes=4*1024*1024):unknown|undefined {
  let parent:ReturnType<typeof privateParent>|undefined,fd:number|undefined
  try{
    parent=privateParent(file)
    const target=join(parent.base,basename(file))
    if(lstatSync(target).isSymbolicLink())throw new Error('Private JSON symlinks are forbidden')
    fd=openSync(target,C.O_RDONLY|(C.O_NOFOLLOW||0)|(C.O_NONBLOCK||0));checkFile(fd,maxBytes)
    if(process.platform!=='win32')fchmodSync(fd,0o600)
    const bytes=Buffer.alloc(maxBytes+1);let total=0
    while(total<bytes.length){const n=readSync(fd,bytes,total,bytes.length-total,null);if(!n)break;total+=n}
    if(total>maxBytes)throw new Error('Private JSON exceeds byte limit')
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,total)))
  }catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e}
  finally{if(fd!==undefined)closeSync(fd);parent?.close()}
}
export function atomicPrivateJson(file:string,value:unknown,maxBytes=4*1024*1024):void {
  const json=JSON.stringify(value)
  if(json===undefined||Buffer.byteLength(json)>maxBytes)throw new Error('Private JSON exceeds byte limit')
  const parent=privateParent(file,true),tmp=join(parent.base,`.jarvis-${randomUUID()}.tmp`)
  let out:number|undefined
  try{
    out=openSync(tmp,C.O_WRONLY|C.O_CREAT|C.O_EXCL|(C.O_NOFOLLOW||0),0o600)
    writeFileSync(out,json);fsyncSync(out);closeSync(out);out=undefined
    // Same-directory rename publishes a complete document; never unlink the old file first.
    renameSync(tmp,join(parent.base,basename(file)));parent.sync()
  }finally{if(out!==undefined)closeSync(out);try{unlinkSync(tmp)}catch{}parent.close()}
}
/** Cross-process crash-released lock. Keep callbacks short. No blocking SQLite
 * busy timeout: contention yields the event loop, including between async callbacks.
 * Never remove the sidecar: unlinking a live lock would split lock ownership. */
export async function withPrivateFileLock<T>(file:string,fn:()=>T|Promise<T>):Promise<T> {
  const parent=privateParent(file,true),target=join(parent.base,basename(file)+'.lock.sqlite')
  let db:DatabaseSync|undefined,locked=false
  try{
    try{if(lstatSync(target).isSymbolicLink())throw new Error('Private lock symlinks are forbidden')}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
    const fd=openSync(target,C.O_RDWR|C.O_CREAT|(C.O_NOFOLLOW||0),0o600)
    try{checkFile(fd,1024*1024);if(process.platform!=='win32')fchmodSync(fd,0o600)}finally{closeSync(fd)}
    if(lstatSync(target).isSymbolicLink())throw new Error('Private lock symlinks are forbidden')
    db=new DatabaseSync(target);db.exec('PRAGMA busy_timeout=0')
    const deadline=Date.now()+5000
    while(!locked){
      try{db.exec('BEGIN IMMEDIATE');locked=true}
      catch(error){
        const code=(error as {errcode?:number}).errcode
        if(code!==5&&code!==6)throw error
        if(Date.now()>=deadline)throw Object.assign(new Error('Private settings are busy; retry the operation'),{code:'SETTINGS_LOCK_TIMEOUT',statusCode:409})
        await delay(20+Math.floor(Math.random()*30))
      }
    }
    return await fn()
  }finally{try{if(locked)db!.exec('ROLLBACK')}finally{try{db?.close()}finally{parent.close()}}}
}
