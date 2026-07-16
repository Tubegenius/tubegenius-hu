import { describe, expect, it } from 'vitest'
import { calculateLatestViewsPerHour, calculateViewSampleOutliers, calculateViewsPerHour, calculateWindowGrowth } from '@/lib/competitor-performance'
import { classifyCompetitorVphAlerts } from '@/lib/competitor-alerts'
import { isCompetitorSnapshotDue } from '@/lib/competitor-tracker'

describe('competitor performance snapshots', () => {
  it('requires two measurements and computes measured VPH', () => {
    expect(calculateViewsPerHour([{ checked_at: '2026-01-01T00:00:00Z', view_count: 100 }])).toBeNull()
    expect(calculateViewsPerHour([{ checked_at: '2026-01-01T00:00:00Z', view_count: 100 }, { checked_at: '2026-01-01T02:00:00Z', view_count: 300 }])).toBe(100)
    expect(calculateViewsPerHour([{ checked_at: '2026-01-01T00:00:00Z', view_count: 300 }, { checked_at: '2026-01-01T02:00:00Z', view_count: 290 }])).toBeNull()
  })
  it('computes signed channel changes inside bounded measurement windows', () => {
    const points = [{ checked_at: '2026-01-01T00:00:00Z', view_count: 0, subscriber_count: 100, channel_total_views: 1000 }, { checked_at: '2026-01-08T00:00:00Z', view_count: 0, subscriber_count: 130, channel_total_views: 1600 }]
    expect(calculateWindowGrowth(points, 14, new Date('2026-01-08T00:00:00Z').getTime())).toEqual({ subscriber_delta: 30, view_delta: 600, measured_days: 7 })
    const decline = [{ ...points[0], subscriber_count: 130, channel_total_views: 1600 }, { ...points[1], subscriber_count: 100, channel_total_views: 1500 }]
    expect(calculateWindowGrowth(decline, 14, new Date('2026-01-08T00:00:00Z').getTime())).toMatchObject({ subscriber_delta: -30, view_delta: -100 })
    expect(calculateWindowGrowth([...points, { ...points[1], checked_at: '2026-01-09T00:00:00Z', channel_total_views: 9999 }], 14, new Date('2026-01-08T00:00:00Z').getTime()).view_delta).toBe(600)
  })
  it('only schedules competitors whose measurement is due', () => {
    const now = new Date('2026-01-02T00:00:00Z').getTime()
    expect(isCompetitorSnapshotDue(null, now)).toBe(true)
    expect(isCompetitorSnapshotDue('invalid', now)).toBe(true)
    expect(isCompetitorSnapshotDue('2026-01-01T03:00:00Z', now)).toBe(true)
    expect(isCompetitorSnapshotDue('2026-01-01T12:00:00Z', now)).toBe(false)
  })
  it('uses the latest two snapshots for current VPH alerts', () => {
    const points = [{ checked_at: '2026-01-01T00:00:00Z', view_count: 0 }, { checked_at: '2026-01-01T01:00:00Z', view_count: 100 }, { checked_at: '2026-01-01T02:00:00Z', view_count: 300 }]
    expect(calculateLatestViewsPerHour(points)).toBe(200)
    const base = { competitor_id: 'c1', channel_title: 'Csatorna', video_id: 'v1', video_title: 'Videó', views_per_hour: 200, threshold: 100, alert_frequency: 'daily' as const, checked_at: '2026-01-01T02:00:00Z' }
    expect(classifyCompetitorVphAlerts([base])).toHaveLength(1)
    expect(classifyCompetitorVphAlerts([{ ...base, views_per_hour: 99 }])).toEqual([])
    expect(classifyCompetitorVphAlerts([{ ...base, alert_frequency: 'off' }])).toEqual([])
  })
  it('uses a robust recent-video median and requires a real sample for outliers', () => {
    expect(calculateViewSampleOutliers([100, 110])).toMatchObject({ baseline_median_views: null, outliers: [false, false] })
    const result = calculateViewSampleOutliers([100, 110, 120, 1000, 90])
    expect(result.baseline_median_views).toBe(110)
    expect(result.ratios[3]).toBe(9.09)
    expect(result.outliers).toEqual([false, false, false, true, false])
  })
})
