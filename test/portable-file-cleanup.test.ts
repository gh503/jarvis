import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalToolSettings } from '../src/local-tools/settings.ts'
import { FileTools } from '../src/local-tools/files.ts'

// Runs the portable branch on Linux and the native implementation on macOS/Windows.
for(const platform of process.platform==='linux'?['darwin','win32']:[process.platform]){
  test(`${platform}: fresh private workspace supports session deletion and erase`,async()=>{
    const descriptor=Object.getOwnPropertyDescriptor(process,'platform')!
    Object.defineProperty(process,'platform',{value:platform,configurable:true})
    try{
      const root=mkdtempSync(join(tmpdir(),'jarvis-cleanup-')),file=join(root,'data','settings.json'),output=join(root,'output')
      const settings=new LocalToolSettings(file,output);await settings.load();const files=new FileTools({settings})
      files.clearSession('first');files.clearAll();assert.deepEqual(files.artifacts('first'),[])
      mkdirSync(join(root,'data','file-history'));writeFileSync(join(root,'data','local-files.json'),'[]')
      files.clearSession('second');files.clearAll()
      assert.equal(readFileSync(join(root,'data','local-files.json'),'utf8'),'[]')
      // An absent private workspace is also safe: no cleanup is needed.
      const absent=new FileTools({settings:{file,snapshot:()=>({...settings.snapshot(),outputDir:join(root,'absent')})} as LocalToolSettings,storageFile:join(root,'empty','catalog.json')})
      absent.clearSession('third');absent.clearAll()
    }finally{Object.defineProperty(process,'platform',descriptor)}
  })
  test(`${platform}: populated output, history, and uncached catalog fail without removing data`,async()=>{
    const descriptor=Object.getOwnPropertyDescriptor(process,'platform')!
    Object.defineProperty(process,'platform',{value:platform,configurable:true})
    try{
      for(const location of ['output','history','catalog']){
        const root=mkdtempSync(join(tmpdir(),'jarvis-cleanup-')),settings=new LocalToolSettings(join(root,'data','settings.json'),join(root,'output'));await settings.load()
        const files=new FileTools({settings});assert.deepEqual(files.artifacts('session'),[])
        const path=location==='output'?join(root,'output','secret'):location==='history'?join(root,'data','file-history','backup.json'):join(root,'data','local-files.json')
        if(location==='history')mkdirSync(join(root,'data','file-history'))
        const content=location==='catalog'?'[{"sessionId":"session","managed":true}]':'private content';writeFileSync(path,content)
        for(const clear of [()=>files.clearSession('session'),()=>files.clearAll()])assert.throws(clear,{code:'SCOPED_FILESYSTEM_UNAVAILABLE'})
        assert.equal(readFileSync(path,'utf8'),content)
      }
    }finally{Object.defineProperty(process,'platform',descriptor)}
  })
  test(`${platform}: linked private workspace is rejected`,{skip:process.platform==='win32'},async()=>{
    const descriptor=Object.getOwnPropertyDescriptor(process,'platform')!
    Object.defineProperty(process,'platform',{value:platform,configurable:true})
    try{
      const root=mkdtempSync(join(tmpdir(),'jarvis-cleanup-')),settings=new LocalToolSettings(join(root,'data','settings.json'),join(root,'output'));await settings.load()
      const elsewhere=join(root,'elsewhere');mkdirSync(elsewhere);symlinkSync(elsewhere,join(root,'data','file-history'),'dir')
      const files=new FileTools({settings});assert.throws(()=>files.clearAll(),{code:'SCOPED_FILESYSTEM_UNAVAILABLE'})
    }finally{Object.defineProperty(process,'platform',descriptor)}
  })
}
