import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NativeFilesystem, nativeFilesystemExecutable } from '../src/local-tools/native-filesystem.ts'

test('native executable resolves inside the application bundle', () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const name = process.platform === 'win32' ? 'jarvis-scoped-fs.exe' : 'jarvis-scoped-fs'
  const packaged = join(root, 'runtime', name)
  assert.equal(nativeFilesystemExecutable(), existsSync(packaged) ? packaged : join(root, 'native', 'dist', name))
})
test('native transport rejects missing helper and wrong protocol', async () => {
  await assert.rejects(NativeFilesystem.start([], { executable: join(tmpdir(), 'jarvis-missing-helper-does-not-exist') }))
  await assert.rejects(NativeFilesystem.start([], { executable: process.execPath, args: ['-e', `process.stdin.once('data',()=>console.log(JSON.stringify({version:2,seq:1,ok:true,result:{}})))`] }), /INVALID_RESPONSE/)
})
test('native transport kills stalled child and rejects malformed or oversized responses', async () => {
  await assert.rejects(NativeFilesystem.start([], { executable: process.execPath, args: ['-e', 'process.stdin.resume()'], timeoutMs: 100 }), /HELPER_TIMEOUT/)
  for (const script of ["process.stdin.once('data',()=>console.log('not-json'))", "process.stdin.once('data',()=>process.stdout.write('x'.repeat(12*1024*1024+1)))", "process.stdin.once('data',()=>console.log(JSON.stringify({version:1,seq:99,ok:true,result:{}})))"]) {
    await assert.rejects(NativeFilesystem.start([], { executable: process.execPath, args: ['-e', script] }), /INVALID_RESPONSE|RESPONSE_TOO_LARGE/)
  }
})
test('native transport serializes requests and invalidates closed roots', async t => {
  const script = `const readline=require('node:readline');let seq=0;readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.seq!==++seq)process.exit(2);const result=r.op==='hello'?{protocolVersion:1,capabilities:['read','list'],maxRequestBytes:65536,maxReadBytes:8388608,maxListEntries:1000}:r.op==='init'?{roots:[{token:'opaque'}]}:r.op==='read'?{dataBase64:'aGk=',bytes:2}:r.op==='list'?{entries:[],truncated:false}:{};console.log(JSON.stringify({version:1,seq:r.seq,ok:true,result}))})`
  const { filesystem, roots } = await NativeFilesystem.start([tmpdir()], { executable: process.execPath, args: ['-e', script] })
  t.after(() => filesystem.dispose())
  const [read, list] = await Promise.all([filesystem.read(roots[0]!, ['file']), filesystem.list(roots[0]!)])
  assert.equal(read.toString(), 'hi'); assert.deepEqual(list, { entries: [], truncated: false })
  await filesystem.closeRoot(roots[0]!)
  await assert.rejects(filesystem.read(roots[0]!, ['file']), /INVALID_ROOT_TOKEN/)
})
test('native helper pinned read/list rejects escape, hardlinks and byte overflow', async t => {
  if (!existsSync(nativeFilesystemExecutable())) {
    assert.notEqual(process.env.JARVIS_NATIVE_HELPER_REQUIRED, '1', 'Native acceptance requires a built helper')
    t.skip('Build native helper with npm run native:build before native acceptance'); return
  }
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-native-fs-'))
  // macOS temp paths commonly contain a system symlink; register its actual directory.
  const { realpath } = await import('node:fs/promises')
  const root = await realpath(directory)
  t.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(join(root, 'nested'))
  await writeFile(join(root, 'nested', 'hello.txt'), 'hello λ')
  await writeFile(join(root, 'large.txt'), '12345')
  await writeFile(join(root, 'hard-original.txt'), 'private')
  await link(join(root, 'hard-original.txt'), join(root, 'hard-copy.txt'))
  const { filesystem, roots } = await NativeFilesystem.start([root])
  t.after(() => filesystem.dispose())
  const token = roots[0]!
  assert.equal((await filesystem.read(token, ['nested', 'hello.txt'])).toString(), 'hello λ')
  const listing = await filesystem.list(token)
  assert.ok(listing.entries.some(entry => entry.name === 'nested' && entry.kind === 'directory'))
  assert.equal((await filesystem.list(token, [], 1)).truncated, true)
  await assert.rejects(filesystem.read(token, ['large.txt'], 4))
  await assert.rejects(filesystem.read(token, ['hard-copy.txt']))
  await assert.rejects(filesystem.read(token, ['nested']))
  await assert.rejects(filesystem.read('stale-token', ['large.txt']), /INVALID_ROOT_TOKEN/)
  for (const component of ['..', '.', '', 'nested/hello.txt', 'nested\\hello.txt', '\0']) await assert.rejects(filesystem.read(token, [component]), /INVALID_COMPONENT/)
  // Directory junction creation on Windows does not require symlink privilege.
  await symlink(join(root, 'nested'), join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(filesystem.read(token, ['alias', 'hello.txt']))
  await filesystem.closeRoot(token)
  await assert.rejects(filesystem.list(token), /INVALID_ROOT_TOKEN/)
})
