import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalToolSettings, type LocalSettingsUpdate } from '../src/local-tools/settings.ts'
import { NativeFilesystem, nativeFilesystemExecutable } from '../src/local-tools/native-filesystem.ts'
import { atomicPrivateJson, withPrivateFileLock } from '../src/local-tools/private-storage.ts'

const originalStart=NativeFilesystem.start.bind(NativeFilesystem)
const host=process.platform
const executable=nativeFilesystemExecutable()
function fixture(t:TestContext,platform:NodeJS.Platform=host==='linux'?'darwin':host){
  const temp=realpathSync(mkdtempSync(join(tmpdir(),'jarvis-native-settings-')))
  const root=join(temp,'root');mkdirSync(root)
  const descriptor=Object.getOwnPropertyDescriptor(process,'platform')!
  Object.defineProperty(process,'platform',{value:platform,configurable:true})
  t.after(()=>{Object.defineProperty(process,'platform',descriptor);rmSync(temp,{recursive:true,force:true})})
  const file=join(temp,'private','settings.json'),output=join(temp,'private','output')
  return {temp,root,file,output,settings:new LocalToolSettings(file,output)}
}
function realHelper(t:TestContext){
  if(!existsSync(executable)){
    assert.notEqual(process.env.JARVIS_NATIVE_HELPER_REQUIRED,'1','Native acceptance requires a built helper')
    t.skip('Build the native helper before native settings acceptance');return false
  }
  // Exercise native settings on Linux without changing the actual host executable.
  const start=(roots:string[])=>originalStart(roots,{executable})
  t.mock.method(NativeFilesystem,'start',(roots: string[])=>start(roots))
  return true
}

test('native settings register normalized read roots with the real helper and retain CAS',async t=>{
  if(!realHelper(t))return
  const f=fixture(t);await f.settings.load()
  const stale=new LocalToolSettings(f.file,f.output);await stale.load()
  const initial=f.settings.snapshot()
  const saved=await f.settings.update({expectedRevision:0,readRoots:[f.root,f.root+'/']})
  assert.deepEqual(saved.readRoots,[f.root]);assert.deepEqual(saved.writeRoots,[])
  assert.equal(saved.shellEnabled,false);assert.equal(saved.outputDir,initial.outputDir)
  const bytes=readFileSync(f.file)
  await assert.rejects(stale.update({expectedRevision:0,readRoots:[]}),{code:'REVISION_CONFLICT'})
  assert.deepEqual(readFileSync(f.file),bytes);assert.deepEqual(stale.snapshot(),initial)
  const reopened=new LocalToolSettings(f.file,f.output);await reopened.load();assert.deepEqual(reopened.snapshot(),saved)
  const reset=await reopened.reset();assert.deepEqual(reset.readRoots,[]);assert.equal(reset.revision,2)
})

// Linux can simulate both private-storage branches. Native hosts must keep
// their actual platform: e.g. Darwin directory fsync is unsupported on Windows.
const validationPlatforms:NodeJS.Platform[]=host==='linux'?['darwin','win32']:[host]
for(const platform of validationPlatforms)test(`native settings on ${platform} allow empty defaults and reject invalid roots before startup`,async t=>{
  const f=fixture(t,platform);await f.settings.load()
  let starts=0;t.mock.method(NativeFilesystem,'start',async()=>{starts++;throw new Error('must not start')})
  const before=f.settings.snapshot(),bytes=readFileSync(f.file)
  const invalid:unknown[]=[null,'root',[null],[''],['relative'],[f.root+'\0'],[f.root+'/../root'],['/proc'],Array.from({length:17},(_,i)=>join(f.temp,`root-${i}`))]
  for(const readRoots of invalid){
    await assert.rejects(f.settings.update({expectedRevision:0,readRoots} as LocalSettingsUpdate))
    assert.deepEqual(f.settings.snapshot(),before);assert.deepEqual(readFileSync(f.file),bytes)
  }
  await assert.rejects(f.settings.update({expectedRevision:0,readRoots:[f.root],writeRoots:[f.root]}),{code:'SCOPED_FILESYSTEM_UNAVAILABLE'})
  await assert.rejects(f.settings.update({expectedRevision:0,readRoots:[f.root],webEnabled:'bad'} as unknown as LocalSettingsUpdate))
  assert.equal(starts,0)
  const cleared=await f.settings.update({expectedRevision:0,readRoots:[],writeRoots:[],skillsDir:null})
  assert.deepEqual(cleared.readRoots,[]);assert.equal(starts,0)
})

test('native settings accept exactly sixteen normalized roots in one real helper',async t=>{
  if(!realHelper(t))return
  const start=(roots:string[])=>originalStart(roots,{executable}),f=fixture(t);await f.settings.load()
  const roots=Array.from({length:16},(_,i)=>{const root=join(f.temp,`root-${i}`);mkdirSync(root);return root})
  let starts=0;t.mock.method(NativeFilesystem,'start',(input:string[])=>{starts++;assert.deepEqual(input,roots);return start(input)})
  const saved=await f.settings.update({expectedRevision:0,readRoots:[...roots,roots[0]!+'/']})
  assert.deepEqual(saved.readRoots,roots);assert.equal(starts,1)
})

test('native settings reject teardown failure before persisting',async t=>{
  if(!realHelper(t))return
  const start=(roots:string[])=>originalStart(roots,{executable}),f=fixture(t);await f.settings.load()
  t.mock.method(NativeFilesystem,'start',async(roots:string[])=>{
    const opened=await start(roots),dispose=opened.filesystem.disposeAsync.bind(opened.filesystem)
    t.mock.method(opened.filesystem,'disposeAsync',async()=>{await dispose();throw new Error('teardown failed')})
    return opened
  })
  const bytes=readFileSync(f.file)
  await assert.rejects(f.settings.update({expectedRevision:0,readRoots:[f.root]}),/teardown failed/)
  assert.deepEqual(readFileSync(f.file),bytes);assert.equal(f.settings.snapshot().revision,0)
})

test('native settings reject missing helper without changing disk or snapshot',async t=>{
  const f=fixture(t);await f.settings.load()
  t.mock.method(NativeFilesystem,'start',(roots:string[])=>originalStart(roots,{executable:join(f.temp,'missing-helper')}))
  const before=f.settings.snapshot(),bytes=readFileSync(f.file)
  await assert.rejects(f.settings.update({expectedRevision:0,readRoots:[f.root]}),/HELPER_/)
  assert.deepEqual(f.settings.snapshot(),before);assert.deepEqual(readFileSync(f.file),bytes)
})

test('native settings retain unavailable disk roots when omitted but revalidate explicit enabling',async t=>{
  const f=fixture(t);await f.settings.load()
  const absent=join(f.temp,'absent')
  atomicPrivateJson(f.file,{...f.settings.snapshot(),readRoots:[absent]})
  await f.settings.load();assert.deepEqual(f.settings.snapshot().readRoots,[absent])
  let starts=0;t.mock.method(NativeFilesystem,'start',async()=>{starts++;throw new Error('must not start')})
  const saved=await f.settings.update({expectedRevision:0,webEnabled:true})
  assert.deepEqual(saved.readRoots,[absent]);assert.equal(starts,0)
  const bytes=readFileSync(f.file)
  await assert.rejects(f.settings.update({expectedRevision:1,readRoots:[absent]}),/ENOENT/)
  assert.equal(starts,0);assert.deepEqual(readFileSync(f.file),bytes)
  await f.settings.update({expectedRevision:1,readRoots:[]})
})

test('native settings reject symlink root and ancestor before starting helper',async t=>{
  const f=fixture(t);await f.settings.load()
  const alias=join(f.temp,'alias'),ancestor=join(f.temp,'ancestor')
  symlinkSync(f.root,alias,host==='win32'?'junction':'dir')
  symlinkSync(f.temp,ancestor,host==='win32'?'junction':'dir')
  let starts=0;t.mock.method(NativeFilesystem,'start',async()=>{starts++;throw new Error('must not start')})
  for(const root of [alias,join(ancestor,'root')])await assert.rejects(f.settings.update({expectedRevision:0,readRoots:[root]}),/symlink/)
  assert.equal(starts,0);assert.equal(f.settings.snapshot().revision,0)
})

test('native settings keep the private CAS lock through helper startup and teardown',async t=>{
  if(!realHelper(t))return
  const start=(roots:string[])=>originalStart(roots,{executable}),f=fixture(t);await f.settings.load()
  let entered!:()=>void,release!:()=>void,closing!:()=>void,finish!:()=>void
  const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r)
  const teardown=new Promise<void>(r=>closing=r),closeGate=new Promise<void>(r=>finish=r)
  t.mock.method(NativeFilesystem,'start',async(roots:string[])=>{
    entered();await gate
    const opened=await start(roots),dispose=opened.filesystem.disposeAsync.bind(opened.filesystem)
    t.mock.method(opened.filesystem,'disposeAsync',async()=>{closing();await closeGate;await dispose()})
    return opened
  })
  const bytes=readFileSync(f.file),update=f.settings.update({expectedRevision:0,readRoots:[f.root]})
  await ready
  let acquired=false
  const lock=withPrivateFileLock(f.file,()=>{acquired=true})
  try{
    assert.deepEqual(readFileSync(f.file),bytes);assert.equal(acquired,false)
    release();await teardown
    assert.deepEqual(readFileSync(f.file),bytes);assert.equal(acquired,false)
  }finally{release();finish()}
  await update;await lock;assert.equal(acquired,true)
  assert.equal(f.settings.snapshot().revision,1)
})

test('native settings reject a real-helper ABA root substitution',async t=>{
  if(!realHelper(t))return
  const start=(roots:string[])=>originalStart(roots,{executable}),f=fixture(t);await f.settings.load()
  const original=join(f.temp,'original'),substitute=join(f.temp,'substitute');mkdirSync(substitute)
  const identity=(root:string)=>{const s=lstatSync(root,{bigint:true});return {device:String(s.dev),inode:String(s.ino)}}
  const authorized=identity(f.root),other=identity(substitute),bytes=readFileSync(f.file)
  assert.notDeepEqual(authorized,other)
  let initialized=false,restored=false
  t.mock.method(NativeFilesystem,'start',async(roots:string[])=>{
    assert.deepEqual(roots,[f.root])
    // All move targets are fixed absolute fixture paths, not external data.
    renameSync(f.root,original);renameSync(substitute,f.root)
    let opened:Awaited<ReturnType<typeof start>>|undefined
    try{
      opened=await start(roots);initialized=true;assert.deepEqual(opened.identities,[other])
      try{renameSync(f.root,substitute)}catch(error){assert.equal(host,'win32');throw error}
      renameSync(original,f.root);restored=true
      return opened
    }catch(error){await opened?.filesystem.disposeAsync();throw error}
    finally{
      if(existsSync(original)){
        if(existsSync(f.root))renameSync(f.root,substitute)
        renameSync(original,f.root)
      }
    }
  })
  await assert.rejects(f.settings.update({expectedRevision:0,readRoots:[f.root]}))
  assert.equal(initialized,true);if(host!=='win32')assert.equal(restored,true)
  assert.deepEqual(identity(f.root),authorized);assert.deepEqual(readFileSync(f.file),bytes)
  assert.equal(f.settings.snapshot().revision,0)
})
