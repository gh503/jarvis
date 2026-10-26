import type { MemoryItem } from './types.ts'

export interface MemorySubject {
  key: string
  value: string
}

function clean(value: string): string {
  return value
    .replace(/[。！？!?；;，,.\s]+$/g, '')
    .replace(/\s+/g, '')
    .trim()
}

/**
 * Extract only explicit, high-confidence "subject = value" statements. This is
 * intentionally conservative: it is used to retire an old fact automatically,
 * so an uncertain parse is worse than leaving both rows for the user to review.
 */
export function extractSubject(content: string): MemorySubject | null {
  const text = content.replace(/\s+/g, ' ').trim()
  const location = text.match(/(?:我|本人)(?:现在|目前|已经)?(?:住在|搬到|搬家到|居住在)([^。！？；;，,]{1,50})/)
  if (location) return { key: 'location', value: clean(location[1]) }

  const employer = text.match(/(?:我|本人)(?:现在|目前|已经)?在([^。！？；;，,]{1,40})(?:工作|上班|任职)/)
  if (employer) return { key: 'employer', value: clean(employer[1]) }

  const contact = text.match(/(?:我的)?(手机号|手机号码|电话|邮箱|地址)(?:是|为|改成|换成|变成)([^。！？；;，,]{2,100})/)
  if (contact) return { key: `contact:${contact[1]}`, value: clean(contact[2]) }

  const preference = text.match(/(?:我|本人)(不)?喜欢([^。！？；;，,]{1,50})/)
  if (preference) {
    const value = clean(preference[2])
    return { key: `preference:${value}`, value: preference[1] ? 'dislike' : 'like' }
  }

  const name = text.match(/(?:我|本人)(?:叫|名字是)([^。！？；;，,]{1,30})/)
  if (name) return { key: 'name', value: clean(name[1]) }
  return null
}

export function conflictsWith(newContent: string, oldContent: string): boolean {
  const next = extractSubject(newContent)
  const previous = extractSubject(oldContent)
  if (!next || !previous) return false
  return next.key === previous.key && next.value !== previous.value
}

export function conflictCandidates(content: string, items: MemoryItem[]): MemoryItem[] {
  return items.filter(item => item.status === 'confirmed' && conflictsWith(content, item.content))
}
