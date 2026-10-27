import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {LocalToolSettings} from '../src/local-tools/settings.ts'
import {FileTools} from '../src/local-tools/files.ts'
import {SessionStore} from '../src/sessions.ts'
import {ToolJournal} from '../src/tool-journal.ts'
import {ToolRuntime} from '../src/tools.ts'
import {EventBus} from '../src/events.ts'

test('catalog failure after artifact publication yields unknown and replay never writes again',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'jarvis-uncertain-')),settings=new LocalToolSettings(join(dir,'data','settings.json'),join(dir,'artifacts'));await settings.load()
 const catalog=join(dir,'data','catalog.json'),files=new FileTools({settings,storageFile:catalog});files.artifacts('load-empty-catalog')
 // A directory at the destination makes the final catalog rename fail after file publication.
 await mkdir(catalog)
 const sessions=new SessionStore({file:':memory:'}),journal=new ToolJournal(sessions),bus=new EventBus()
 const definitions=files.definitions().map(d=>({...d,permission:'allow' as const})),runtime=new ToolRuntime({definitions:()=>definitions,journal,bus})
 t.after(async()=>{await runtime.quiesce();sessions.close()})
 const sessionId=sessions.create().id,turnId='turn';sessions.beginTurn(sessionId,turnId,'create','test')
 const key={sessionId,turnId,step:0},call={id:'uncertain',name:'artifact_create',arguments:JSON.stringify({name:'published.txt',content:'published once'})}
 journal.beginStep(key);journal.recordAssistant({...key,text:'',toolCalls:[call]})
 const input={...key,call,signal:new AbortController().signal,allowedDefinitions:new Map(definitions.map(d=>[d.name,d.definitionHash])),allowRemote:false,allowLocalResults:true}
 assert.equal((await runtime.execute(input)).status,'unknown');assert.equal(await readFile(join(dir,'artifacts','published.txt'),'utf8'),'published once')
 assert.equal((await runtime.execute(input)).status,'unknown');assert.equal(journal.getCall(sessionId,turnId,call.id)!.status,'unknown')
 assert.equal(await readFile(join(dir,'artifacts','published.txt'),'utf8'),'published once')
})
