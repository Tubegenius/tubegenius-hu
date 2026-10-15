// The analyzer's defensive guard: a result that breaks its own structural invariants is never handed out as a
// measurement. By construction no input triggers it, so the checker is forced to report a violation here.
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/editing-pattern/invariants', () => ({
  checkEditingResultInvariants: () => [{ path: 'shots[0].duration_ms', code: 'forced_for_the_guard_test' }],
}))

import { analyzeEditingPattern } from '@/lib/editing-pattern/analyzer'
import { FixtureFrameSource, inputFor, slowTalkingHead } from './support/editing-pattern-fixtures'

describe('invariant guard', () => {
  it('turns a result that violates an invariant into failed / invariant_violation, without metrics', async () => {
    const f = slowTalkingHead()
    const result = await analyzeEditingPattern(inputFor(f, 'vid'), new FixtureFrameSource({ vid: f.frames }))
    expect(result).toMatchObject({
      status: 'failed',
      reason_code: 'invariant_violation',
      issues: [{ path: 'shots[0].duration_ms', code: 'forced_for_the_guard_test' }],
      metrics: null,
      cuts: [],
      shots: [],
    })
    expect(result.evidence_basis.frames_examined).toBe(f.frames.length)
  })
})
