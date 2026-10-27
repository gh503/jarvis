import test from 'node:test'
import assert from 'node:assert/strict'
import { mcpCatalog,buildPresetConfig } from '../src/mcp/catalog.ts'
import { presetConfig,presetToolPolicy } from '../src/mcp/presets.ts'
import { publicConfig } from '../src/mcp/settings.ts'
const credentials=(id:string)=>Object.fromEntries(mcpCatalog.find(p=>p.id===id)!.fields.map(f=>[f.key,f.key==='apiHost'?'abc.xy.qweatherapi.com':f.key==='email'?'synthetic@example.test':f.key==='appId'?'cli_synthetic':'synthetic-test-secret']))
test('every available service has a trusted build, read allowlist and help without leaking credentials',()=>{
  assert.equal(new Set(mcpCatalog.map(p=>p.id)).size,mcpCatalog.length)
  for(const p of mcpCatalog){
    for(const link of [p.help.docsUrl,p.help.credentialsUrl,p.help.revokeUrl].filter(Boolean))assert.equal(new URL(link!).protocol,'https:')
    assert.ok(p.help.setup.length&&p.help.usage.length&&p.help.limitations.length)
    if(!p.available){assert.throws(()=>presetConfig(p.id,{},'read'));continue}
    const config=presetConfig(p.id,credentials(p.id),'read')
    assert.equal(config.enabled,false);assert.equal(config.destination,'remote');assert.ok(p.toolPolicy?.permittedReadTools?.length)
    assert.equal(presetToolPolicy(config,'surprise_delete_everything').permission,'deny')
    for(const name of p.toolPolicy!.permittedReadTools!)assert.equal(presetToolPolicy(config,name).effect,'read')
    const view=JSON.stringify(publicConfig(config));assert.ok(!view.includes('synthetic-test-secret'));assert.ok(!view.includes('synthetic@example.test'))
    assert.throws(()=>presetConfig(p.id,credentials(p.id),'write'))
    assert.throws(()=>presetConfig(p.id,{...credentials(p.id),command:'bash'},'read'))
  }
})
test('provider-specific credential destinations and transport are constant',()=>{
  const amap=buildPresetConfig('amap',{apiKey:'x&target=evil'},'read');const url=new URL(amap.url!);assert.equal(url.origin,'https://mcp.amap.com');assert.equal(url.searchParams.get('key'),'x&target=evil');assert.equal([...url.searchParams].length,1)
  for(const id of ['tavily','context7','github','notion']){const c=buildPresetConfig(id,credentials(id),'read');assert.ok(!c.url!.includes('secret'));assert.match(c.headers!.Authorization,/^Bearer /)}
  const github=buildPresetConfig('github',credentials('github'),'read');assert.equal(github.headers!['X-MCP-Readonly'],'true')
  const jira=buildPresetConfig('atlassian',credentials('atlassian'),'read');assert.equal(jira.url,'https://mcp.atlassian.com/v2/mcp');assert.match(jira.headers!.Authorization,/^Basic /)
  for(const id of ['qweather','feishu']){const c=buildPresetConfig(id,credentials(id),'read');assert.equal(c.command,process.execPath);assert.ok(!JSON.stringify(c.args).includes('synthetic-test-secret'));assert.equal(c.args![0],'--experimental-transform-types')}
})
test('weather host, account fields and control characters cannot change trusted endpoints',()=>{
  for(const apiHost of ['evil.test','qweatherapi.com.evil.test','https://abc.qweatherapi.com','abc.qweatherapi.com:443','abc.qweatherapi.com/path','127.0.0.1','abc.qweatherapi.com.'])assert.throws(()=>buildPresetConfig('qweather',{apiKey:'test',apiHost},'read'))
  for(const email of ['user:pass@example.test','x\r\nX:evil','user'])assert.throws(()=>buildPresetConfig('atlassian',{email,apiToken:'test'},'read'))
  assert.throws(()=>buildPresetConfig('github',{pat:'test\r\nX:evil'},'read'))
})
