import { readFile } from 'node:fs/promises'

export interface CalendarEvent {
  start: string
  end?: string
  summary: string
  location?: string
  allDay: boolean
}

function unfold(text: string): string[] {
  const lines: string[] = []
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (/^[ \t]/.test(line) && lines.length > 0) lines[lines.length - 1] += line.slice(1)
    else lines.push(line)
  }
  return lines
}

function parseDate(value: string): { iso: string; allDay: boolean } | null {
  const clean = value.trim()
  const utc = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(clean)
  if (utc) {
    const date = new Date(Date.UTC(Number(utc[1]), Number(utc[2]) - 1, Number(utc[3]), Number(utc[4]), Number(utc[5]), Number(utc[6])))
    return Number.isNaN(date.getTime()) ? null : { iso: date.toISOString(), allDay: false }
  }
  const local = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(clean)
  if (local) {
    const date = new Date(Number(local[1]), Number(local[2]) - 1, Number(local[3]), Number(local[4]), Number(local[5]), Number(local[6]))
    return Number.isNaN(date.getTime()) ? null : { iso: date.toISOString(), allDay: false }
  }
  const day = /^(\d{4})(\d{2})(\d{2})$/.exec(clean)
  if (day) {
    const date = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 0, 0, 0)
    return Number.isNaN(date.getTime()) ? null : { iso: date.toISOString(), allDay: true }
  }
  return null
}

export function parseIcs(text: string): CalendarEvent[] {
  const events: CalendarEvent[] = []
  let current: Record<string, string> | null = null
  for (const line of unfold(text)) {
    if (line === 'BEGIN:VEVENT') { current = {}; continue }
    if (line === 'END:VEVENT') {
      if (current?.DTSTART && current.SUMMARY) {
        const start = parseDate(current.DTSTART)
        const end = current.DTEND ? parseDate(current.DTEND) : null
        if (start) {
          events.push({
            start: start.iso,
            end: end?.iso,
            summary: current.SUMMARY,
            location: current.LOCATION,
            allDay: start.allDay,
          })
        }
      }
      current = null
      continue
    }
    if (!current) continue
    const index = line.indexOf(':')
    if (index < 1) continue
    const key = line.slice(0, index).split(';')[0].toUpperCase()
    if (key === 'DTSTART' || key === 'DTEND' || key === 'SUMMARY' || key === 'LOCATION') {
      current[key] = line.slice(index + 1).replace(/\\n/g, ' ').replace(/\\,/g, ',').trim()
    }
  }
  return events.sort((a, b) => a.start.localeCompare(b.start))
}

export async function readCalendar(path: string | undefined): Promise<CalendarEvent[]> {
  if (!path) return []
  try {
    return parseIcs(await readFile(path, 'utf8'))
  } catch {
    return []
  }
}

export function eventsForDay(events: CalendarEvent[], now: Date): CalendarEvent[] {
  return events.filter(event => {
    const start = new Date(event.start)
    return start.getFullYear() === now.getFullYear() && start.getMonth() === now.getMonth() && start.getDate() === now.getDate()
  })
}
