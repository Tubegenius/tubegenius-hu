import { describe, expect, it } from 'vitest'
import { alertTimeBucket, classifyAlerts, classifyTrendVelocity } from '@/lib/trend-alerts'

describe('trend alert velocity methodology', () => {
  it('requires comparable measured velocities and a 25% change', () => {
    expect(classifyTrendVelocity(null, 100)).toBe('stable')
    expect(classifyTrendVelocity(124, 100)).toBe('stable')
    expect(classifyTrendVelocity(125, 100)).toBe('rising')
    expect(classifyTrendVelocity(75, 100)).toBe('declining')
    expect(classifyTrendVelocity(10, 0)).toBe('rising')
  })

  it('does not alert without two snapshots or a material view delta', () => {
    const base = { id: 'trend-1', candidate_topic: 'teszt', trend_status: 'rising' as const, views_delta: 499, total_views: 10_000, trend_velocity: 100, snapshot_count: 2, last_checked_at: '2026-01-01T00:00:00Z' }
    expect(classifyAlerts([base])).toEqual([])
    expect(classifyAlerts([{ ...base, views_delta: 500, snapshot_count: 1 }])).toEqual([])
    expect(classifyAlerts([{ ...base, views_delta: 500 }])).toHaveLength(1)
  })

  it('uses daily or ISO-week alert buckets and respects off', () => {
    expect(alertTimeBucket('2026-01-05T10:00:00Z', 'daily')).toBe('2026-01-05')
    expect(alertTimeBucket('2026-01-05T10:00:00Z', 'weekly')).toBe('2026-W02')
    const item = { id: 'trend-1', candidate_topic: 'teszt', trend_status: 'rising' as const, views_delta: 500, total_views: 10_000, trend_velocity: 100, snapshot_count: 2, last_checked_at: '2026-01-05T10:00:00Z', alert_frequency: 'off' as const }
    expect(classifyAlerts([item])).toEqual([])
  })
})
