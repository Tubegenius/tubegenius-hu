import { describe, expect, it } from 'vitest'
import { buildBatchIdentity, buildProviderReservationIdempotencyKey } from '@/lib/emerging-signal/batches'

describe('Premium Emerging Signal deterministic batches', () => {
  it('canonicalizes observation IDs and produces a stable identity', () => {
    const a = buildBatchIdentity({
      phase: 'observation', bucket: '2026-08-04T00:00:00Z', provider: 'youtube',
      operation: 'youtube.videos.list', itemIds: ['video-c', 'video-a', 'video-b'],
    })
    const b = buildBatchIdentity({
      phase: 'observation', bucket: '2026-08-04T00:00:00Z', provider: 'youtube',
      operation: 'youtube.videos.list', itemIds: ['video-b', 'video-c', 'video-a'],
    })
    expect(a.outcome).toBe('success')
    expect(b).toEqual(a)
    if (a.outcome === 'success') {
      expect(a.identity.canonicalItemIds).toEqual(['video-a', 'video-b', 'video-c'])
      expect(a.identity.payloadHash).toMatch(/^[0-9a-f]{64}$/)
      expect(a.identity.deterministicBatchKey).toMatch(/^signal-batch:v1:[0-9a-f]{64}$/)
    }
  })

  it('changes identity across buckets, phases and algorithm versions', () => {
    const base = { phase: 'discovery' as const, provider: 'youtube' as const, operation: 'youtube.search.list' as const, itemIds: ['seed'] }
    const keys = [
      buildBatchIdentity({ ...base, bucket: 'day-1' }),
      buildBatchIdentity({ ...base, bucket: 'day-2' }),
      buildBatchIdentity({ ...base, bucket: 'day-1', algorithmVersion: 2 }),
    ].map(result => result.outcome === 'success' ? result.identity.deterministicBatchKey : null)
    expect(new Set(keys).size).toBe(3)
  })

  it('enforces the physical provider capabilities before DB insertion', () => {
    expect(buildBatchIdentity({
      phase: 'discovery', bucket: 'x', provider: 'youtube', operation: 'youtube.search.list', itemIds: ['a', 'b'],
    }).outcome).toBe('invalid_request')
    expect(buildBatchIdentity({
      phase: 'observation', bucket: 'x', provider: 'youtube', operation: 'youtube.videos.list', itemIds: Array.from({ length: 51 }, (_, i) => String(i)),
    }).outcome).toBe('invalid_request')
    expect(buildBatchIdentity({
      phase: 'observation', bucket: 'x', provider: 'youtube', operation: 'youtube.videos.list', itemIds: ['same', 'same'],
    }).outcome).toBe('invalid_request')
    expect(buildBatchIdentity({
      phase: 'observation', bucket: 'x', provider: 'youtube', operation: 'youtube.search.list', itemIds: ['video'],
    }).outcome).toBe('invalid_request')
  })

  it('derives one reservation key per persisted batch attempt', () => {
    expect(buildProviderReservationIdempotencyKey('11111111-1111-4111-8111-111111111111', 2))
      .toBe('signal-batch:11111111-1111-4111-8111-111111111111:attempt:2')
    expect(buildProviderReservationIdempotencyKey('not-a-uuid', 1)).toBeNull()
    expect(buildProviderReservationIdempotencyKey('11111111-1111-4111-8111-111111111111', 0)).toBeNull()
  })
})
