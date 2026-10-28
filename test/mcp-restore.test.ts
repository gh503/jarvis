import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'

const root=resolve(import.meta.dirname,'..')
function fixture(t:test.TestContext){
  const dir=mkdtempSync(join(tmpdir(),'jarvis-mcp-restore-'))
  assert.equal(resolve(dir),dir);assert.ok(dir.startsWith(join(tmpdir(),'jarvis-mcp-restore-')))
  t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const source=join(dir,'source'),target=join(dir,'target'),archive=join(dir,'backup.tgz')
  mkdirSync(source,{mode:0o700});mkdirSync(target,{mode:0o700})
  const db=new DatabaseSync(join(source,'jarvis.db'));db.exec('CREATE TABLE marker(value TEXT)');db.close()
  const run=(script:string,...args:string[])=>spawnSync(process.execPath,['--experimental-transform-types',join(root,'scripts',script+'.ts'),...args],{encoding:'utf8',timeout:30000,env:{...process.env,JARVIS_DATA_DIR:script==='backup'?source:target}})
  const put=(directory:string,value:unknown)=>writeFileSync(join(directory,'mcp-config.json'),JSON.stringify(value))
  const read=(directory:string)=>JSON.parse(readFileSync(join(directory,'mcp-config.json'),'utf8'))
  return {dir,source,target,archive,run,put,read}
}
function success(result:ReturnType<typeof spawnSync>){assert.equal(result.status,0,String(result.stderr));return JSON.parse(String(result.stdout))}
const secret='SYNTHETIC_MCP_RESTORE_SECRET'
function settings(revision=7){return {revision,servers:[
  {id:'custom',enabled:true,transport:'stdio',command:process.execPath,args:['-e','throw new Error("MCP MUST NEVER START DURING RESTORE")'],env:{TOKEN:secret},destination:'remote',tools:{}},
  {id:'preset-qweather',enabled:true,transport:'stdio',command:process.execPath,args:['/synthetic/preset-provider.ts'],destination:'remote',tools:{},preset:{id:'qweather',version:1,mode:'read',credentials:{apiKey:secret,apiHost:'synthetic.qweatherapi.com'},validatedFingerprint:'a'.repeat(64),verifiedAt:'2026-10-27T00:00:00.000Z',lastErrorCode:'TIMEOUT'}},
]}}
function disabled(value:ReturnType<typeof settings>){
  assert.ok(value.servers.every(s=>s.enabled===false))
  assert.equal(value.servers[0].env?.TOKEN,secret)
  const preset=value.servers[1].preset!
  assert.equal(preset.credentials.apiKey,secret)
  for(const key of ['validatedFingerprint','verifiedAt','lastErrorCode'])assert.equal(Object.hasOwn(preset,key),false)
  assert.equal(preset.id,'qweather');assert.equal(preset.version,1);assert.equal(preset.mode,'read')
}

test('secret archive disables custom and preset MCP, drops verification and advances revision beyond destination',t=>{
  const f=fixture(t),incoming=settings(7),prior=settings(42)
  f.put(f.source,incoming);f.put(f.target,prior)
  success(f.run('backup',f.archive,'--include-secrets'))
  const processResult=f.run('restore',f.archive,'--yes','--force'),restored=success(processResult)
  const value=f.read(f.target);disabled(value);assert.equal(value.revision,43)
  assert.deepEqual(f.read(restored.safety),prior)
  assert.ok(restored.restored.includes('mcp-config.json'))
  assert.equal(statSync(join(f.target,'mcp-config.json')).mode&0o777,0o600)
  assert.ok(!processResult.stdout.includes(secret)&&!processResult.stderr.includes(secret))
})

test('archive without secrets disables retained destination MCP and preserves original in safety copy',t=>{
  const f=fixture(t),prior=settings(19)
  f.put(f.source,settings());f.put(f.target,prior)
  const packed=success(f.run('backup',f.archive));assert.ok(!packed.files.includes('mcp-config.json'))
  const restored=success(f.run('restore',f.archive,'--yes','--force'))
  const value=f.read(f.target);disabled(value);assert.equal(value.revision,20)
  assert.deepEqual(f.read(restored.safety),prior)
})

test('secret archive on clean target increments its revision exactly once; ordinary backup imports no credentials',t=>{
  const f=fixture(t);f.put(f.source,settings(3))
  success(f.run('backup',f.archive))
  success(f.run('restore',f.archive,'--yes','--force'))
  assert.equal(existsSync(join(f.target,'mcp-config.json')),false)
  success(f.run('backup',f.archive,'--include-secrets'))
  success(f.run('restore',f.archive,'--yes','--force'))
  disabled(f.read(f.target));assert.equal(f.read(f.target).revision,4)
})

test('invalid archived MCP schema and unsafe revisions abort before any destination change without secret diagnostics',t=>{
  const f=fixture(t),prior=settings(12);f.put(f.target,prior)
  const marker=join(f.target,'jarvis.db');writeFileSync(marker,'unchanged destination marker')
  const invalid:unknown[]=[{...settings(),revision:-1},{...settings(),revision:1.5},{...settings(),revision:Number.MAX_SAFE_INTEGER},{...settings(),servers:{}},{...settings(),servers:[settings().servers[0],settings().servers[0]]},{revision:1,servers:[{id:'bad',transport:'streamable-http',url:secret}]}]
  for(const value of invalid){
    f.put(f.source,value);success(f.run('backup',f.archive,'--include-secrets'))
    const result=f.run('restore',f.archive,'--yes','--force')
    assert.equal(result.status,1);assert.match(result.stderr,/Invalid MCP configuration/)
    assert.ok(!result.stderr.includes(secret));assert.deepEqual(f.read(f.target),prior)
    assert.equal(readFileSync(marker,'utf8'),'unchanged destination marker')
  }
})

test('invalid retained config is validated even with a valid incoming secret archive',t=>{
  const f=fixture(t);f.put(f.source,settings())
  const invalid={...settings(),revision:Number.MAX_SAFE_INTEGER};f.put(f.target,invalid)
  success(f.run('backup',f.archive,'--include-secrets'))
  const result=f.run('restore',f.archive,'--yes','--force')
  assert.equal(result.status,1);assert.match(result.stderr,/Invalid MCP configuration/)
  assert.deepEqual(f.read(f.target),invalid);assert.equal(existsSync(join(f.target,'jarvis.db')),false)
})
