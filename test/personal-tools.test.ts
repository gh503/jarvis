import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../src/memory/store.ts'
import { ProfileStore } from '../src/profile.ts'
import { SessionStore } from '../src/sessions.ts'
import { personalTools } from '../src/local-tools/personal.ts'

function setup(t: TestContext) {
  const memory=new MemoryStore({file:':memory:'}), sessions=new SessionStore({file:':memory:'}), profile=new ProfileStore(memory)
  t.after(()=>{sessions.close();memory.close()})
  const session=sessions.create('Current session')
  sessions.beginTurn(session.id,'current','Remember that the project uses SQLite. Exact evidence only.','text')
  let mutations=0
  const tools=personalTools({memory,sessions,profile,onMemoryMutation:()=>{mutations++}})
  const ctx={signal:new AbortController().signal,sessionId:session.id,turnId:'current',callId:'call'}
  const invoke=(name:string,args:Record<string,unknown>,context=ctx)=>tools.find(tool=>tool.name===name)!.execute(args,context)
  const add=(content='Ordinary note',sourceRef='manual')=>memory.add({kind:'semantic',content,sourceKind:'user-stated',sourceRef})
  return {memory,sessions,profile,session,tools,ctx,invoke,add,mutations:()=>mutations}
}

test('post-mutation errors propagate uncertain outcomes without private details',async t=>{
  const f=setup(t), item=await f.add()
  const tools=personalTools({memory:f.memory,sessions:f.sessions,onMemoryMutation:()=>{throw new Error('secret callback detail')}})
  await assert.rejects(tools.find(tool=>tool.name==='memory_forget')!.execute({id:item.id,expectedUpdatedAt:item.updatedAt},f.ctx),error=>{
    assert.match(String(error),/outcome is uncertain/)
    assert.equal(String(error).includes('secret'),false)
    return true
  })
  assert.equal(f.memory.get(item.id),null)
  const controller=new AbortController()
  const aborted=personalTools({memory:f.memory,sessions:f.sessions,onMemoryMutation:()=>controller.abort()})
  await assert.rejects(aborted.find(tool=>tool.name==='memory_propose')!.execute({content:'the project uses SQLite',evidence:'the project uses SQLite'},{...f.ctx,signal:controller.signal}),/outcome is uncertain/)
  assert.equal(f.memory.list().length,1)
})

test('concurrent changes during correction embedding prevent stale replacement',async t=>{
  let release:((value:null)=>void)|undefined
  let deferred=false
  const memory=new MemoryStore({file:':memory:',embedder:{model:'controlled',embed:async()=>deferred?new Promise<null>(resolve=>{release=resolve}):null}})
  const sessions=new SessionStore({file:':memory:'})
  t.after(()=>{sessions.close();memory.close()})
  const item=await memory.add({kind:'semantic',content:'Old',sourceKind:'user-stated',sourceRef:'manual'})
  const tool=personalTools({memory,sessions}).find(tool=>tool.name==='memory_correct')!
  deferred=true
  const pending=tool.execute({id:item.id,content:'Stale replacement',expectedUpdatedAt:item.updatedAt},{signal:new AbortController().signal,sessionId:'session',turnId:'turn',callId:'call'})
  assert.ok(release)
  memory.reject(item.id)
  release(null)
  await assert.rejects(pending,/outcome is uncertain/)
  assert.equal(memory.get(item.id)?.status,'rejected')
  assert.equal(memory.list({includeInactive:true}).length,1)
})

test('correction CAS rejects conflict resolution and profile attachment during embedding',async t=>{
  for (const change of ['conflict','profile'] as const) {
    let release:((value:null)=>void)|undefined
    let deferNext=false
    const memory=new MemoryStore({file:':memory:',now:()=>new Date('2026-01-01T00:00:00Z'),embedder:{model:'controlled',embed:async()=>{
      if (!deferNext) return null
      deferNext=false
      return new Promise<null>(resolve=>{release=resolve})
    }}})
    t.after(()=>memory.close())
    const old=await memory.add({kind:'semantic',content:'我住在旧城市',sourceKind:'user-stated',sourceRef:'manual'})
    deferNext=true
    const pending=memory.edit(old.id,'Stale correction')
    assert.ok(release)
    const epoch=memory.mutationEpoch()
    if (change==='conflict') {
      await memory.add({kind:'semantic',content:'我住在新城市',sourceKind:'user-stated',sourceRef:'new',resolveConflicts:true})
      assert.equal(memory.get(old.id)?.status,'superseded')
      assert.equal(memory.get(old.id)?.updatedAt,old.updatedAt)
    } else {
      assert.ok(new ProfileStore(memory).observeMemory(old))
      // Isolate the association guard by restoring the other CAS fields.
      memory.databaseForProfile().prepare("UPDATE memory_items SET status='confirmed' WHERE id=?").run(old.id)
    }
    assert.equal(memory.mutationEpoch(),epoch)
    release(null)
    await assert.rejects(pending,/concurrent change/)
    assert.equal(memory.list({includeInactive:true,includeSensitive:true}).some(item=>item.content==='Stale correction'),false)
    assert.equal(memory.get(old.id)?.content,old.content)
  }
})

test('personal definitions have stable hashes, local boundaries, and approval for mutations and capture',async t=>{
  const f=setup(t)
  const captures:Array<[string,AbortSignal]>=[]
  const make=()=>personalTools({memory:f.memory,sessions:f.sessions,inspectScreen:async(p,s)=>{captures.push([p,s]);return 'screen'},inspectCamera:async()=> 'camera'})
  const a=make(), b=make()
  assert.deepEqual(a.map(tool=>tool.definitionHash),b.map(tool=>tool.definitionHash))
  for(const tool of a){assert.equal(tool.usage,'local');assert.equal(tool.destination,'local');assert.equal(tool.permission,tool.effect==='write'||tool.name.endsWith('_inspect')?'ask':'allow')}
  assert.equal(a.some(tool=>tool.name==='profile_read'),false)
  const screen=a.find(tool=>tool.name==='screen_inspect')!
  assert.equal(screen.effect,'read')
  assert.deepEqual(JSON.parse((await screen.execute({prompt:'Inspect'},f.ctx)).content),{text:'screen'})
  assert.deepEqual(captures,[['Inspect',f.ctx.signal]])
  const aborted={...f.ctx,signal:AbortSignal.abort()}
  assert.equal((await screen.execute({prompt:'Inspect'},aborted)).isError,true)
  assert.equal(captures.length,1)
})

test('ordinary reads reject private, profile, inactive, expired, and absent records',async t=>{
  const f=setup(t), ordinary=await f.add()
  const result=JSON.parse((await f.invoke('memory_read',{id:ordinary.id})).content)
  assert.equal(result.content,ordinary.content);assert.equal(result.sourceRef,'manual');assert.equal(result.sourceSpan,'')
  const rejected=await f.add('Rejected');f.memory.reject(rejected.id)
  const expired=await f.memory.add({kind:'semantic',content:'Expired',sourceKind:'user-stated',sourceRef:'manual',retention:'expires-at',expiresAt:'2000-01-01T00:00:00Z'})
  const privateItem=await f.memory.add({kind:'semantic',content:'Sensitive',sourceKind:'user-stated',sourceRef:'manual',sensitivity:'sensitive'})
  const profile=f.profile.saveEntry({category:'interest',field:'hobby',value:'private hobby',usage:'display'})
  // Even a legacy/misconfigured standard profile row must not bypass profile usage.
  f.memory.databaseForProfile().prepare("UPDATE memory_items SET sensitivity='standard' WHERE id=?").run(profile.memoryId)
  const noProfile=personalTools({memory:f.memory,sessions:f.sessions})
  assert.equal((await noProfile.find(tool=>tool.name==='memory_read')!.execute({id:profile.memoryId},f.ctx)).isError,true)
  for(const id of [rejected.id,expired.id,privateItem.id,profile.memoryId,'missing']){
    assert.equal((await f.invoke('memory_read',{id})).isError,true)
    assert.equal((await f.invoke('memory_correct',{id,content:'Overwrite',expectedUpdatedAt:ordinary.updatedAt})).isError,true)
    assert.equal((await f.invoke('memory_forget',{id,expectedUpdatedAt:ordinary.updatedAt})).isError,true)
  }
})

test('proposals require exact current-turn user evidence and derive all provenance',async t=>{
  const f=setup(t)
  for(const args of [
    {content:'Fake model assertion',evidence:'Fake model assertion'},
    {content:'Fake model assertion',evidence:'the project uses SQLite'},
    {content:'the project uses SQLite',evidence:'the project uses SQLite',sourceRef:'fake'},
  ])assert.equal((await f.invoke('memory_propose',args)).isError,true)
  const args={content:'the project uses SQLite',evidence:'Remember that the project uses SQLite.'}
  assert.equal((await f.invoke('memory_propose',args,{...f.ctx,sessionId:f.sessions.create().id})).isError,true)
  const item=JSON.parse((await f.invoke('memory_propose',args)).content)
  assert.equal(item.sourceKind,'inferred');assert.equal(item.trust,'low');assert.equal(item.status,'proposed')
  assert.equal(item.sourceRef,'turn:current');assert.equal(item.sourceSpan,args.evidence)
  assert.equal(f.mutations(),1)
  assert.equal((await f.invoke('memory_read',{id:item.id})).isError,true)
  f.sessions.excludeTurnFromContext('current')
  assert.equal((await f.invoke('memory_propose',args)).isError,true)
})

test('correction and forgetting enforce revisions, source exclusion, and inference barriers',async t=>{
  const f=setup(t)
  f.sessions.beginTurn(f.session.id,'old','Old source evidence','text')
  f.sessions.finishTurn('old',{status:'complete',text:'Old source response'})
  const old=await f.add('Old assertion','turn:old')
  assert.equal((await f.invoke('memory_correct',{id:old.id,content:'Replacement',expectedUpdatedAt:'stale'})).isError,true)
  assert.equal(f.memory.get(old.id)?.status,'confirmed')
  const corrected=JSON.parse((await f.invoke('memory_correct',{id:old.id,content:'Replacement',expectedUpdatedAt:old.updatedAt})).content)
  assert.equal(corrected.content,'Replacement');assert.equal(f.memory.get(old.id)?.status,'superseded')
  assert.equal(f.sessions.getTurn('old')?.assistant.metadata?.contextExcluded,true)
  assert.equal((await f.invoke('memory_read',{id:old.id})).isError,true)
  assert.equal((await f.invoke('memory_forget',{id:corrected.id,expectedUpdatedAt:'stale'})).isError,true)
  assert.equal((await f.invoke('memory_forget',{id:corrected.id,expectedUpdatedAt:corrected.updatedAt})).isError,undefined)
  assert.equal(f.memory.get(corrected.id),null)
  await assert.rejects(f.memory.add({kind:'semantic',content:'Replacement',sourceKind:'inferred',sourceRef:'other'}),/suppressed/)
  assert.equal(f.mutations(),2)
})

test('profile reads honor confirmed usage, scope and use settings without exposing snapshots',async t=>{
  const f=setup(t)
  f.profile.saveEntry({category:'interest',field:'hobby',value:'Visible hobby',usage:'local'})
  f.profile.saveEntry({category:'understanding',field:'notes',value:'Display secret',usage:'display'})
  f.profile.saveEntry({category:'goal',field:'goal',value:'Unconfirmed',usage:'local',status:'proposed'})
  f.profile.saveEntry({category:'preference',field:'workstyle',value:'Other scope',usage:'local',scope:'other'})
  const result=JSON.parse((await f.invoke('profile_read',{})).content)
  assert.equal(result.length,1);assert.equal(result[0].value,'Visible hobby');assert.equal(result[0].sourceRef,'profile:manual')
  assert.equal('people' in result[0],false)
  assert.deepEqual(JSON.parse((await f.invoke('profile_read',{fields:['notes']})).content),[])
  f.profile.updateSettings({useEnabled:false})
  assert.deepEqual(JSON.parse((await f.invoke('profile_read',{})).content),[])
})

test('session tools search across sessions with complete-pair privacy and stable bounded pagination',async t=>{
  const f=setup(t), other=f.sessions.create('Other session')
  const complete=(id:string,text:string,metadata?:Record<string,unknown>)=>{
    const pair=f.sessions.beginTurn(other.id,id,text,'text')
    f.sessions.finishTurn(id,{status:'complete',text:`Reply ${text}`,metadata})
    return pair
  }
  const kept=complete('kept','literal %_\\ match')
  complete('excluded','Secret excluded',{contextExcluded:true})
  const userExcluded=complete('user-excluded','Secret user excluded')
  f.sessions.databaseForTools().prepare("UPDATE messages SET metadata=? WHERE id=?").run(JSON.stringify({contextExcluded:true}),userExcluded.user.id)
  f.sessions.beginTurn(other.id,'unfinished','Secret streaming','text')
  f.sessions.beginTurn(other.id,'failed','Secret failed','text');f.sessions.finishTurn('failed',{status:'error',text:'Secret error'})
  complete('metadata','Safe',{toolRequest:'Secret tool args',approval:'Secret approval'})
  const deleted=f.sessions.create('Deleted');f.sessions.beginTurn(deleted.id,'deleted','Secret deleted','text');f.sessions.finishTurn('deleted',{status:'complete',text:'Secret deleted'});f.sessions.delete(deleted.id)
  const search=JSON.parse((await f.invoke('session_search',{query:'%_\\'})).content)
  assert.equal(search.items.length,2);assert.equal(search.items[0].sessionId,other.id)
  assert.equal(search.items[0].title,'Other session');assert.equal(search.items[0].source,'text');assert.equal(typeof search.items[0].timestamp,'number')
  assert.deepEqual(JSON.parse((await f.invoke('session_search',{query:'Secret'})).content).items,[])
  const one=JSON.parse((await f.invoke('session_read',{sessionId:other.id,messageId:kept.user.id})).content)
  assert.equal(one.items.length,1);assert.equal(one.items[0].role,'user')
  const auto=f.sessions.create()
  f.sessions.beginTurn(auto.id,'auto-secret','Secret automatic title','text');f.sessions.finishTurn('auto-secret',{status:'complete',text:'Secret'})
  f.sessions.excludeTurnFromContext('auto-secret')
  f.sessions.beginTurn(auto.id,'auto-safe','Visible later','text');f.sessions.finishTurn('auto-safe',{status:'complete',text:'Visible reply'})
  const safeTitle=JSON.parse((await f.invoke('session_read',{sessionId:auto.id})).content)
  assert.equal(JSON.stringify(safeTitle).includes('Secret'),false)
  const first=JSON.parse((await f.invoke('session_read',{sessionId:other.id,limit:2})).content)
  const second=JSON.parse((await f.invoke('session_read',{sessionId:other.id,limit:2,before:first.nextBefore})).content)
  assert.equal(first.items.length,2);assert.equal(second.items.length,2)
  assert.ok(second.items.every((row:{messageId:number})=>row.messageId<first.nextBefore))
  assert.equal(JSON.stringify(first).includes('Secret'),false)
  assert.equal((await f.invoke('session_search',{query:'Safe',limit:11})).isError,true)
  assert.equal((await f.invoke('session_read',{sessionId:other.id,limit:21})).isError,true)
  complete('long','x'.repeat(10000))
  const bounded=JSON.parse((await f.invoke('session_read',{sessionId:other.id})).content)
  assert.ok(bounded.items.every((row:{excerpt:string})=>row.excerpt.length<=500))
})
