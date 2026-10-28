import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { acquireLifecycleLock, requestRuntime } from '../src/runtime-lifecycle.ts'

const launcher=fileURLToPath(new URL('../scripts/app.ts',import.meta.url))
function launch(args:string[],env:NodeJS.ProcessEnv,cwd:string){
  const child=spawn(process.execPath,['--experimental-transform-types',launcher,...args],{cwd,env,stdio:['ignore','pipe','pipe']})
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b)
  return new Promise<{code:number|null;output:string}>((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve({code,output}))})
}

test('native fresh runtime supports session deletion, bulk deletion and full privacy erase',{timeout:90_000},async()=>{
  const container=realpathSync(mkdtempSync(join(tmpdir(),'jarvis native privacy '))),dataDir=join(container,'data')
  const probe=createServer();await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=(probe.address() as {port:number}).port;await new Promise<void>(resolve=>probe.close(()=>resolve()))
  const token=randomUUID()+randomUUID()
  // Isolated working/data directories, explicit authentication and unavailable
  // optional services: this test cannot connect to the user's configured models.
  const env={...process.env,JARVIS_DATA_DIR:dataDir,JARVIS_HOST:'127.0.0.1',JARVIS_PORT:String(port),JARVIS_AUTH_TOKEN:token,JARVIS_TLS_CERT:'',JARVIS_TLS_KEY:'',JARVIS_OLLAMA_URL:'http://127.0.0.1:1',JARVIS_PYTHON:join(container,'missing python'),JARVIS_PIPER_BIN:join(container,'missing piper'),JARVIS_ASR_MODEL:join(container,'missing model')}
  const request=async(path:string,method='GET',body?:unknown)=>{
    const response=await fetch(`http://127.0.0.1:${port}${path}`,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20_000)})
    return {status:response.status,body:await response.json() as Record<string,any>}
  }
  try{
    const started=await launch(['--no-open'],env,container);assert.equal(started.code,0,started.output)
    assert.equal((await requestRuntime(dataDir))?.state,'ready')
    const first=await request('/api/sessions','POST',{title:'Native privacy acceptance'});assert.equal(first.status,201,JSON.stringify(first.body));const firstId=first.body.session.id
    const deleted=await request(`/api/sessions/${firstId}`,'DELETE');assert.equal(deleted.status,200,JSON.stringify(deleted.body));assert.equal((await request(`/api/sessions/${firstId}`)).status,404)
    const second=await request('/api/sessions','POST',{title:'Bulk deletion'});assert.equal(second.status,201)
    const bulk=await request('/api/sessions','DELETE',{confirm:'DELETE ALL SESSIONS'});assert.equal(bulk.status,200,JSON.stringify(bulk.body));assert.equal((await request(`/api/sessions/${second.body.session.id}`)).status,404)
    const third=await request('/api/sessions','POST',{title:'Full erase'});assert.equal(third.status,201)
    const erased=await request('/api/privacy/erase','POST',{confirm:'ERASE ALL'});assert.equal(erased.status,200,JSON.stringify(erased.body));assert.equal((await request(`/api/sessions/${third.body.session.id}`)).status,404)
    const stopped=await launch(['--stop'],env,container);assert.equal(stopped.code,0,stopped.output);assert.equal(await requestRuntime(dataDir),null)
  }finally{
    await requestRuntime(dataDir,'shutdown')
    const release=await acquireLifecycleLock(dataDir,'runtime',15_000);release()
    // Only the exact mkdtemp directory owned by this test is removed.
    assert.equal(dirname(dataDir),container);assert.ok(container.includes('jarvis native privacy '));rmSync(container,{recursive:true,force:true})
  }
})
