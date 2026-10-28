import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { Conversation, type ConversationDeps } from '../src/conversation.ts'
import { SessionStore } from '../src/sessions.ts'
import { EventBus } from '../src/events.ts'
import { SecureFiles } from '../src/secure-files.ts'
import { JarvisServer, type ServerDeps } from '../src/server.ts'

function png() {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff
    for (const byte of body) { crc ^= byte; for (let i=0;i<8;i++) crc=(crc>>>1)^((crc&1)?0xedb88320:0) }
    const size=Buffer.alloc(4), sum=Buffer.alloc(4); size.writeUInt32BE(data.length); sum.writeUInt32BE((crc^0xffffffff)>>>0)
    return Buffer.concat([size,body,sum])
  }
  const header=Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1,4); header[8]=8; header[9]=6
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,1,2,3,255]))),chunk('IEND',Buffer.alloc(0))])
}
async function fixture() {
  const dir=await mkdtemp(join(tmpdir(),'jarvis-browser-integration-'))
  const sessions=new SessionStore({file:':memory:'}), bus=new EventBus(), secure=new SecureFiles(dir)
  const counters={vision:0,remote:0,memory:0,speech:0}
  const local={isLocal:true,vision:async()=>{counters.vision++;return 'private visual detail'}}
  const deps={sessions,bus,secure,config:{dataDir:dir},model:{model:'test',localClient:()=>local,vision:async()=>{counters.remote++;throw Error('remote')},chatOnce:async()=>{counters.remote++;return ''}},
    attention:{getState:()=> 'idle',send(){},reset(){},snapshot:()=>({})},memory:{addEpisode(){counters.memory++},list(){counters.memory++;return []}},
    transcriber:{},synthesizer:{available:async()=>true,synthesize:async()=>{counters.speech++}},policy:{noteInteraction(){},isFocus:()=>false,isQuiet:()=>false},tuning:{number:()=>1000},logger:{warn(){}}} as unknown as ConversationDeps
  const conversation=new Conversation(deps), sessionId=sessions.create().id
  return {dir,sessions,bus,secure,counters,local,deps,conversation,sessionId,async close(){conversation.reset();sessions.close();await rm(dir,{recursive:true,force:true})}}
}

test('browser capture stays local, encrypted and absent from context/memory/speech; replay rejects',async()=>{
  const f=await fixture()
  try {
    const options={sessionId:f.sessionId,turnId:'capture',target:'screen' as const}
    const result=await f.conversation.handleBrowserCapture(png(),'image/png',options)
    assert.equal(result.reply,'private visual detail')
    assert.deepEqual(f.counters,{vision:1,remote:0,memory:0,speech:0})
    assert.equal(f.sessions.getTurn('capture')?.assistant.metadata?.contextExcluded,true)
    assert.deepEqual(f.sessions.context(f.sessionId,20),[])
    await assert.rejects(f.conversation.handleBrowserCapture(Buffer.alloc(0),'image/png',options),/already exists/)
    const names=await readdir(join(f.dir,'captures')); assert.equal(names.length,1)
    const bytes=await readFile(join(f.dir,'captures',names[0])); assert.deepEqual(f.secure.decryptBuffer(bytes),png()); assert.notDeepEqual(bytes,png())
    for(const event of f.bus.history().filter(e=>['turn.start','user.message','sense.capture','assistant.done','turn.end'].includes(e.type))) {
      assert.equal((event.data as any).turnId,'capture'); assert.equal((event.data as any).sessionId,f.sessionId)
    }
    assert.equal(f.conversation.status().busy,false)
  } finally {await f.close()}
})

test('browser capture refuses remote override and persists excluded validation failures',async()=>{
  const f=await fixture(), previous=process.env.JARVIS_ALLOW_REMOTE_VISION
  try {
    process.env.JARVIS_ALLOW_REMOTE_VISION='1'; f.local.isLocal=false
    const denied=await f.conversation.handleBrowserCapture(png(),'image/png',{sessionId:f.sessionId,turnId:'remote',target:'camera'})
    assert.match(denied.error!,/local-only/); assert.equal(f.counters.vision,0); assert.equal(f.counters.remote,0)
    f.local.isLocal=true
    const invalid=await f.conversation.handleBrowserCapture(Buffer.alloc(0),'image/png',{sessionId:f.sessionId,turnId:'invalid',target:'screen'})
    assert.ok(invalid.error); assert.equal(f.sessions.getTurn('invalid')?.assistant.metadata?.contextExcluded,true)
    assert.equal(f.conversation.status().busy,false)
  } finally {if(previous===undefined) delete process.env.JARVIS_ALLOW_REMOTE_VISION; else process.env.JARVIS_ALLOW_REMOTE_VISION=previous;await f.close()}
})

test('browser capture cancellation suppresses late output and releases admission',async()=>{
  const f=await fixture(); let started!:()=>void, finish!:(value:string)=>void
  const ready=new Promise<void>(r=>started=r), pending=new Promise<string>(r=>finish=r)
  f.local.vision=async()=>{started();return pending}
  try {
    const options={sessionId:f.sessionId,turnId:'cancel',target:'camera' as const}
    const result=f.conversation.handleBrowserCapture(png(),'image/png',options); await ready
    await assert.rejects(f.conversation.handleBrowserCapture(png(),'image/png',options),/already exists/)
    assert.equal((await f.conversation.handleText('other')).busy,true)
    assert.equal(f.conversation.cancel(options),true)
    assert.equal((await result).cancelled,true); finish('late secret')
    assert.equal(f.sessions.getTurn('cancel')?.assistant.status,'cancelled')
    assert.equal(f.sessions.getTurn('cancel')?.assistant.metadata?.contextExcluded,true)
    assert.equal(f.bus.history().filter(e=>e.type==='assistant.done').length,0)
    assert.equal(f.conversation.status().busy,false)
  } finally {finish?.('done');await f.close()}
})

test('browser capture HTTP requires auth, origin, identity, PNG and bounds; returns correlated events',async()=>{
  const f=await fixture()
  const server=new JarvisServer({...f.deps,conversation:f.conversation,config:{...f.deps.config,host:'127.0.0.1',port:0,authToken:'test-token'}} as unknown as ServerDeps)
  const {url}=await server.start(), path=`${url}/api/browser-capture?sessionId=${f.sessionId}&turnId=http&target=screen`
  const post=(endpoint=path,headers:Record<string,string>={},body:Buffer=png())=>fetch(endpoint,{method:'POST',headers:{'content-type':'image/png',...headers},body:new Uint8Array(body)})
  try {
    assert.equal((await post(path,{'x-forwarded-for':'1.2.3.4'})).status,401)
    assert.equal((await post(path,{origin:'https://evil.example'})).status,403)
    assert.equal((await post(`${url}/api/browser-capture`)).status,400)
    assert.equal((await post(path,{'content-type':'image/jpeg'})).status,400)
    assert.equal((await post(path,{},Buffer.alloc(8*1024*1024+1))).status,413)
    const result=await post(); assert.equal(result.status,200); assert.equal((await result.json() as any).turnId,'http')
    assert.equal((await post()).status,409)
    assert.equal(f.counters.vision,1)
    assert.equal((await post(`${url}/api/browser-capture?sessionId=missing&turnId=missing&target=screen`)).status,404)
    f.sessions.setArchived(f.sessionId,true)
    assert.equal((await post(path.replace('turnId=http','turnId=archived'))).status,409)
    assert.equal(f.counters.vision,1)
  } finally {await server.close();await f.close()}
})
