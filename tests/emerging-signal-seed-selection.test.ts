import { describe, expect, it } from 'vitest'
import { selectDiscoverySeeds, type SignalSeedRow } from '@/lib/emerging-signal/seed-selection'

function seed(id: string, fingerprint: string, nextDueAt: string, active = true): SignalSeedRow {
  return {
    id,
    seed_fingerprint: fingerprint,
    seed_type: 'curated_global',
    seed_text: `Topic ${fingerprint}`,
    category: 'default',
    region: 'BOTH',
    language: 'en',
    active,
    next_due_at: nextDueAt,
    last_run_at: null,
    consecutive_failure_count: 0,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
  }
}

describe('PFM-3B4 deterministic discovery seed selection', () => {
  it('orders by due time then stable fingerprint and caps the day at three queries', () => {
    const selected = selectDiscoverySeeds([
      seed('51000000-0000-4000-8000-000000000004', 'zeta', '2026-08-04T03:00:00.000Z'),
      seed('51000000-0000-4000-8000-000000000002', 'beta', '2026-08-04T01:00:00.000Z'),
      seed('51000000-0000-4000-8000-000000000003', 'alpha', '2026-08-04T01:00:00.000Z'),
      seed('51000000-0000-4000-8000-000000000001', 'disabled', '2026-08-03T00:00:00.000Z', false),
      seed('51000000-0000-4000-8000-000000000005', 'gamma', '2026-08-04T02:00:00.000Z'),
    ])
    expect(selected?.map(row => row.seed_fingerprint)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('rejects limits outside the premium pilot envelope', () => {
    expect(selectDiscoverySeeds([], 0)).toBeNull()
    expect(selectDiscoverySeeds([], 4)).toBeNull()
  })
})
