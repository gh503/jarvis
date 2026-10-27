import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { McpManager, guardedFetch, toolName } from '../src/mcp/manager.ts'
import { McpSettings, normalize, RevisionConflict } from '../src/mcp/settings.ts'
async function fixture() { const dir = await mkdtemp(join(tmpdir(), 'jarvis-mcp-')); return { dir, file: join(dir, 'settings.json') } }
async function ready(manager: McpManager) {
  const end = Date.now() + 10_000
  while (manager.snapshot().servers[0]?.status !== 'connected') {
    if (Date.now() > end) throw new Error('Synthetic MCP connection timed out')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
test('private atomic settings enforce CAS and secret preservation/redaction', async () => {
  const f = await fixture(); const manager = new McpManager({ file: f.file })
  try {
    await manager.initialize()
    await manager.save({ id: 'fixture', transport: 'stdio', command: 'secret-command', args: ['secret-arg'], env: { TOKEN: 'secret-token' } })
    assert.equal((await stat(f.file)).mode & 0o777, 0o600)
    assert.equal(manager.snapshot().servers[0].enabled, false)
    assert.ok(!JSON.stringify(manager.snapshot()).includes('secret-'))
    await assert.rejects(manager.save({ id: 'fixture', transport: 'stdio', name: 'edit' }), RevisionConflict)
    await manager.save({ id: 'fixture', transport: 'stdio', name: 'edit', expectedRevision: 1 })
    assert.equal(JSON.parse(await readFile(f.file, 'utf8')).servers[0].env.TOKEN, 'secret-token')
    await assert.rejects(manager.remove('fixture', 1), RevisionConflict)
    await manager.save({ id: 'fixture', transport: 'stdio', env: {}, expectedRevision: 2 })
    assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')).servers[0].env, {})
    const a = new McpSettings(f.file), b = new McpSettings(f.file)
    const changes = await Promise.allSettled([a.change(3, () => {}), b.change(3, () => {})])
    assert.equal(changes.filter(x => x.status === 'fulfilled').length, 1)
  } finally { await manager.close(); await rm(f.dir, { recursive: true, force: true }) }
})
test('settings kernel lock recovers automatically after owner process crash', async () => {
  const f = await fixture()
  const child = spawn(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e',
    `import { McpSettings } from './src/mcp/settings.ts'; await new McpSettings(process.argv[1]).change(undefined, () => { process.stdout.write('held\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0); });`, f.file],
  { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'ignore'], env: {} })
  try {
    const announced = await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('Lock owner exited early') })])
    assert.equal(String(announced[0]), 'held\n')
    const inode = (await stat(`${f.file}.lock`)).ino
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
    const store = new McpSettings(f.file)
    assert.equal((await store.change(0, () => {})).revision, 1)
    assert.equal((await stat(`${f.file}.lock`)).ino, inode)
    assert.equal((await stat(`${f.file}.lock`)).mode & 0o777, 0o600)
  } finally { child.kill('SIGKILL'); await rm(f.dir, { recursive: true, force: true }) }
})
test('startup does not await enabled server connection and close cancels it', async () => {
  const f = await fixture(); const store = new McpSettings(f.file)
  await store.change(undefined, data => { data.servers.push(normalize({ id: 'slow', transport: 'stdio', enabled: true, command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] })) })
  const manager = new McpManager({ file: f.file })
  try {
    const start = Date.now(); await manager.initialize()
    assert.ok(Date.now() - start < 1000)
    assert.equal(manager.snapshot().servers[0].status, 'connecting')
    await manager.close()
    assert.equal(manager.definitions().length, 0)
  } finally { await manager.close(); await rm(f.dir, { recursive: true, force: true }) }
})
test('concurrent reconnect and remove cannot publish an orphaned connection', async () => {
  const f = await fixture(); const manager = new McpManager({ file: f.file })
  try {
    await manager.initialize()
    await manager.save({ id: 'fixture', transport: 'stdio', enabled: true, command: process.execPath, args: ['--experimental-transform-types', resolve('test/mcp-fixture.ts')] })
    await ready(manager)
    await Promise.all([manager.reconnect('fixture'), manager.remove('fixture', 1)])
    assert.deepEqual(manager.snapshot().servers, [])
    assert.deepEqual(manager.definitions(), [])
    await assert.rejects(manager.reconnect('fixture'), /missing/)
  } finally { await manager.close(); await rm(f.dir, { recursive: true, force: true }) }
})
test('URL and tool names reject unsafe input and preserve stable namespaces', () => {
  for (const url of ['http://example.com/mcp','https://user:pass@example.com','file:///tmp/a']) assert.throws(() => normalize({ id: 'x', transport: 'streamable-http', url }))
  assert.equal(toolName('x','echo'), 'mcp__x__echo')
  assert.notEqual(toolName('x','a.b'), toolName('x','a_b'))
  assert.equal(toolName('x'.repeat(48),'y'.repeat(128)).length, 64)
  assert.throws(() => toolName('x', '../bad'))
})
test('real SDK stdio smoke: tools/resources, output validation, cancellation, env isolation and invalidation', async () => {
  const f = await fixture(); const manager = new McpManager({ file: f.file })
  process.env.JARVIS_TEST_AMBIENT_SECRET = 'not-for-child'
  try {
    await manager.initialize()
    await manager.save({ id: 'fixture', transport: 'stdio', enabled: true, command: process.execPath, args: ['--experimental-transform-types', resolve('test/mcp-fixture.ts')], env: { EXPLICIT: 'yes' } })
    await ready(manager)
    const tools = manager.definitions(); const get = (name: string) => tools.find(t => t.rawName === name)!
    assert.equal(tools.length, 7)
    assert.equal(get('echo').permission, 'ask'); assert.equal(get('echo').usage, 'local'); assert.equal(get('echo').destination, 'remote'); assert.equal(get('echo').effect, 'write')
    assert.equal((await get('echo').execute({ text: 'hello' }, {})).content, 'hello')
    assert.equal((await get('echo').execute({ text: 'x'.repeat(20_000) }, {})).content.length, 16_000)
    const env = JSON.parse((await get('environment').execute({}, {})).content)
    assert.equal(env.JARVIS_TEST_AMBIENT_SECRET, undefined); assert.equal(env.SHELL, undefined); assert.equal(env.EXPLICIT, 'yes')
    assert.ok(!JSON.stringify(manager.snapshot()).includes('THIS MUST NEVER'))
    await assert.rejects(get('bad_output').execute({}, {}))
    assert.equal(get('resources_read').usage, 'local')
    assert.equal((await get('resources_read').execute({ uri: 'test://fixture' }, {})).content, 'synthetic resource')
    await assert.rejects(get('resources_read').execute({}, {}), /URI/)
    assert.match((await get('resources_list').execute({}, {})).content, /test:\/\/fixture/)
    const abort = new AbortController(); const call = get('wait').execute({}, { signal: abort.signal }); abort.abort(); await assert.rejects(call)
    const active = get('wait').execute({}, {}); const rejected = assert.rejects(active)
    await manager.save({ id: 'fixture', transport: 'stdio', enabled: false, expectedRevision: 1 }); await rejected
    assert.equal(manager.definitions().length, 0)
    await assert.rejects(get('echo').execute({ text: 'stale' }, {}), /unavailable/)
  } finally { delete process.env.JARVIS_TEST_AMBIENT_SECRET; await manager.close(); await rm(f.dir, { recursive: true, force: true }) }
})
test('real SDK streamable HTTP loopback smoke and redirect credential containment', async () => {
  const f = await fixture(); const manager = new McpManager({ file: f.file })
  const protocol = new Server({ name: 'http-fixture', version: '1' }, { capabilities: { tools: { listChanged: true } } })
  let invalidCatalogue = false, refreshing = false
  let releaseRefresh: (() => void) | undefined
  let enteredRefresh: (() => void) | undefined
  const refreshEntered = new Promise<void>(resolve => { enteredRefresh = resolve })
  protocol.setRequestHandler(ListToolsRequestSchema, async () => {
    if (refreshing) { enteredRefresh!(); await new Promise<void>(resolve => { releaseRefresh = resolve }) }
    return { tools: invalidCatalogue ? [{ name: '../invalid', inputSchema: { type: 'object' } }] : [{ name: 'ping', inputSchema: { type: 'object' } }, { name: 'checked', inputSchema: { type: 'object' }, outputSchema: { type: 'object', properties: { count: { type: refreshing ? 'string' : 'number' } }, required: ['count'] } }] }
  })
  protocol.setRequestHandler(CallToolRequestSchema, async request => request.params.name === 'checked' ? ({ content: [], structuredContent: { count: 'invalid for old generation' } }) : ({ content: [{ type: 'text', text: 'pong' }] }))
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => 'synthetic-session', enableJsonResponse: true })
  await protocol.connect(transport)
  let redirected = false
  const server = createServer(async (req, res) => {
    if (req.url === '/redirect') { res.writeHead(307, { location: '/leak' }); res.end(); return }
    if (req.url === '/leak') { redirected = true; res.end(); return }
    await transport.handleRequest(req, res)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }; const url = `http://127.0.0.1:${address.port}`
  try {
    await manager.initialize(); await manager.save({ id: 'http', transport: 'streamable-http', url: `${url}/mcp`, enabled: true, headers: { authorization: 'synthetic-secret' } }); await ready(manager)
    assert.equal((await manager.definitions()[0].execute({}, {})).content, 'pong')
    assert.ok(!JSON.stringify(manager.snapshot()).includes('synthetic-secret'))
    const oldChecked = manager.definitions().find(t => t.rawName === 'checked')!
    await assert.rejects(oldChecked.execute({}, {}), /output schema/)
    refreshing = true
    await protocol.notification({ method: 'notifications/tools/list_changed' })
    await refreshEntered
    await assert.rejects(oldChecked.execute({}, {}), /output schema/)
    releaseRefresh!()
    const refreshDeadline = Date.now() + 5000
    while (manager.definitions().find(t => t.rawName === 'checked')!.definitionHash === oldChecked.definitionHash) {
      if (Date.now() > refreshDeadline) throw new Error('Refresh not published')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await assert.rejects(oldChecked.execute({}, {}), /changed/)
    assert.match((await manager.definitions().find(t => t.rawName === 'checked')!.execute({}, {})).content, /old generation/)
    refreshing = false
    const oldHash = manager.definitions()[0].definitionHash
    invalidCatalogue = true
    await manager.reconnect('http')
    assert.equal(manager.snapshot().servers[0].status, 'disconnected')
    assert.equal(manager.definitions()[0].definitionHash, oldHash)
    await assert.rejects(manager.definitions()[0].execute({}, {}), /unavailable/)
    await assert.rejects(guardedFetch(`${url}/redirect`, { headers: { authorization: 'secret' } }), /redirects/)
    assert.equal(redirected, false)
  } finally { await manager.close(); await protocol.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(f.dir, { recursive: true, force: true }) }
})
