import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { TaskTools } from '../src/local-tools/tasks.ts'
import { EventBus } from '../src/events.ts'

function fixture(shellEnabled=false){
  const root=mkdtempSync(join(tmpdir(),'jarvis-tasks-')),privateDir=join(root,'private'),outputDir=join(privateDir,'artifacts')
  mkdirSync(outputDir,{recursive:true})
  const file=join(privateDir,'tasks.db'),bus=new EventBus()
  const settings={revision:1,shellEnabled,readRoots:[] as string[],writeRoots:[] as string[],outputDir,skillsDir:null}
  const tools=new TaskTools({file,bus,settings:{snapshot:()=>structuredClone(settings)}})
  const ctx=(sessionId='s',signal=new AbortController().signal)=>({sessionId,turnId:'turn',callId:'call',signal})
  const execute=(name:string,args:Record<string,unknown>,context=ctx())=>{const definition=tools.definitions().find(d=>d.name===name);assert.ok(definition,`${name} available`);return definition.execute(args,context)}
  return {root,file,outputDir,bus,settings,tools,ctx,execute}
}
const questions=[{id:'mode',question:'Which mode?',options:[{label:'one'},{label:'two',description:'second'}]},{id:'notes',question:'Any notes?'}]
const valid={answers:[{id:'mode',selected:['one']},{id:'notes',selected:[],custom:'Private note'}]}

test('structured questions validate identity and full answers; resolve once, independently of permissions',async()=>{
  const f=fixture();try{
    const d=f.tools.definitions().find(d=>d.name==='ask_user_question')!
    assert.equal(d.permission,'allow');assert.equal(d.effect,'read');assert.equal(d.usage,'local');assert.equal(d.timeoutMs,240000)
    const promise=f.execute('ask_user_question',{questions})
    const [q]=f.tools.pendingQuestions();assert.ok(q);assert.equal(q.sessionId,'s')
    assert.equal(f.tools.answer(q.id,{sessionId:'foreign',turnId:'turn'},valid),false)
    assert.equal(f.tools.answer(q.id,{sessionId:'s',turnId:'old'},valid),false)
    for(const bad of [{answers:[]},{answers:[{id:'mode',selected:['bad']},{id:'notes',selected:[],custom:'x'}]},{answers:[{id:'mode',selected:['one','two']},{id:'notes',selected:[],custom:'x'}]},{answers:[{id:'mode',selected:['one']},{id:'mode',selected:['two']}]},{answers:[{id:'mode',selected:['one']},{id:'notes',selected:[]}]},{...valid,extra:true}])assert.equal(f.tools.answer(q.id,{sessionId:'s',turnId:'turn'},bad),false)
    q.questions[0]!.question='mutation';assert.equal(f.tools.pendingQuestions()[0]!.questions[0]!.question,'Which mode?')
    assert.equal(f.tools.answer(q.id,{sessionId:'s',turnId:'turn'},valid),true)
    assert.deepEqual(JSON.parse((await promise).content).answers,valid.answers)
    assert.equal(f.tools.answer(q.id,{sessionId:'s',turnId:'turn'},valid),false)
    assert.equal(f.tools.pendingQuestions().length,0)
    const history=f.tools.exportSession('s').questions;assert.equal(history[0]!.status,'answered');assert.deepEqual(history[0]!.answers,valid)
    assert.equal(statSync(f.file).mode&0o777,0o600)
    assert.ok(f.bus.history().some(e=>e.type==='task.question.resolved'))
  }finally{await f.tools.close()}
})

test('question abort, timeout, close and validation never accept late answers',async t=>{
  const f=fixture();try{
    for(const qs of [[],Array(5).fill(questions[0]),[questions[0],questions[0]],[{id:'q',question:'?',options:[{label:'same'},{label:'same'}]}]])await assert.rejects(f.execute('ask_user_question',{questions:qs}),/Invalid questions/)
    const aborted=new AbortController();aborted.abort();await assert.rejects(f.execute('ask_user_question',{questions},f.ctx('s',aborted.signal)),/cancelled/)
    assert.equal(f.tools.pendingQuestions().length,0)
    const controller=new AbortController(),promise=f.execute('ask_user_question',{questions},f.ctx('s',controller.signal)),q=f.tools.pendingQuestions()[0]!
    controller.abort();assert.equal(JSON.parse((await promise).content).status,'cancelled');assert.equal(f.tools.answer(q.id,{sessionId:'s',turnId:'turn'},valid),false)
    t.mock.timers.enable({apis:['setTimeout','Date'],now:1000})
    const expiring=f.execute('ask_user_question',{questions}),id=f.tools.pendingQuestions()[0]!.id
    t.mock.timers.tick(120001);assert.equal(JSON.parse((await expiring).content).status,'expired');assert.equal(f.tools.answer(id,{sessionId:'s',turnId:'turn'},valid),false)
    t.mock.timers.reset()
    const closing=f.execute('ask_user_question',{questions});await f.tools.close();assert.equal(JSON.parse((await closing).content).status,'cancelled')
  }finally{await f.tools.close()}
})

test('plans replace complete lists and are session-owned; erase removes task history',async()=>{
  const f=fixture();try{
    await f.execute('todo_write',{todos:[{content:'First',status:'pending'},{content:'Second',status:'completed'}]})
    await f.execute('todo_write',{todos:[{content:'Replacement',status:'in_progress'}]})
    assert.deepEqual(f.tools.plan('s').todos,[{content:'Replacement',status:'in_progress'}]);assert.deepEqual(f.tools.plan('other').todos,[])
    await assert.rejects(f.execute('todo_write',{todos:[{content:'Bad',status:'unknown'}]}),/Invalid/)
    const pending=f.execute('ask_user_question',{questions})
    await f.tools.clearSession('s');await pending;assert.deepEqual(f.tools.plan('s').todos,[]);assert.deepEqual(f.tools.exportSession('s').questions,[])
    await f.execute('todo_write',{todos:[{content:'Again',status:'pending'}]});await f.tools.clearAll();assert.deepEqual(f.tools.plan('s').todos,[])
  }finally{await f.tools.close()}
})

test('restart cancels pending questions and marks unfinished jobs interrupted without resuming',async()=>{
  const f=fixture();await f.tools.close()
  const db=new DatabaseSync(f.file)
  db.prepare('INSERT INTO questions VALUES(?,?,?,?,?,NULL,?,?,?)').run('q','s','t','c',JSON.stringify(questions),'pending',Date.now()+120000,Date.now())
  db.prepare('INSERT INTO jobs(id,session_id,turn_id,call_id,command,workdir,status,pid,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('j','s','t','c','false',f.outputDir,'running',123,Date.now(),Date.now());db.close()
  const reopened=new TaskTools({file:f.file,bus:f.bus,settings:{snapshot:()=>f.settings}})
  try{assert.deepEqual(reopened.pendingQuestions(),[]);assert.equal(reopened.exportSession('s').questions[0]!.status,'cancelled');assert.equal(reopened.jobs('s')[0]!.status,'interrupted');assert.equal('pid' in reopened.jobs('s')[0]!,false);assert.equal(reopened.cancelJob('j','foreign'),false);assert.equal(reopened.cancelJob('missing','foreign'),false)}finally{await reopened.close()}
})

test('shell is fail-closed until actual bubblewrap passes its capability probe',async()=>{
  const f=fixture();try{
    assert.equal(f.tools.definitions().some(d=>d.name==='shell_execute'),false)
    f.settings.shellEnabled=true;assert.equal(f.tools.status().shellAvailable,false)
    await f.tools.initialize();assert.equal(f.tools.definitions().some(d=>d.name==='shell_execute'),f.tools.status().shellAvailable)
    assert.ok(f.tools.status().reason)
    const hostCapability=f.tools.status().shellAvailable
    f.settings.shellEnabled=false;assert.equal(f.tools.definitions().some(d=>d.name==='shell_execute'),false)
    assert.equal(f.tools.status().shellAvailable,hostCapability);assert.equal(f.tools.status().shell.enabled,false);assert.equal(f.tools.status().shell.available,false)
    const unknown=await f.execute('job_output',{id:'unknown'},f.ctx('foreign'));assert.deepEqual(JSON.parse(unknown.content),{error:'Job not found',status:404})
  }finally{await f.tools.close()}
})

test('real sandbox has empty environment, network isolation, bounded output and owner cancellation',async t=>{
  const f=fixture(true);try{
    await f.tools.initialize();if(!f.tools.status().shellAvailable){t.skip(f.tools.status().reason);return}
    const d=f.tools.definitions().find(d=>d.name==='shell_execute')!;assert.equal(d.permission,'ask');assert.equal(d.effect,'write')
    process.env.JARVIS_TEST_SECRET='do-not-inherit'
    const run=JSON.parse((await f.execute('shell_execute',{command:'printf "%s" "${JARVIS_TEST_SECRET-unset}"; test ! -e /etc/passwd; printf safe > result.txt'})).content)
    delete process.env.JARVIS_TEST_SECRET
    assert.equal(run.status,'succeeded');assert.equal(run.output,'unset');assert.equal(readFileSync(join(f.outputDir,'result.txt'),'utf8'),'safe')
    const network=JSON.parse((await f.execute('shell_execute',{command:'readlink /proc/self/ns/net'})).content);assert.notEqual(network.output.trim(),readlinkSync('/proc/self/ns/net'))
    const preabort=new AbortController();preabort.abort();const before=f.tools.jobs('s').length;await assert.rejects(f.execute('shell_execute',{command:'touch should-not-exist'},f.ctx('s',preabort.signal)),/cancelled/);assert.equal(f.tools.jobs('s').length,before)
    const escape=JSON.parse((await f.execute('shell_execute',{command:`test ! -e '${f.file}'; test ! -e /home/gh503/.ssh`})).content);assert.equal(escape.status,'succeeded')
    const huge=JSON.parse((await f.execute('shell_execute',{command:'head -c 100000 /dev/zero | tr "\\0" x'})).content);assert.equal(huge.output.length,65536);assert.equal(huge.outputBytes,100000);assert.equal(statSync(huge.spillFile).mode&0o777,0o600)
    const running=JSON.parse((await f.execute('shell_execute',{command:'sleep 30',runInBackground:true})).content);assert.equal(f.tools.cancelJob(running.id,'foreign'),false);const cancelledAt=Date.now();assert.equal(f.tools.cancelJob(running.id,'s'),true);await f.tools.quiesce();assert.ok(Date.now()-cancelledAt<5000,'cancel kills the sandbox promptly');assert.equal(f.tools.jobs('s').find(j=>j.id===running.id)!.status,'cancelled')
    assert.deepEqual(f.tools.jobs('foreign'),[])
    f.settings.readRoots=[join(f.root,'private')];f.settings.writeRoots=[f.root]
    const fileGrants=JSON.parse((await f.execute('shell_execute',{command:`test ! -e '${f.file}' && test ! -e '${f.root}/private/task-output'`})).content);assert.equal(fileGrants.status,'succeeded')
    await assert.rejects(f.execute('shell_execute',{command:'true',workdir:f.root}),/not approved/)
    await assert.rejects(f.execute('shell_execute',{command:'true',workdir:join(f.root,'private')}),/not approved/)
    await f.tools.clearAll();assert.equal(existsSync(huge.spillFile),false)
  }finally{delete process.env.JARVIS_TEST_SECRET;await f.tools.close()}
})
