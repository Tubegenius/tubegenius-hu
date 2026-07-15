import { describe, expect, it } from 'vitest'
import { calculateViewsPerHour, calculateWindowGrowth } from '@/lib/competitor-performance'
import { isCompetitorSnapshotDue } from '@/lib/competitor-tracker'

describe('competitor performance snapshots', () => {
  it('requires two measurements and computes measured VPH', () => {
    expect(calculateViewsPerHour([{ checked_at: '2026-01-01T00:00:00Z', view_count: 100 }])).toBeNull()
    expect(calculateViewsPerHour([{ checked_at: '2026-01-01T00:00:00Z', view_count: 100 }, { checked_at: '2026-01-01T02:00:00Z', view_count: 300 }])).toBe(100)
  })
  it('computes bounded channel growth windows without negative growth', () => {
    const points = [{ checked_at: '2026-01-01T00:00:00Z', view_count: 0, subscriber_count: 100, channel_total_views: 1000 }, { checked_at: '2026-01-08T00:00:00Z', view_count: 0, subscriber_count: 130, channel_total_views: 1600 }]
    expect(calculateWindowGrowth(points, 14, new Date('2026-01-08T00:00:00Z').getTime())).toEqual({ subscriber_delta: 30, view_delta: 600 })
  })
  it('only schedules competitors whose measurement is due', () => {
    const now = new Date('2026-01-02T00:00:00Z').getTime()
    expect(isCompetitorSnapshotDue(null, now)).toBe(true)
    expect(isCompetitorSnapshotDue('invalid', now)).toBe(true)
    expect(isCompetitorSnapshotDue('2026-01-01T03:00:00Z', now)).toBe(true)
    expect(isCompetitorSnapshotDue('2026-01-01T12:00:00Z', now)).toBe(false)
  })
})
