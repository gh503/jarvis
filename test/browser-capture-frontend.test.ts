import test from 'node:test'
import assert from 'node:assert/strict'
const modulePath = '../web/browser-capture.js'
const { captureAndConfirm, stopCaptureTracks } = await import(modulePath)

test('stopCaptureTracks stops every track even if one stop throws', () => {
  const stopped: number[] = []
  stopCaptureTracks({ getTracks: () => [0,1,2].map(i => ({ stop: () => { stopped.push(i); if (i === 0) throw new Error('gone') } })) })
  assert.deepEqual(stopped, [0,1,2])
})

test('frontend refuses synthetic clicks and stale sessions before requesting camera', async () => {
  let requested = 0
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { configurable:true, value:{ userActivation:{isActive:true}, mediaDevices:{getUserMedia:()=>{requested++}} } })
  try {
    const args = {target:'camera',sessionId:'session',turnId:'turn',isCurrent:()=>true}
    await assert.rejects(captureAndConfirm({...args,event:{isTrusted:false,type:'click'}}), /点击/)
    await assert.rejects(captureAndConfirm({...args,event:{isTrusted:true,type:'click'},isCurrent:()=>false}), /会话/)
    assert.equal(requested,0)
  } finally { if (original) Object.defineProperty(globalThis,'navigator',original); else Reflect.deleteProperty(globalThis,'navigator') }
})

test('preview stops capture and requires a second trusted confirmation before upload', async () => {
  const saved = ['navigator','window','fetch','document','URL'].map(key => [key,Object.getOwnPropertyDescriptor(globalThis,key)] as const)
  let stopped = 0, uploaded = 0
  const buttons: any[] = []
  const elements: any[] = []
  const make = (tag: string): any => {
    const handlers: Record<string, (event: unknown) => void> = {}
    const element: any = { tag, style:{}, handlers, append(){}, close(){}, remove(){}, focus(){}, showModal(){}, addEventListener(name:string,fn:(event:unknown)=>void){handlers[name]=fn} }
    if(tag === 'video') Object.assign(element,{videoWidth:1,videoHeight:1,play:async()=>{},pause(){}})
    if(tag === 'canvas') Object.assign(element,{getContext:()=>({drawImage(){}}),toBlob:(cb:(blob:Blob)=>void)=>cb(new Blob(['png'],{type:'image/png'}))})
    if(tag === 'button') buttons.push(element)
    elements.push(element); return element
  }
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{userActivation:{isActive:true},mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop:()=>{stopped++}}]})}}})
  Object.defineProperty(globalThis,'window',{configurable:true,value:{isSecureContext:true}})
  Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:make,body:{append(){}}}})
  Object.defineProperty(globalThis,'URL',{configurable:true,value:{createObjectURL:()=> 'blob:preview',revokeObjectURL(){}}})
  Object.defineProperty(globalThis,'fetch',{configurable:true,value:async(url:string,options:any)=>{uploaded++; assert.match(url,/sessionId=session/);assert.equal(options.redirect,'error');return {ok:true,json:async()=>({reply:'ok'})}}})
  try {
    const pending = captureAndConfirm({event:{isTrusted:true,type:'click'},target:'camera',sessionId:'session',turnId:'turn',isCurrent:()=>true})
    for(let i=0;i<20;i++) await Promise.resolve()
    assert.equal(buttons.length,2); assert.ok(stopped >= 1); assert.equal(uploaded,0)
    buttons[1].handlers.click({isTrusted:true,type:'click'})
    assert.deepEqual(await pending,{reply:'ok'}); assert.equal(uploaded,1)
    assert.ok(elements.some(item=>item.tag==='img' && item.src==='blob:preview'))
  } finally { for (const [key,value] of saved) { if(value) Object.defineProperty(globalThis,key,value); else Reflect.deleteProperty(globalThis,key) } }
})

test('cancellation during permission wait stops a late-granted stream without upload', async () => {
  const saved = ['navigator','window','fetch'].map(key => [key,Object.getOwnPropertyDescriptor(globalThis,key)] as const)
  let grant!: (stream: unknown) => void, stopped = 0, uploaded = 0
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{userActivation:{isActive:true},mediaDevices:{getUserMedia:()=>new Promise(resolve=>{grant=resolve})}}})
  Object.defineProperty(globalThis,'window',{configurable:true,value:{isSecureContext:true}})
  Object.defineProperty(globalThis,'fetch',{configurable:true,value:()=>{uploaded++}})
  try {
    const controller = new AbortController()
    const pending = captureAndConfirm({event:{isTrusted:true,type:'click'},target:'camera',sessionId:'session',turnId:'turn',isCurrent:()=>true,signal:controller.signal})
    controller.abort(new Error('cancelled'))
    await assert.rejects(pending,/cancelled/)
    grant({getTracks:()=>[{stop:()=>{stopped++}},{stop:()=>{stopped++}}]})
    await Promise.resolve(); await Promise.resolve()
    assert.equal(stopped,2); assert.equal(uploaded,0)
  } finally { for (const [key,value] of saved) { if(value) Object.defineProperty(globalThis,key,value); else Reflect.deleteProperty(globalThis,key) } }
})
