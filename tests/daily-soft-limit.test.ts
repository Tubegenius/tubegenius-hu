import { describe, expect, it } from 'vitest'
import { evaluateDailySoftLimit } from '@/lib/daily-soft-limit'

describe('paid plan daily soft limits', () => {
  it('allows usage within each advertised paid limit', () => {
    expect(evaluateDailySoftLimit({ plan: 'starter', usedToday: 8, cost: 2 }).allowed).toBe(true)
    expect(evaluateDailySoftLimit({ plan: 'creator', usedToday: 29, cost: 1 }).allowed).toBe(true)
    expect(evaluateDailySoftLimit({ plan: 'pro', usedToday: 98, cost: 2 }).allowed).toBe(true)
  })
  it('requires explicit override above the limit', () => {
    const denied = evaluateDailySoftLimit({ plan: 'starter', usedToday: 10, cost: 1 })
    expect(denied).toMatchObject({ allowed: false, requiresOverride: true, limit: 10, projectedUsage: 11 })
    expect(evaluateDailySoftLimit({ plan: 'starter', usedToday: 10, cost: 1, override: true }).allowed).toBe(true)
  })
  it('does not apply paid limits to free or beta plans', () => {
    expect(evaluateDailySoftLimit({ plan: 'free', usedToday: 100, cost: 1 })).toMatchObject({ allowed: true, limit: null })
  })
})
