import { describe, expect, it } from 'vitest'
import {
  buildCreatorCalendarWeek,
  calendarDateKey,
  calendarWeekLabel,
  CREATOR_CALENDAR_LANE_COPY,
  groupCalendarIdeas,
  nextScheduledIdea,
  shiftCalendarWeek,
} from '@/lib/creator-calendar-presentation'
import type { VideoIdea } from '@/types'

function idea(overrides: Partial<VideoIdea> = {}): VideoIdea {
  return {
    id: 'idea-1', user_id: 'user-1', title: 'Városi hősziget', topic: 'Városi hősziget', short_description: null,
    niche: null, platform: 'youtube_long', language: 'hu', market: 'HU', country: null, currency: null, timezone: null,
    content_format: '8 perc', keywords: [], trend_signals: [], similar_videos: [], competitor_proof: [], source_links: [],
    viral_score: 78, opportunity_score: 84, competition_score: null, risk_factors: [], proof_summary: null, title_ideas: [],
    hook_ideas: [], thumbnail_concepts: [], video_package_id: 'package-1', audit_result_id: null, calendar_status: 'scheduled',
    scheduled_publish_date: '2026-09-16', calendar_notes: null, publish_status: 'draft', workflow_status: 'scheduled',
    paid_result_reference: null, input_hash: null, created_at: '2026-09-01T10:00:00Z', updated_at: '2026-09-10T10:00:00Z',
    ...overrides,
  }
}

describe('Creator calendar presentation', () => {
  it('groups only the existing calendar and workflow states', () => {
    const groups = groupCalendarIdeas([
      idea(),
      idea({ id: 'ready', calendar_status: null, workflow_status: 'ready_to_produce' }),
      idea({ id: 'published', workflow_status: 'published', publish_status: 'published' }),
    ])
    expect(groups.scheduled.map(item => item.id)).toEqual(['idea-1'])
    expect(groups.ready.map(item => item.id)).toEqual(['ready'])
    expect(groups.published.map(item => item.id)).toEqual(['published'])
  })

  it('builds a Monday-to-Sunday week and places scheduled ideas by date', () => {
    const days = buildCreatorCalendarWeek([idea()], new Date(2026, 8, 16, 12), new Date(2026, 8, 16, 12))
    expect(days[0].key).toBe('2026-09-14')
    expect(days[2].key).toBe('2026-09-16')
    expect(days[2].ideas).toHaveLength(1)
    expect(days[2].isToday).toBe(true)
    expect(days[6].key).toBe('2026-09-20')
    expect(calendarWeekLabel(days)).toContain('14')
  })

  it('keeps date parsing and next-release selection deterministic', () => {
    expect(calendarDateKey('2026-09-16T18:30:00Z')).toBe('2026-09-16')
    expect(calendarDateKey(null)).toBeNull()
    const next = nextScheduledIdea([
      idea({ id: 'past', scheduled_publish_date: '2026-09-10' }),
      idea({ id: 'future', scheduled_publish_date: '2026-09-18' }),
    ], new Date(2026, 8, 16, 12))
    expect(next?.id).toBe('future')
    expect(shiftCalendarWeek(new Date(2026, 8, 16, 12), 1).getDate()).toBe(23)
  })

  it('supports two distinct creator rhythms without claiming separate backend data', () => {
    expect(CREATOR_CALENDAR_LANE_COPY.evidence.focus).not.toBe(CREATOR_CALENDAR_LANE_COPY.entertainment.focus)
    expect(CREATOR_CALENDAR_LANE_COPY.evidence.lens).toContain('Bizonyítékvezérelt')
    expect(CREATOR_CALENDAR_LANE_COPY.entertainment.lens).toContain('Élményvezérelt')
  })
})
