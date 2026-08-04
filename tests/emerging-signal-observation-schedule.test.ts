import { describe, expect, it } from 'vitest'
import {
  buildObservationBatchPlan,
  canonicalObservationVideoId,
  nextObservationDueAt,
  observationBucketStart,
  pacificQuotaDate,
  type DueObservationTarget,
} from '@/lib/emerging-signal/observation-schedule'

function target(index: number, videoId: string, overrides: Partial<DueObservationTarget> = {}): DueObservationTarget {
  const suffix = index.toString(16).padStart(12, '0')
  return {
    scheduleId: `10000000-0000-4000-8000-${suffix}`,
    evidenceId: `20000000-0000-4000-8000-${suffix}`,
    videoId,
    cadence: 'daily',
    nextDueAt: new Date(Date.UTC(2026, 7, 1, 0, 0, index % 60)).toISOString(),
    lastObservedAt: null,
    consecutiveStagnantChecks: 0,
    consecutiveMissChecks: 0,
    ...overrides,
  }
}

describe('Premium observation schedule planning', () => {
  it('globally deduplicates one YouTube video across evidence and cluster contexts', () => {
    // E1 can be linked to two clusters and E2 to a third cluster, but the
    // schedule is evidence-based: both aliases collapse to one provider ID.
    const rows = [target(1, 'abc123'), target(2, 'abc123')]
    const plan = buildObservationBatchPlan(rows, { now: new Date('2026-08-04T12:00:00Z') })
    expect(plan).not.toBeNull()
    expect(plan?.batches).toEqual([['abc123']])
    expect(plan?.selectedTargets.map(item => item.evidenceId)).toHaveLength(2)
    expect(plan?.uniqueVideoCount).toBe(1)
  })

  it('prefers the resolved global YouTube reference and safely falls back to external_ref', () => {
    expect(canonicalObservationVideoId('abc123', 'legacy-alias')).toBe('abc123')
    expect(canonicalObservationVideoId(null, 'abc123')).toBe('abc123')
    expect(canonicalObservationVideoId('', 'abc123')).toBe('abc123')
    expect(canonicalObservationVideoId(null, 'not a url-safe video id')).toBeNull()
  })

  it('caps the pilot at 200 unique IDs and emits videos.list-sized batches', () => {
    const rows = Array.from({ length: 205 }, (_, index) => target(index + 1, `video_${String(index).padStart(3, '0')}`))
    const plan = buildObservationBatchPlan(rows, { now: new Date('2026-08-04T12:00:00Z') })
    expect(plan?.batches.map(batch => batch.length)).toEqual([50, 50, 50, 50])
    expect(plan?.uniqueVideoCount).toBe(200)
    expect(plan?.deferredUniqueVideoCount).toBe(5)
  })

  it('uses the America/Los_Angeles quota date across the UTC day boundary', () => {
    expect(pacificQuotaDate(new Date('2026-08-04T06:59:59Z'))).toBe('2026-08-03')
    expect(pacificQuotaDate(new Date('2026-08-04T07:00:01Z'))).toBe('2026-08-04')
  })

  it('computes deterministic UTC cadence buckets and next boundaries', () => {
    const now = new Date('2026-08-05T17:43:21Z') // Wednesday
    expect(observationBucketStart(now, 'early8h')).toBe('2026-08-05T16:00:00.000Z')
    expect(nextObservationDueAt(now, 'early8h')).toBe('2026-08-06T00:00:00.000Z')
    expect(observationBucketStart(now, 'daily')).toBe('2026-08-05T00:00:00.000Z')
    expect(nextObservationDueAt(now, 'daily')).toBe('2026-08-06T00:00:00.000Z')
    expect(observationBucketStart(now, 'weekly')).toBe('2026-08-03T00:00:00.000Z')
    expect(nextObservationDueAt(now, 'weekly')).toBe('2026-08-10T00:00:00.000Z')
  })
})
