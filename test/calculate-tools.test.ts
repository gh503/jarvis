import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calculate, calculationTools, strictInstant, timeConvert } from '../src/local-tools/calculate.ts'
const ctx={signal:new AbortController().signal,sessionId:'test',turnId:'test',callId:'test'}
test('safe arithmetic precedence, exponentiation, and explicit precision',()=>{
  for(const [expression,result] of [['2+3*4',14],['(2+3)*4',20],['2^3^2',512],['-2^2',-4],['2^-2',.25],['0^0',1],['5%2',1],['1e2+.5',100.5]] as const)assert.equal(calculate({expression}).result,result)
  assert.match(calculate({expression:'0.1+0.2'}).precision,/no financial precision guarantee/)
})
test('injection, zero divisors, overflow and resource limits are rejected',()=>{
  for(const expression of ['process.exit()','globalThis.x=1','1;2','Math.pow(2,3)','1/0','0/0','1%0','0^-1','1e309','10^10000','(-1)^.5','('.repeat(33)+'1'+')'.repeat(33),'1+'.repeat(129)+'1','-'.repeat(40)+'1','2^'.repeat(40)+'1','1'.repeat(513)])assert.throws(()=>calculate({expression}),Error,expression)
  assert.equal(calculate({expression:'('.repeat(32)+'1'+')'.repeat(32)}).result,1)
})
test('units whitelist enforces dimensions and converts length, mass, temperature, time and storage',()=>{
  for(const [expression,fromUnit,toUnit,result] of [['1','km','m',1000],['1','kg','g',1000],['32','F','C',0],['0','C','K',273.15],['2','h','min',120],['1','GiB','MiB',1024]] as const)assert.ok(Math.abs(calculate({expression,fromUnit,toUnit}).result-result)<1e-10)
  for(const args of [{fromUnit:'m',toUnit:'kg'},{fromUnit:'USD',toUnit:'EUR'},{fromUnit:'m'},{fromUnit:'constructor',toUnit:'m'}])assert.throws(()=>calculate({expression:'1',...args}))
  assert.throws(()=>calculate({expression:'1e308',fromUnit:'km',toUnit:'mm'}))
})
test('strict instants reject rollover and ambiguous local dates',()=>{
  for(const input of ['2025-02-29T00:00:00Z','2024-04-31T00:00:00Z','2024-01-01T24:00:00Z','2024-01-01T00:00:60Z','2024-01-01T00:00:00','2024-01-01','2024-01-01T00:00:00+24:00','2024-01-01T00:00:00+01:60'])assert.throws(()=>strictInstant(input))
  assert.equal(strictInstant('2024-02-29T08:00:00+08:00').toISOString(),'2024-02-29T00:00:00.000Z')
})
test('time conversion represents DST changes, fractional offsets, weekdays and UTC',()=>{
  const before=timeConvert({instant:'2024-03-10T06:59:00Z',timeZone:'America/New_York'}),after=timeConvert({instant:'2024-03-10T07:00:00Z',timeZone:'America/New_York'})
  assert.equal(before.localISO,'2024-03-10T01:59:00.000-05:00');assert.equal(after.localISO,'2024-03-10T03:00:00.000-04:00');assert.equal(after.weekday,'Sunday')
  assert.equal(timeConvert({instant:'2024-01-01T00:00:00Z',timeZone:'Asia/Kathmandu'}).offset,'+05:45')
  assert.equal(timeConvert({instant:'2024-01-01T00:00:00+08:00',timeZone:'UTC'}).utc,'2023-12-31T16:00:00.000Z')
  assert.throws(()=>timeConvert({instant:'2024-01-01T00:00:00Z',timeZone:'+08:00'}))
})
test('definitions and separate elapsed time tool preserve read boundaries',async()=>{
  const tools=calculationTools()
  assert.deepEqual(tools.map(t=>t.definitionHash),calculationTools().map(t=>t.definitionHash))
  for(const tool of tools)assert.deepEqual([tool.permission,tool.effect,tool.usage,tool.destination],['allow','read','shared','local'])
  const result=await tools.find(t=>t.name==='time_difference')!.execute({from:'2024-03-10T00:00:00-05:00',to:'2024-03-11T00:00:00-04:00'},ctx)
  assert.equal(JSON.parse(result.content).seconds,23*3600)
  assert.equal((await tools[0]!.execute({expression:'1/0'},ctx)).isError,true)
})
