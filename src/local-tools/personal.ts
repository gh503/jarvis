import { createHash } from 'node:crypto'
import type { MemoryStore } from '../memory/store.ts'
import type { MemoryItem } from '../memory/types.ts'
import { ProfileStore } from '../profile.ts'
import type { SessionStore } from '../sessions.ts'
import type { ToolDefinition } from '../tools.ts'

type Context = Parameters<ToolDefinition['execute']>[1]
export interface PersonalToolOptions {
  memory: MemoryStore
  sessions: SessionStore
  profile?: ProfileStore
  inspectScreen?: (prompt: string, signal: AbortSignal) => Promise<string>
  inspectCamera?: (prompt: string, signal: AbortSignal) => Promise<string>
  onMemoryMutation?: () => void
}
const stringSchema = (maxLength: number) => ({type:'string', minLength:1, maxLength})
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error('Invalid text argument')
  return value
}
function integer(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max) throw new Error('Invalid integer argument')
  return Number(value)
}
function view(item: MemoryItem) {
  return {id:item.id, content:item.content, status:item.status, sourceKind:item.sourceKind, sourceRef:item.sourceRef,
    sourceSpan:item.sourceSpan, trust:item.trust, updatedAt:item.updatedAt}
}

/** Personal capabilities are local results, even when an individual entry permits sharing. */
export function personalTools(options: PersonalToolOptions): ToolDefinition[] {
  const {memory, sessions} = options
  // Also detect profile-backed rows when the optional profile capability is not exposed.
  const profileGuard = options.profile ?? new ProfileStore(memory)
  const ordinary = (id: string, expected?: unknown): MemoryItem => {
    const item = memory.get(id)
    if (!item || item.sensitivity !== 'standard' || !memory.active(item)
      || profileGuard.snapshot().entries.some(entry => entry.memoryId === id)) throw new Error('Memory unavailable')
    if (expected !== undefined && item.updatedAt !== text(expected, 100)) throw new Error('Memory changed; read it again before editing')
    return item
  }
  const invalidateSource = (item: MemoryItem) => {
    if (item.sourceRef.startsWith('turn:')) sessions.excludeTurnFromContext(item.sourceRef.slice(5))
    sessions.invalidateSummaries()
    options.onMemoryMutation?.()
  }
  const define = (name: string, description: string, properties: Record<string,unknown>, required: string[],
    permission: ToolDefinition['permission'], effect: ToolDefinition['effect'], run: (args:Record<string,unknown>,ctx:Context,beginMutation:()=>void)=>Promise<unknown>): ToolDefinition => {
    const parameters = {type:'object', properties, required, additionalProperties:false}
    const boundary = {name, description, parameters, permission, effect, usage:'local' as const, destination:'local' as const}
    return {...boundary, definitionHash:createHash('sha256').update(JSON.stringify({version:1,...boundary})).digest('hex'),
      execute:async(args,ctx)=>{
        let mutationStarted=false
        try {
          ctx.signal.throwIfAborted()
          if (Object.keys(args).some(key=>!Object.hasOwn(properties,key))) throw new Error('Unknown argument')
          const result = await run(args,ctx,()=>{ctx.signal.throwIfAborted();mutationStarted=true})
          ctx.signal.throwIfAborted()
          return {content:JSON.stringify(result)}
        } catch {
          // A store or post-write invalidation can fail after committing. Let the
          // runtime journal this as unknown instead of claiming a definite failure.
          if (mutationStarted) throw new Error('Personal mutation outcome is uncertain; verify state before retrying')
          return {content:'Personal tool unavailable, invalid arguments, or concurrent change; no private details returned.',isError:true}
        }
      }}
  }
  const tools: ToolDefinition[] = [
    define('memory_read','Read an active ordinary memory with provenance.',{id:stringSchema(256)},['id'],'allow','read',async args=>view(ordinary(text(args.id,256)))),
    define('memory_propose','Propose a low-trust memory from an exact quote in this user turn. Requires approval.',
      {content:stringSchema(8000),evidence:stringSchema(8000)},['content','evidence'],'ask','write',async(args,ctx,beginMutation)=>{
        const content=text(args.content,8000), evidence=text(args.evidence,8000), pair=sessions.getTurn(ctx.turnId)
        if (!pair || pair.user.sessionId !== ctx.sessionId || pair.assistant.sessionId !== ctx.sessionId
          || pair.user.status !== 'complete' || pair.assistant.status !== 'streaming'
          || pair.user.metadata?.contextExcluded === true || pair.assistant.metadata?.contextExcluded === true
          || !pair.user.content.includes(evidence) || !evidence.includes(content)) throw new Error('Evidence must be current user text')
        beginMutation()
        const item=await memory.add({kind:'semantic',content,sourceKind:'inferred',sourceRef:`turn:${ctx.turnId}`,
          sourceSpan:evidence,status:'proposed',trust:'low',confidence:0.4,sensitivity:'standard'})
        options.onMemoryMutation?.()
        return view(item)
      }),
    define('memory_correct','Correct an ordinary memory after approval; requires the last read updatedAt.',
      {id:stringSchema(256),content:stringSchema(8000),expectedUpdatedAt:stringSchema(100)},['id','content','expectedUpdatedAt'],'ask','write',async(args,_ctx,beginMutation)=>{
        const content=text(args.content,8000), old=ordinary(text(args.id,256),text(args.expectedUpdatedAt,100))
        beginMutation()
        const item=await memory.edit(old.id,content)
        if (!item) throw new Error('Memory unavailable')
        invalidateSource(old)
        return view(item)
      }),
    define('memory_forget','Forget an ordinary memory after approval, blocking its inferred restoration.',
      {id:stringSchema(256),expectedUpdatedAt:stringSchema(100)},['id','expectedUpdatedAt'],'ask','write',async(args,_ctx,beginMutation)=>{
        const old=ordinary(text(args.id,256),text(args.expectedUpdatedAt,100))
        beginMutation()
        if (!memory.delete(old.id)) throw new Error('Memory unavailable')
        invalidateSource(old)
        return {id:old.id,deleted:true}
      }),
  ]
  if (options.profile) tools.push(define('profile_read','Read confirmed profile fields permitted for local context; display-only entries stay private.',
    {fields:{type:'array',items:stringSchema(100),maxItems:30,uniqueItems:true}},[],'allow','read',async(args,ctx)=>{
      if (args.fields !== undefined && (!Array.isArray(args.fields) || args.fields.length>30)) throw new Error('Invalid fields')
      const fields=(args.fields as unknown[]|undefined)?.map(field=>text(field,100))
      return options.profile!.context({remote:false,scope:ctx.sessionId,maxChars:8000})
        .filter(entry=>!fields || fields.includes(entry.field))
        .map(entry=>({id:entry.id,memoryId:entry.memoryId,field:entry.field,value:entry.value,content:entry.content,
          sourceRef:entry.sourceRef,sourceKind:entry.sourceKind,updatedAt:entry.updatedAt}))
    }))

  // Query only transcript messages: never tool requests, approvals, results, or summary caches.
  // Eligibility is a whole successful pair and both sides must remain usable as context.
  const eligible = `FROM messages m JOIN sessions s ON s.id=m.session_id
    JOIN messages u ON u.turn_id=m.turn_id AND u.role='user' AND u.session_id=m.session_id
    JOIN messages a ON a.turn_id=m.turn_id AND a.role='assistant' AND a.session_id=m.session_id
    WHERE u.status='complete' AND a.status='complete'
      AND coalesce(json_extract(u.metadata,'$.contextExcluded'),0)<>1
      AND coalesce(json_extract(a.metadata,'$.contextExcluded'),0)<>1`
  // Automatic titles copy the first user turn, which may since have been excluded.
  const select = `SELECT m.id AS messageId,m.session_id AS sessionId,
    CASE WHEN s.title_explicit=1 THEN s.title ELSE 'Session' END AS title,m.role,
    substr(m.content,1,500) AS excerpt,substr(m.source,1,100) AS source,m.created_at AS timestamp `
  const beforeSchema={type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER}
  const page = (where:string,params:Array<string|number>,limit:number,before:number) => {
    const rows=sessions.databaseForTools().prepare(`${select}${eligible}${where} AND m.id<? ORDER BY m.id DESC LIMIT ?`).all(...params,before,limit+1)
    const items=rows.slice(0,limit)
    return {items,nextBefore:rows.length>limit ? Number(items.at(-1)!.messageId) : null}
  }
  tools.push(
    define('session_search','Search completed, privacy-eligible messages across local sessions. before is an exclusive message ID cursor.',
      {query:stringSchema(1000),limit:{type:'integer',minimum:1,maximum:10},before:beforeSchema},['query'],'allow','read',async args=>{
        const query=text(args.query,1000), pattern=`%${query.replace(/[\\%_]/g,'\\$&')}%`
        return page(" AND m.content LIKE ? ESCAPE '\\'",[pattern],integer(args.limit,10,10),integer(args.before,Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER))
      }),
    define('session_read','Read bounded excerpts of completed, privacy-eligible local session messages; optionally select one message ID.',
      {sessionId:stringSchema(256),messageId:beforeSchema,limit:{type:'integer',minimum:1,maximum:20},before:beforeSchema},['sessionId'],'allow','read',async args=>{
        const id=text(args.sessionId,256), params:Array<string|number>=[id]
        let where=' AND m.session_id=?'
        if (args.messageId !== undefined) {where+=' AND m.id=?';params.push(integer(args.messageId,1,Number.MAX_SAFE_INTEGER))}
        return page(where,params,integer(args.limit,20,20),integer(args.before,Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER))
      }),
  )
  for (const [name,capture] of [['screen_inspect',options.inspectScreen],['camera_inspect',options.inspectCamera]] as const) {
    if (capture) tools.push(define(name,'Inspect a local capture with explicit approval. Results remain local.',
      {prompt:stringSchema(2000)},['prompt'],'ask','read',async(args,ctx)=>({text:(await capture(text(args.prompt,2000),ctx.signal)).slice(0,10000)})))
  }
  return tools
}
