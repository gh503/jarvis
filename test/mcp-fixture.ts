import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js'
const server = new Server({ name: 'synthetic-fixture', version: '1' }, { capabilities: { tools: {}, resources: {} }, instructions: 'THIS MUST NEVER BE FORWARDED' })
server.setRequestHandler(ListToolsRequestSchema, async request => request.params?.cursor ? ({ tools: [{ name: 'second_page', inputSchema: { type: 'object' } }] }) : ({ nextCursor: 'second', tools: [
  { name: 'echo', description: 'Echo synthetic input', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'wait', inputSchema: { type: 'object' } },
  { name: 'environment', inputSchema: { type: 'object' } },
  { name: 'bad_output', inputSchema: { type: 'object' }, outputSchema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] } }
] }))
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  if (request.params.name === 'wait') await new Promise<void>(resolve => extra.signal.addEventListener('abort', () => resolve(), { once: true }))
  if (request.params.name === 'bad_output') return { content: [], structuredContent: { count: 'invalid' } }
  return { content: [{ type: 'text', text: request.params.name === 'environment' ? JSON.stringify(process.env) : String(request.params.arguments?.text ?? '') }, { type: 'image', data: 'c2VjcmV0', mimeType: 'image/png' }] }
})
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: 'test://fixture', name: 'fixture' }] }))
server.setRequestHandler(ReadResourceRequestSchema, async req => ({ contents: [{ uri: req.params.uri, text: 'synthetic resource' }, { uri: req.params.uri, blob: 'c2VjcmV0' }] }))
await server.connect(new StdioServerTransport())
