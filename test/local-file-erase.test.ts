import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,readdir,stat} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {LocalToolSettings} from '../src/local-tools/settings.ts'
import {FileTools} from '../src/local-tools/files.ts'
test('privacy erase removes owned artifacts and private history, preserves imported originals',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jarvis-erase-')),root=join(dir,'root'),out=join(dir,'artifacts');await mkdir(root)
 const settings=new LocalToolSettings(join(dir,'data','settings.json'),out);await settings.load();await settings.update({expectedRevision:0,readRoots:[root],writeRoots:[root]});const files=new FileTools({settings})
 const call=async(name:string,args:Record<string,unknown>,sessionId='a')=>JSON.parse((await files.definitions().find(d=>d.name===name)!.execute(args,{sessionId,turnId:'t',callId:'c',signal:new AbortController().signal})).content)
 const path=join(root,'original.txt');await writeFile(path,'sensitive original');const before=await call('file_read',{path});await call('file_write',{path,content:'replacement',expectedVersion:before.version});await call('artifact_present',{path});const managed=await call('artifact_create',{name:'generated.txt',content:'generated'});const other=await call('artifact_create',{name:'other.txt',content:'other'},'b')
 const managedRead=await call('file_read',{path:managed.path});await call('file_edit',{path:managed.path,oldString:'generated',newString:'edited generated',expectedVersion:managedRead.version});assert.equal((await readdir(join(dir,'data','file-history'))).length,2);files.clearSession('a');assert.equal((await readdir(join(dir,'data','file-history'))).length,0);await assert.rejects(stat(managed.path));assert.equal(await readFile(path,'utf8'),'replacement');assert.equal(await readFile(other.path,'utf8'),'other');await writeFile(other.path,'edited output');await mkdir(join(out,'nested'));await writeFile(join(out,'nested','shell-file'),'private shell output');files.clearAll();assert.deepEqual(await readdir(out),[]);await assert.rejects(stat(other.path));assert.equal(await readFile(path,'utf8'),'replacement');assert.deepEqual(files.artifacts('b'),[])
})
