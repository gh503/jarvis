import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { deriveBirthday, validateBirthday, type Birthday } from './profile-dates.ts'
import { MemoryStore } from './memory/store.ts'
import type { MemoryItem, MemorySourceKind } from './memory/types.ts'

export type ProfileCategory = 'basic' | 'career' | 'interest' | 'preference' | 'goal' | 'understanding' | 'experience'
export type ProfileValue = string | number | boolean | null | { [key: string]: ProfileValue }
export interface ProfileEntry {
  id: string; memoryId: string; subjectId: string; category: ProfileCategory; field: string; value: ProfileValue; content: string
  status: 'confirmed' | 'proposed' | 'inactive'; usage: 'display' | 'local' | 'relevant'; scope: string; revision: number
  createdAt: string; updatedAt: string; sourceRef: string; sourceKind: MemorySourceKind; userLocked: boolean
}
export interface ProfileEntryInput {
  id?: string; expectedRevision?: number; subjectId?: string; category: ProfileCategory; field: string; value: ProfileValue
  content?: string; status?: ProfileEntry['status']; usage?: ProfileEntry['usage']; scope?: string
  sourceRef?: string; sourceKind?: MemorySourceKind; userLocked?: boolean
}
export interface ProfilePerson { id: string; name: string; relationship: string; revision: number }
export interface ProfilePersonInput { id?: string; expectedRevision?: number; name: string; relationship: string }
export interface ProfileSettings { learningEnabled: boolean; useEnabled: boolean }
export interface ProfileDerived { entryId: string; subjectId: string; age?: number; zodiac?: string; sunSign?: string; unsupported?: string }
export interface ProfileSnapshot { entries: ProfileEntry[]; people: ProfilePerson[]; settings: ProfileSettings; changes: Array<{id:number;entryId:string;action:string;at:string}>; derived: ProfileDerived[] }
export class ProfileError extends Error {
  readonly statusCode: 400 | 404 | 409
  constructor(message: string, statusCode: 400 | 404 | 409 = 400) { super(message); this.name = 'ProfileError'; this.statusCode = statusCode }
}
export const PROFILE_FIELDS: Record<ProfileCategory, readonly string[]> = {
  basic: ['gender','birthday','age','city'], career: ['industry','role'], interest: ['hobby'], preference: ['communication','workstyle'],
  goal: ['goal'], understanding: ['understanding','notes'], experience: ['experience'],
}
const sources = ['user-stated','user-confirmed','system-observed','inferred','external','v1-import']
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/
function identifier(value: unknown): string { if (typeof value !== 'string' || !idPattern.test(value)) throw new ProfileError('Invalid identifier'); return value }
function string(value: unknown, name: string, max = 200): string { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw new ProfileError(`Invalid ${name}`); return value.trim() }
function revision(actual: number, expected: unknown): void { if (!Number.isSafeInteger(expected) || expected !== actual) throw new ProfileError('Revision conflict; reload before saving',409) }
function object(value: unknown): value is Record<string, ProfileValue> { return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype }
function integer(value: unknown, min: number, max: number): value is number { return Number.isInteger(value) && Number(value) >= min && Number(value) <= max }
function validDate(value: unknown): value is string { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const date = new Date(`${value}T00:00:00Z`); return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === value }
function validateValue(field: string, value: unknown): ProfileValue {
  if (field === 'birthday') {
    const error = validateBirthday(value)
    if (error) throw new ProfileError(error)
    return value as ProfileValue
  }
  if (field === 'age') {
    if (!object(value) || Object.keys(value).some(k => !['years','asOf'].includes(k)) || !integer(value.years,0,150) || !validDate(value.asOf) || value.asOf > new Date().toISOString().slice(0,10)) throw new ProfileError('Age requires years 0–150 and a valid asOf date')
    return value
  }
  if (field === 'experience') {
    if (!object(value) || !Object.keys(value).length || Object.keys(value).some(k => !['title','description','startDate','endDate','start','end','organization','role','industry','location'].includes(k))) throw new ProfileError('Invalid experience')
    for (const [key,v] of Object.entries(value)) {
      string(v,key,key === 'description' ? 4000 : 200)
      if (key.endsWith('Date') && !validDate(v)) throw new ProfileError('Experience dates must be YYYY-MM-DD')
      if (['start','end'].includes(key) && (typeof v !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(v))) throw new ProfileError('Experience dates must be YYYY-MM')
    }
    if (!value.title && !value.description && !(value.organization && value.role)) throw new ProfileError('Experience needs title, description, or organization and role')
    if (value.start && value.end && String(value.start) > String(value.end)) throw new ProfileError('Experience end precedes start')
    if (value.startDate && value.endDate && String(value.startDate) > String(value.endDate)) throw new ProfileError('Experience end precedes start')
    return value
  }
  return string(value, field, ['understanding','notes','goal'].includes(field) ? 4000 : 500)
}
function derived(entry: ProfileEntry, now = new Date()): ProfileDerived | undefined {
  if (entry.field !== 'birthday' || entry.status !== 'confirmed' || !object(entry.value)) return
  return {entryId:entry.id,subjectId:entry.subjectId,...deriveBirthday(entry.value as unknown as Birthday,now)}
}

export class ProfileStore {
  private readonly db: DatabaseSync
  private readonly memory: MemoryStore
  constructor(memory: MemoryStore) { this.memory = memory; this.db = memory.databaseForProfile() }
  private transaction<T>(action: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = action(); this.db.exec('COMMIT'); return result } catch(error) { this.db.exec('ROLLBACK'); throw error } }
  private change(id: string, action: string): void { this.db.prepare('INSERT INTO profile_changes(entry_id,action,at) VALUES (?,?,?)').run(id,action,new Date().toISOString()) }
  private settings(): ProfileSettings { const row = this.db.prepare('SELECT * FROM profile_settings WHERE id=1').get(); return {learningEnabled:row?.learning_enabled !== 0,useEnabled:row?.use_enabled !== 0} }
  snapshot(): ProfileSnapshot {
    const entries = this.db.prepare('SELECT p.*,m.content,m.profile_value,m.status,m.created_at,m.updated_at,m.source_ref,m.source_kind FROM profile_entries p JOIN memory_items m ON m.id=p.memory_id ORDER BY m.created_at,p.id').all().map(row => ({
      id:String(row.id),memoryId:String(row.memory_id),subjectId:String(row.subject_id),category:row.category as ProfileCategory,field:String(row.field),value:JSON.parse(String(row.profile_value)),content:String(row.content),
      status:row.status === 'confirmed' ? 'confirmed' as const : row.status === 'proposed' ? 'proposed' as const : 'inactive' as const,usage:row.usage as ProfileEntry['usage'],scope:String(row.scope),revision:Number(row.revision),userLocked:row.user_locked === 1,
      createdAt:String(row.created_at),updatedAt:String(row.updated_at),sourceRef:String(row.source_ref),sourceKind:row.source_kind as MemorySourceKind,
    }))
    const people = this.db.prepare('SELECT * FROM profile_people ORDER BY id').all().map(row => ({id:String(row.id),name:String(row.name),relationship:String(row.relationship),revision:Number(row.revision)}))
    const changes = this.db.prepare('SELECT * FROM profile_changes ORDER BY id DESC LIMIT 200').all().map(row=>({id:Number(row.id),entryId:String(row.entry_id),action:String(row.action),at:String(row.at)}))
    return {entries,people,settings:this.settings(),changes,derived:entries.map(e=>derived(e)).filter((e): e is ProfileDerived => !!e)}
  }
  saveEntry(input: ProfileEntryInput): ProfileEntry {
    if (!input || typeof input !== 'object') throw new ProfileError('Entry is required')
    const old = input.id === undefined ? undefined : this.snapshot().entries.find(e=>e.id === identifier(input.id))
    if (input.id !== undefined && !old) throw new ProfileError('Entry not found',404)
    if (old) revision(old.revision,input.expectedRevision)
    const category = input.category
    if (!Object.hasOwn(PROFILE_FIELDS,category) || !PROFILE_FIELDS[category].includes(input.field)) throw new ProfileError('Invalid category or field')
    const subjectId = identifier(input.subjectId ?? old?.subjectId ?? 'self')
    if (subjectId !== 'self' && !this.db.prepare('SELECT 1 FROM profile_people WHERE id=?').get(subjectId)) throw new ProfileError('Person not found',404)
    if (['gender','birthday','age','city','industry','role'].includes(input.field) && this.snapshot().entries.some(e=>e.id !== old?.id && e.subjectId === subjectId && e.field === input.field && e.status !== 'inactive')) throw new ProfileError('Field already exists; edit its current entry',409)
    const value = validateValue(input.field,input.value)
    const usage = input.usage ?? old?.usage ?? 'display', status = input.status ?? 'confirmed', scope = identifier(input.scope ?? old?.scope ?? 'global')
    if (!['display','local','relevant'].includes(usage) || !['confirmed','proposed','inactive'].includes(status)) throw new ProfileError('Invalid status or usage')
    if (input.userLocked !== undefined && typeof input.userLocked !== 'boolean') throw new ProfileError('Invalid user lock')
    if (input.sourceKind !== undefined && !sources.includes(input.sourceKind)) throw new ProfileError('Invalid source kind')
    const sourceKind = input.sourceKind ?? 'user-confirmed', sourceRef = string(input.sourceRef ?? old?.sourceRef ?? 'profile:manual','sourceRef',500)
    if (['inferred','external','system-observed'].includes(sourceKind) && (!this.settings().learningEnabled || this.snapshot().entries.some(e=> e.subjectId === subjectId && e.field === input.field && e.userLocked))) throw new ProfileError('Learning paused or field locked',409)
    const labels: Record<string,string> = {gender:'性别',birthday:'生日',age:'自述年龄',city:'居住城市',industry:'行业',role:'岗位',hobby:'兴趣爱好',communication:'沟通偏好',workstyle:'工作习惯',goal:'目标',experience:'经历'}
    // Subject identity lives only in metadata, so renaming a person cannot stale canonical text.
    const content = ['understanding','notes'].includes(input.field) ? string(input.content ?? value,'content',4000) : `${labels[input.field]}：${typeof value === 'string' ? value : JSON.stringify(value)}`
    // For free text, content is the value too; there cannot be two conflicting assertions.
    const canonicalValue = ['understanding','notes'].includes(input.field) ? content : value
    const id = old?.id ?? randomUUID(), memoryId = old?.memoryId ?? randomUUID(), now = new Date().toISOString()
    this.memory.invalidatePendingWrites()
    return this.transaction(()=>{
      if (old) {
        this.memory.protectFromInference(old.content,old.sourceRef)
        this.db.prepare('UPDATE profile_entries SET subject_id=?,category=?,field=?,usage=?,scope=?,user_locked=? WHERE id=?').run(subjectId,category,input.field,usage,scope,input.userLocked === false ? 0 : 1,id)
        this.db.prepare("UPDATE memory_items SET content=?,gist=?,profile_value=?,status=?,source_kind=?,source_ref=?,updated_at=?,embedding=NULL,valid_to=NULL,trust='authoritative',confidence=1 WHERE id=?").run(content,content.slice(0,240),JSON.stringify(canonicalValue),status === 'inactive' ? 'rejected' : status,sourceKind,sourceRef,now,memoryId)
      } else {
        this.db.prepare(`INSERT INTO memory_items(id,owner_id,kind,content,gist,source_kind,source_ref,source_span,trust,confidence,importance_goal,importance_novelty,importance_social,importance_repetition,importance_explicit,importance_deadline,sensitivity,valid_from,created_at,updated_at,status,retention,profile_value)
          VALUES (?,'local-owner','semantic',?,?,?,?,?,'authoritative',1,0.5,0.5,0.5,0.5,1,0.5,'sensitive',?,?,?,?,'until-deleted',?)`).run(memoryId,content,content.slice(0,240),sourceKind,sourceRef,'',now,now,now,status === 'inactive' ? 'rejected' : status,JSON.stringify(canonicalValue))
        this.db.prepare('INSERT INTO profile_entries(id,memory_id,subject_id,category,field,usage,scope,revision,user_locked) VALUES (?,?,?,?,?,?,?,1,?)').run(id,memoryId,subjectId,category,input.field,usage,scope,input.userLocked === false ? 0 : 1)
        this.change(id,'created')
      }
      this.db.prepare('DELETE FROM memory_fts WHERE id=?').run(memoryId)
      this.db.prepare('INSERT INTO memory_fts(id,content,gist) VALUES (?,?,?)').run(memoryId,content,content.slice(0,240))
      if (input.userLocked !== false || status === 'inactive') this.memory.protectFromInference(content,sourceRef)
      return this.snapshot().entries.find(e=>e.id === id)!
    })
  }
  deleteEntry(id: string, expectedRevision: number): void {
    const entry = this.snapshot().entries.find(e=>e.id === identifier(id)); if (!entry) throw new ProfileError('Entry not found',404)
    revision(entry.revision,expectedRevision)
    this.transaction(()=>{ this.memory.delete(entry.memoryId) })
  }
  savePerson(input: ProfilePersonInput): ProfilePerson {
    if (!input || typeof input !== 'object') throw new ProfileError('Person is required')
    const name = string(input.name,'name',100), relationship = string(input.relationship,'relationship',100)
    const old = input.id === undefined ? undefined : this.snapshot().people.find(p=>p.id === identifier(input.id))
    if (input.id !== undefined && !old) throw new ProfileError('Person not found',404)
    if (old) revision(old.revision,input.expectedRevision)
    const person = {id:old?.id ?? randomUUID(),name,relationship,revision:(old?.revision ?? 0)+1}
    this.memory.invalidatePendingWrites()
    this.transaction(()=>{this.db.prepare('INSERT INTO profile_people VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,relationship=excluded.relationship,revision=excluded.revision').run(person.id,name,relationship,person.revision);this.change(person.id,old?'person-updated':'person-created')})
    return person
  }
  deletePerson(id: string, expectedRevision: number): void {
    const person = this.snapshot().people.find(p=>p.id === identifier(id)); if (!person) throw new ProfileError('Person not found',404)
    revision(person.revision,expectedRevision)
    this.memory.invalidatePendingWrites()
    this.transaction(()=>{ for (const entry of this.snapshot().entries.filter(e=>e.subjectId === id)) this.memory.delete(entry.memoryId); this.db.prepare('DELETE FROM profile_people WHERE id=?').run(id);this.change(id,'person-deleted') })
  }
  updateSettings(input: Partial<ProfileSettings>): ProfileSettings {
    if (!input || typeof input !== 'object' || Object.keys(input).some(key=>!['learningEnabled','useEnabled'].includes(key)) || Object.values(input).some(v=>typeof v !== 'boolean')) throw new ProfileError('Invalid settings')
    const settings = {...this.settings(),...input}
    this.memory.invalidatePendingWrites()
    this.db.prepare('INSERT INTO profile_settings VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET learning_enabled=excluded.learning_enabled,use_enabled=excluded.use_enabled').run(Number(settings.learningEnabled),Number(settings.useEnabled))
    return settings
  }
  context(options: { remote: boolean; scope?: string; maxChars?: number; query?: string }): ProfileEntry[] {
    if (!options || typeof options.remote !== 'boolean') throw new ProfileError('remote is required')
    if (options.scope !== undefined) identifier(options.scope)
    const maxChars = options.maxChars ?? 3000
    if (!integer(maxChars,0,32000)) throw new ProfileError('Invalid maxChars')
    if (!this.settings().useEnabled) return []
    const snapshot = this.snapshot(), result: ProfileEntry[] = []
    let chars = 0
    for (const entry of snapshot.entries) {
      if (entry.status !== 'confirmed' || entry.usage === 'display' || (options.remote && entry.usage !== 'relevant') || (entry.scope !== 'global' && entry.scope !== options.scope)) continue
      // Identity and family details never enter remote context, even if usage was misconfigured.
      if (options.remote && (entry.subjectId !== 'self' || ['birthday','age','city','gender','experience','notes'].includes(entry.field))) continue
      if (entry.subjectId !== 'self') {
        const person = snapshot.people.find(p=>p.id === entry.subjectId)
        if (!options.query || !person || ![person.name,person.relationship].some(term=>options.query!.includes(term))) continue
      }
      if (options.query && entry.subjectId === 'self' && !['communication','workstyle'].includes(entry.field)) {
        const cues: Record<string,RegExp> = {birthday:/生日|年龄|几岁|星座|生肖/u,age:/年龄|几岁/u,gender:/性别/u,city:/住|城市|本地|天气/u,industry:/工作|职业|行业|技术|项目/u,role:/工作|职业|岗位|技术|项目/u,hobby:/爱好|兴趣|休闲/u,experience:/经历|履历|简历/u,goal:/目标|计划/u}
        const text = typeof entry.value === 'string' ? entry.value : ''
        const tokens = text.match(/[a-zA-Z0-9]{2,}|[\u3400-\u9fff]{2}/gu) ?? []
        if (!cues[entry.field]?.test(options.query) && !tokens.some(token=>options.query!.toLowerCase().includes(token.toLowerCase()))) continue
      }
      if (chars+entry.content.length > maxChars) continue
      chars += entry.content.length; result.push(entry)
    }
    return result
  }
  /** Attach conservative first-person proposals without creating another memory row. */
  observeMemory(item: MemoryItem): ProfileEntry | undefined {
    if (!this.settings().learningEnabled || !['user-stated','inferred'].includes(item.sourceKind) || !['proposed','confirmed'].includes(item.status) || /screen|camera|external|web/i.test(item.sourceRef)) return
    const rules: Array<{pattern:RegExp;category:ProfileCategory;field:string}> = [
      {pattern:/^(?:我喜欢|我爱好)\s*(.{1,200})$/u,category:'interest',field:'hobby'},
      {pattern:/^我(?:目前|现在)?住在\s*(.{1,100})$/u,category:'basic',field:'city'},
      {pattern:/^我的岗位是\s*(.{1,100})$/u,category:'career',field:'role'},
      {pattern:/^我从事\s*(.{1,100})行业[。！]?$/u,category:'career',field:'industry'},
      {pattern:/^(?:我希望你|回答请)\s*(.{1,200})$/u,category:'preference',field:'communication'},
    ]
    const rule = rules.find(rule=>rule.pattern.test(item.content))
    if (!rule) return
    const match = rule.pattern.exec(item.content)!
    if (this.snapshot().entries.some(e=>e.subjectId === 'self' && e.field === rule.field && e.userLocked)) return
    const existing = this.snapshot().entries.find(e=>e.memoryId === item.id)
    if (existing) return existing
    if (!this.memory.get(item.id)) return
    const id = randomUUID()
    this.transaction(()=>{
      this.db.prepare("UPDATE memory_items SET profile_value=?,status='proposed',sensitivity='sensitive',embedding=NULL WHERE id=?").run(JSON.stringify(match[1]),item.id)
      this.db.prepare("INSERT INTO profile_entries(id,memory_id,subject_id,category,field,usage,scope,revision,user_locked) VALUES (?,?,'self',?,?,'local','global',1,0)").run(id,item.id,rule.category,rule.field)
      this.change(id,'proposed')
    })
    return this.snapshot().entries.find(e=>e.id === id)
  }
}
