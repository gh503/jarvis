import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { LocalToolSettings } from '../src/local-tools/settings.ts'
import { FileTools } from '../src/local-tools/files.ts'
import { skillTools, skillCapability } from '../src/local-tools/skills.ts'
import { atomicPrivateJson, readPrivateJson, withPrivateFileLock } from '../src/local-tools/private-storage.ts'

const settingsURL=new URL('../src/local-tools/settings.ts',import.meta.url).href
const storageURL=new URL('../src/local-tools/private-storage.ts',import.meta.url).href
function child(code:string){return spawn(process.execPath,['--experimental-transform-types','--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']})}
async function result(code:string){const proc=child(code);let stdout='',stderr='';proc.stdout.on('data',b=>stdout+=b);proc.stderr.on('data',b=>stderr+=b);const [exit]=await once(proc,'exit');assert.equal(exit,0,stderr);return stdout.trim()}
const fixture=()=>{const dir=mkdtempSync(join(tmpdir(),'jarvis-private-'));return {dir,file:join(dir,'data','settings.json'),out:join(dir,'output')}}

test('portable private settings initialize, reload, update and reset; scoped tools fail closed',async()=>{
  // Branch simulation exercises the portable implementation; native OS CI is still required.
  for(const platform of ['darwin','win32']){
    const f=fixture(),descriptor=Object.getOwnPropertyDescriptor(process,'platform')!
    Object.defineProperty(process,'platform',{value:platform,configurable:true})
    try{
      const settings=new LocalToolSettings(f.file,f.out);await settings.load()
      await settings.update({expectedRevision:0,webEnabled:true})
      const reopened=new LocalToolSettings(f.file,f.out);await reopened.load();assert.equal(reopened.snapshot().webEnabled,true)
      const files=new FileTools({settings:reopened});assert.equal(files.capabilities().supported,false);assert.match(files.capabilities().reason!,/native descriptor-relative/)
      assert.deepEqual(files.definitions(),[]);assert.deepEqual(files.artifacts('session'),[])
      const skills=skillTools({settings:{snapshot:()=>({revision:0,skillsDir:f.out})}})
      assert.deepEqual(skills.map(tool=>tool.name),skillCapability().supported?['skill_list','skill_load']:[])
      await assert.rejects(reopened.update({expectedRevision:1,readRoots:[f.out]}),{code:'SCOPED_FILESYSTEM_UNAVAILABLE'})
      assert.doesNotThrow(()=>files.clearSession('session'));assert.doesNotThrow(()=>files.clearAll())
      await reopened.reset();assert.equal(reopened.snapshot().revision,2)
    }finally{Object.defineProperty(process,'platform',descriptor)}
  }
})

test('cross-process settings CAS admits exactly one writer for a revision',async()=>{
  const f=fixture(),settings=new LocalToolSettings(f.file,f.out);await settings.load()
  const code=`import {LocalToolSettings} from ${JSON.stringify(settingsURL)};const s=new LocalToolSettings(${JSON.stringify(f.file)},${JSON.stringify(f.out)});await s.load();try{await s.update({expectedRevision:0,webEnabled:true});console.log('won')}catch(e){if(e.code!=='REVISION_CONFLICT')throw e;console.log('conflict')}`
  const results=await Promise.all(Array.from({length:6},()=>result(code)))
  assert.equal(results.filter(x=>x==='won').length,1);assert.equal(results.filter(x=>x==='conflict').length,5)
  await settings.load();assert.equal(settings.snapshot().revision,1)
})

test('concurrent first loads cannot overwrite an initialized revision',async()=>{
  const f=fixture()
  const code=`import {LocalToolSettings} from ${JSON.stringify(settingsURL)};const s=new LocalToolSettings(${JSON.stringify(f.file)},${JSON.stringify(f.out)});await s.load();try{await s.update({expectedRevision:0,webEnabled:true})}catch(e){if(e.code!=='REVISION_CONFLICT')throw e};console.log('done')`
  await Promise.all(Array.from({length:4},()=>result(code)))
  const settings=new LocalToolSettings(f.file,f.out);await settings.load();assert.equal(settings.snapshot().revision,1);assert.equal(settings.snapshot().webEnabled,true)
})

test('SQLite lock releases after process death without deleting its sidecar',async()=>{
  const f=fixture()
  const proc=child(`import {withPrivateFileLock} from ${JSON.stringify(storageURL)};await withPrivateFileLock(${JSON.stringify(f.file)},async()=>{console.log('locked');setInterval(()=>{},1000);await new Promise(()=>{});});`)
  try{
    const [chunk]=await once(proc.stdout,'data');assert.match(String(chunk),/locked/)
    const exited=once(proc,'exit');proc.kill('SIGKILL');const [code,signal]=await exited;assert.equal(code,null);assert.equal(signal,'SIGKILL')
    assert.equal(await withPrivateFileLock(f.file,()=>42),42)
  }finally{if(proc.exitCode===null&&proc.signalCode===null)proc.kill('SIGKILL')}
})

test('lock contention yields the event loop for asynchronous holders',async()=>{
  const f=fixture();let release!:()=>void,entered!:()=>void
  const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r)
  const first=withPrivateFileLock(f.file,async()=>{entered();await gate;return 1});await ready
  const second=withPrivateFileLock(f.file,()=>2)
  setTimeout(release,75)
  assert.deepEqual(await Promise.all([first,second]),[1,2])
})

test('private JSON is bounded and failed publication preserves the previous document',()=>{
  const f=fixture();atomicPrivateJson(f.file,{value:'original'},64)
  assert.throws(()=>atomicPrivateJson(f.file,{value:'x'.repeat(100)},64),/byte limit/)
  assert.deepEqual(readPrivateJson(f.file,64),{value:'original'})
  assert.equal(readdirSync(join(f.dir,'data')).some(n=>n.endsWith('.tmp')),false)
  writeFileSync(f.file,'x'.repeat(100));assert.throws(()=>readPrivateJson(f.file,64),/bounded/)
})

test('Linux private storage retains symlink rejection', {skip:process.platform!=='linux'},async()=>{
  const f=fixture(),other=join(f.dir,'other.json');writeFileSync(other,'{"value":"unchanged"}')
  atomicPrivateJson(f.file,{value:'initial'});const alias=join(f.dir,'data','alias.json');symlinkSync(other,alias)
  assert.throws(()=>readPrivateJson(alias),/symlink/)
  const parentAlias=join(f.dir,'alias');symlinkSync(join(f.dir,'data'),parentAlias)
  assert.throws(()=>atomicPrivateJson(join(parentAlias,'other.json'),{}))
  assert.equal(readFileSync(other,'utf8'),'{"value":"unchanged"}')
})
