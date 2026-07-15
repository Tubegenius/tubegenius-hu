import { afterEach, describe, expect, it, vi } from 'vitest'
import { calculateCreditMutation, calculateCreditRefund, isOptimisticCreditLockMiss } from '@/lib/credit-charge-policy'
import { buildPaidResultHash, normalizePaidResultInput, paidCacheStatus, paidResultResponseMeta, type PaidResultRecord } from '@/lib/paid-results/paid-results-service'
import { buildVideoIdeaInputHash, forwardWorkflowStatus, mapMemoryStateToWorkflowStatus, matchRelatedOutcomes, type DecisiveVideoIdea } from '@/lib/video-ideas/video-idea-service'

afterEach(() => vi.useRealTimers())

describe('credit deduction', () => {
  it('deducts once and increments usage', () => {
    expect(calculateCreditMutation(10, 4, 2)).toEqual({ allowed: true, newBalance: 8, newTotalUsed: 6 })
  })
  it('never permits a negative balance', () => {
    expect(calculateCreditMutation(0.5, 7, 1)).toEqual({ allowed: false, newBalance: 0.5, newTotalUsed: 7 })
  })
  it('retries only optimistic locking conflicts', () => {
    expect(isOptimisticCreditLockMiss({ code: 'PGRST116' })).toBe(true)
    expect(isOptimisticCreditLockMiss({ code: '42501' })).toBe(false)
  })
  it('compensates a charged but unpersisted result', () => {
    expect(calculateCreditRefund(8, 6, 2)).toEqual({ newBalance: 10, newTotalUsed: 4 })
    expect(calculateCreditRefund(0, 1, 2)).toEqual({ newBalance: 2, newTotalUsed: 0 })
  })
})

describe('paid result cache and reopening', () => {
  it('deduplicates equivalent structured inputs', () => {
    const a = normalizePaidResultInput({ Topic: 'Árvíztűrő tükörfúrógép', count: 3 })
    const b = normalizePaidResultInput({ count: 3, Topic: 'arvizturo tukorfurogep' })
    expect(a).toBe(b)
    expect(buildPaidResultHash({ userId: 'u1', toolType: 'viral_score', normalizedInput: a }))
      .toBe(buildPaidResultHash({ userId: 'u1', toolType: 'viral_score', normalizedInput: b }))
  })
  it('does not mix users or markets', () => {
    const base = { userId: 'u1', toolType: 'viral_score' as const, normalizedInput: 'topic' }
    expect(buildPaidResultHash(base)).not.toBe(buildPaidResultHash({ ...base, userId: 'u2' }))
    expect(buildPaidResultHash(base)).not.toBe(buildPaidResultHash({ ...base, region: 'US' }))
  })
  it('reopens saved results without charging', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-07-15T10:00:00Z'))
    const record = { id: 'r1', user_id: 'u1', fresh_until: '2026-07-15T11:00:00Z', last_refreshed_at: '2026-07-15T09:00:00Z', created_at: '2026-07-15T09:00:00Z' } as PaidResultRecord
    expect(paidCacheStatus(record)).toBe('fresh')
    expect(paidResultResponseMeta(record)).toMatchObject({ requires_credit: false, cache_status: 'fresh' })
    expect(paidCacheStatus({ ...record, fresh_until: '2026-07-15T09:59:59Z' })).toBe('stale_saved')
  })
})

describe('video idea CRUD and workflow', () => {
  it('normalizes idea identity but separates markets', () => {
    const a = buildVideoIdeaInputHash({ userId: 'u1', topic: 'Árvíztűrő videó', market: 'HU' })
    const b = buildVideoIdeaInputHash({ userId: 'u1', topic: 'arvizturo video', market: 'HU' })
    expect(a).toBe(b)
    expect(a).not.toBe(buildVideoIdeaInputHash({ userId: 'u1', topic: 'arvizturo video', market: 'US' }))
  })
  it('never moves automatic validation backwards', () => {
    expect(forwardWorkflowStatus('ready_to_produce', 'validated')).toBe('ready_to_produce')
    expect(forwardWorkflowStatus('published', 'validating')).toBe('published')
    expect(forwardWorkflowStatus('validating', 'validated')).toBe('validated')
  })
  it('maps explicit CRUD states', () => {
    expect(mapMemoryStateToWorkflowStatus('saved')).toBe('validated')
    expect(mapMemoryStateToWorkflowStatus('completed')).toBe('published')
    expect(mapMemoryStateToWorkflowStatus('rejected')).toBe('rejected')
  })
  it('uses only related decisive outcomes as proof', () => {
    const pool: DecisiveVideoIdea[] = [{ id: '1', topic: 'youtube cim optimalizalas kezdoknek', platform: 'youtube', workflow_status: 'published', viral_score: 80, updated_at: '2026-07-15T00:00:00Z' }]
    expect(matchRelatedOutcomes('youtube cim optimalizalas tippek', 'youtube', pool).positive).toBeDefined()
    expect(matchRelatedOutcomes('kerti ontozorendszer', 'youtube', pool)).toEqual({})
  })
})
