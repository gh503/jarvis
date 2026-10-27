import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/memory/store.ts'
import { ProfileStore, ProfileError, type ProfileValue } from '../src/profile.ts'

function setup() { const memory = new MemoryStore({file:':memory:'}); return {memory,profile:new ProfileStore(memory)} }
const hobby = {category:'interest' as const,field:'hobby',value:'登山'}

test('confirming an observed profile proposal locks the field and promotes provenance', async () => {
  const {memory,profile} = setup()
  try {
    const item = await memory.add({kind:'semantic',content:'我喜欢游泳',sourceKind:'inferred',sourceRef:'conversation:confirm',confidence:0.4})
    const proposal = profile.observeMemory(item)!
    assert.equal(proposal.userLocked,false)
    const confirmed = memory.confirm(item.id)!
    const entry = profile.snapshot().entries.find(entry=>entry.id === proposal.id)!
    assert.equal(entry.userLocked,true)
    assert.equal(entry.status,'confirmed')
    assert.equal(entry.sourceKind,'user-confirmed')
    assert.equal(entry.revision,proposal.revision+1)
    assert.equal(confirmed.confidence,1)
    assert.equal(confirmed.trust,'authoritative')
    await assert.rejects(memory.add({kind:'semantic',content:'我喜欢旅行',sourceKind:'inferred',sourceRef:'conversation:later'}),/user-locked/)
  } finally { memory.close() }
})

test('generic profile edits preserve remote privacy for restricted fields and people', async () => {
  const {memory,profile} = setup()
  try {
    const person = profile.savePerson({name:'测试亲属',relationship:'母亲'})
    const inputs = [
      {category:'basic' as const,field:'city',value:'测试城市'},
      {category:'basic' as const,field:'birthday',value:{calendar:'solar',year:2000,month:1,day:1}},
      {...hobby,subjectId:person.id},
    ]
    for (const input of inputs) {
      const entry = profile.saveEntry({...input,value:input.value as unknown as ProfileValue,usage:'relevant'})
      assert.equal(profile.context({remote:true}).some(value=>value.id === entry.id),false)
      await memory.edit(entry.memoryId,'这条信息只应留在本地')
      const edited = profile.snapshot().entries.find(value=>value.id === entry.id)!
      assert.equal(edited.field,'understanding')
      assert.equal(edited.usage,'local')
      assert.equal(profile.context({remote:true}).some(value=>value.id === entry.id),false)
      assert.equal(profile.context({remote:false,query:'母亲的信息只应留在本地'}).some(value=>value.id === entry.id),true)
    }
    const shareable = profile.saveEntry({...hobby,usage:'relevant'})
    await memory.edit(shareable.memoryId,'回答时请简洁')
    assert.equal(profile.snapshot().entries.find(value=>value.id === shareable.id)?.usage,'relevant')
  } finally { memory.close() }
})

test('consolidation cannot retire profile predecessors through imported supersedes edges', async () => {
  const {memory,profile} = setup()
  try {
    const entry = profile.saveEntry(hobby)
    await memory.add({kind:'semantic',content:'一条导入的替代记录',sourceKind:'v1-import',sourceRef:'import:profile-edge',supersedesId:entry.memoryId})
    const ordinary = await memory.add({kind:'semantic',content:'普通旧记录',sourceKind:'user-stated',sourceRef:'conversation:ordinary'})
    await memory.add({kind:'semantic',content:'普通新记录',sourceKind:'v1-import',sourceRef:'import:ordinary-edge',supersedesId:ordinary.id})
    const stats = await memory.consolidate()
    assert.equal(stats.superseded,1)
    assert.equal(memory.get(ordinary.id)?.status,'superseded')
    assert.equal(memory.get(entry.memoryId)?.status,'confirmed')
    assert.equal(memory.get(entry.memoryId)?.validTo,null)
    assert.equal(profile.snapshot().entries[0].revision,entry.revision)
  } finally { memory.close() }
})

test('recall rechecks FTS candidates deleted or rejected during query embedding', async () => {
  for (const action of ['delete','reject','erase'] as const) {
    let release: ((value:null)=>void) | undefined
    let defer = false
    const memory = new MemoryStore({file:':memory:',embedder:{model:'controlled',embed:async()=>defer ? new Promise<null>(resolve=>{release=resolve}) : null}})
    try {
      const item = await memory.add({kind:'semantic',content:'测试召回候选',sourceKind:'user-stated',sourceRef:`conversation:${action}`})
      assert.equal((await memory.recall('测试召回候选')).items[0]?.id,item.id)
      defer = true
      const pending = memory.recall('测试召回候选')
      assert.ok(release,'query embedding must be pending after FTS candidate collection')
      if (action === 'erase') memory.eraseAll()
      else memory[action](item.id)
      release(null)
      assert.deepEqual((await pending).items,[],`${action} must invalidate captured FTS candidates`)
    } finally { memory.close() }
  }
})
test('profile single source, optimistic edits and generic synchronization', async()=>{
 const {memory,profile}=setup()
 try {
 const entry=profile.saveEntry(hobby)
 assert.equal(memory.stats().total,1)
 assert.equal(memory.get(entry.memoryId)?.content,entry.content)
 assert.equal(memory.databaseForProfile().prepare('SELECT embedding FROM memory_items').get()?.embedding,null)
 assert.throws(()=>profile.saveEntry({...hobby,id:entry.id,expectedRevision:0}), (e:unknown)=>e instanceof ProfileError && e.statusCode===409)
 const edited=profile.saveEntry({...hobby,id:entry.id,expectedRevision:1,value:'游泳'})
 assert.equal(edited.revision,2)
 assert.equal(memory.stats().total,1)
 await memory.edit(entry.memoryId,'我更喜欢散步')
 const synced=profile.snapshot().entries[0]
 assert.equal(synced.field,'understanding');assert.equal(synced.value,'我更喜欢散步');assert.equal(synced.revision,3)
 memory.reject(entry.memoryId); assert.equal(profile.snapshot().entries[0].status,'inactive')
 memory.confirm(entry.memoryId); assert.equal(profile.snapshot().entries[0].status,'confirmed')
 memory.delete(entry.memoryId); assert.deepEqual(profile.snapshot().entries,[])
 await assert.rejects(memory.add({kind:'semantic',content:'我更喜欢散步',sourceKind:'inferred',sourceRef:'new'}),/suppressed/)
 } finally {memory.close()}
})
test('privacy defaults, settings, family scope, recall exclusion and export',async()=>{
 const {memory,profile}=setup()
 try {
 const entry=profile.saveEntry({...hobby,usage:'relevant'})
 assert.equal((await memory.recall('登山',{includeSensitive:true})).items.length,0)
 assert.equal(profile.context({remote:true}).length,1)
 profile.saveEntry({category:'basic',field:'birthday',value:{calendar:'solar',year:2000,month:1,day:2},usage:'relevant'})
 assert.equal(profile.context({remote:true}).length,1)
 const person=profile.savePerson({name:'测试家人',relationship:'母亲'})
 profile.saveEntry({...hobby,subjectId:person.id,usage:'local',scope:'family'})
 assert.equal(profile.context({remote:false,scope:'family'}).length,2)
 assert.equal(profile.context({remote:false,scope:'family',query:'母亲喜欢什么'}).length,1)
 assert.equal(memory.exportAll().profile.profile_entries.length,3)
 assert.equal(memory.exportAll().items.find(i=>i.id===entry.memoryId)?.content,entry.content)
 profile.updateSettings({useEnabled:false,learningEnabled:false})
 assert.deepEqual(profile.context({remote:false}),[])
 await assert.rejects(memory.add({kind:'semantic',content:'新的偏好',sourceKind:'inferred',sourceRef:'conversation:1'}),/paused/)
 profile.deletePerson(person.id,1);assert.equal(profile.snapshot().people.length,0)
 assert.throws(()=>profile.deleteEntry(entry.id,42),/Revision/)
 memory.eraseAll()
 assert.deepEqual(profile.snapshot().entries,[]);assert.deepEqual(profile.snapshot().changes,[])
 assert.deepEqual(profile.snapshot().settings,{learningEnabled:true,useEnabled:true})
 assert.equal(memory.databaseForProfile().prepare('SELECT COUNT(*) n FROM memory_forget_barriers').get()?.n,0)
 }finally{memory.close()}
})
test('birthday and structured value validation, honest derivation',()=>{
 const {memory,profile}=setup()
 try {
 for (const value of [{calendar:'solar',year:2001,month:2,day:29},{calendar:'lunar',month:3,day:31},{calendar:'solar',month:13,day:1},{calendar:'solar',month:1,day:1,leap:true}]) assert.throws(()=>profile.saveEntry({category:'basic',field:'birthday',value:value as unknown as ProfileValue}),ProfileError)
 const e=profile.saveEntry({category:'basic',field:'birthday',value:{calendar:'solar',year:2000,month:1,day:1}})
 assert.equal(profile.snapshot().derived[0].age,new Date().getFullYear()-2000)
 assert.equal(profile.snapshot().derived[0].sunSign,'摩羯座')
 profile.saveEntry({id:e.id,expectedRevision:e.revision,category:'basic',field:'birthday',value:{calendar:'lunar',year:2000,month:1,day:1}})
 assert.ok(profile.snapshot().derived[0].age !== undefined || profile.snapshot().derived[0].unsupported)
 assert.throws(()=>profile.saveEntry({...hobby,field:'__proto__'}),ProfileError)
 assert.throws(()=>profile.saveEntry({category:'basic',field:'age',value:{years:300,asOf:'2020-01-01'}}),ProfileError)
 profile.saveEntry({category:'experience',field:'experience',value:{organization:'Example',role:'Engineer',start:'2020-01',end:'2022-02'}})
 }finally{memory.close()}
})
test('reopening migration preserves canonical profile',()=>{
 const dir=mkdtempSync(join(tmpdir(),'jarvis-profile-')),file=join(dir,'memory.sqlite')
 try {let memory=new MemoryStore({file});let profile=new ProfileStore(memory);const e=profile.saveEntry(hobby);memory.close();memory=new MemoryStore({file});profile=new ProfileStore(memory);assert.equal(profile.snapshot().entries[0].memoryId,e.memoryId);assert.equal(memory.stats().total,1);memory.close()}finally{rmSync(dir,{recursive:true,force:true})}
})
test('in-flight inference cannot survive edits or erase',async()=>{
 let resolve!: (value:null)=>void
 const memory=new MemoryStore({file:':memory:',embedder:{model:'delayed',embed:()=>new Promise(r=>{resolve=r})}})
 const profile=new ProfileStore(memory)
 try {const pending=memory.add({kind:'semantic',content:'待定偏好',sourceKind:'inferred',sourceRef:'session:old'});profile.saveEntry(hobby);resolve(null);await assert.rejects(pending,/cancelled/);assert.equal(memory.stats().total,1)}finally{memory.close()}
})
test('observed memories reference existing rows and locked fields resist proposals',async()=>{
 const {memory,profile}=setup()
 try {const item=await memory.add({kind:'semantic',content:'我喜欢游泳',sourceKind:'inferred',sourceRef:'conversation:1'});const observed=profile.observeMemory(item)!;assert.equal(observed.memoryId,item.id);assert.equal(observed.status,'proposed');assert.equal(memory.stats().total,1);memory.confirm(item.id);assert.equal(profile.snapshot().entries[0].status,'confirmed');profile.saveEntry({...hobby});await assert.rejects(memory.add({kind:'semantic',content:'我喜欢旅行',sourceKind:'inferred',sourceRef:'conversation:2'}),/user-locked/)}finally{memory.close()}
})
