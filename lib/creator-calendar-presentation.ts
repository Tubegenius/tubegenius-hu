import type { CreatorLane } from '@/lib/creator-lane-presentation'
import type { VideoIdea } from '@/types'

export interface CreatorCalendarGroups {
  scheduled: VideoIdea[]
  ready: VideoIdea[]
  published: VideoIdea[]
}

export interface CreatorCalendarDay {
  key: string
  weekday: string
  dayNumber: string
  month: string
  isToday: boolean
  ideas: VideoIdea[]
}

export const CREATOR_CALENDAR_LANE_COPY: Record<CreatorLane, { lens: string; focus: string; support: string }> = {
  evidence: {
    lens: 'Bizonyítékvezérelt ritmus',
    focus: 'A premier előtt a bizonyíték, a magyarázat és a csomag is kerüljön a helyére.',
    support: 'A naptár a kutatási és publikálási fókuszt ugyanabban a munkaritmusban tartja.',
  },
  entertainment: {
    lens: 'Élményvezérelt ritmus',
    focus: 'A premier előtt a nyitás, az élményív és a jelenetek ritmusa is kerüljön a helyére.',
    support: 'A naptár a kreatív próbát és a publikálási pillanatot ugyanabban a munkaritmusban tartja.',
  },
}

function localDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function dateFromKey(key: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(key)
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12)
  return Number.isNaN(date.getTime()) ? null : date
}

export function calendarDateKey(value: string | null | undefined): string | null {
  if (!value) return null
  const direct = /^(\d{4}-\d{2}-\d{2})/.exec(value)
  if (direct) return direct[1]
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : localDateKey(date)
}

export function groupCalendarIdeas(ideas: VideoIdea[]): CreatorCalendarGroups {
  const scheduled = ideas
    .filter(idea => idea.calendar_status === 'scheduled' && idea.workflow_status !== 'published')
    .sort((a, b) => (calendarDateKey(a.scheduled_publish_date) || '9999-99-99').localeCompare(calendarDateKey(b.scheduled_publish_date) || '9999-99-99'))
  const ready = ideas.filter(idea => idea.workflow_status === 'ready_to_produce' && idea.calendar_status !== 'scheduled')
  const published = ideas
    .filter(idea => idea.workflow_status === 'published')
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))

  return { scheduled, ready, published }
}

export function buildCreatorCalendarWeek(ideas: VideoIdea[], anchor: Date, today = new Date()): CreatorCalendarDay[] {
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), 12)
  const day = start.getDay()
  start.setDate(start.getDate() - (day === 0 ? 6 : day - 1))
  const todayKey = localDateKey(today)

  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start)
    date.setDate(start.getDate() + index)
    const key = localDateKey(date)
    return {
      key,
      weekday: new Intl.DateTimeFormat('hu-HU', { weekday: 'short' }).format(date).replace('.', ''),
      dayNumber: String(date.getDate()),
      month: new Intl.DateTimeFormat('hu-HU', { month: 'short' }).format(date).replace('.', ''),
      isToday: key === todayKey,
      ideas: ideas.filter(idea => calendarDateKey(idea.scheduled_publish_date) === key),
    }
  })
}

export function nextScheduledIdea(ideas: VideoIdea[], today = new Date()): VideoIdea | null {
  const todayKey = localDateKey(today)
  return groupCalendarIdeas(ideas).scheduled.find(idea => {
    const key = calendarDateKey(idea.scheduled_publish_date)
    return key !== null && key >= todayKey
  }) || null
}

export function shiftCalendarWeek(anchor: Date, weeks: number): Date {
  const shifted = new Date(anchor)
  shifted.setDate(shifted.getDate() + weeks * 7)
  return shifted
}

export function calendarWeekLabel(days: CreatorCalendarDay[]): string {
  if (!days.length) return ''
  return `${days[0].month} ${days[0].dayNumber}. – ${days[6].month} ${days[6].dayNumber}.`
}
