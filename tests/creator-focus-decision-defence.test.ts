// Creator Intelligence 2B: the reducer's last line of defence. Whatever applyDecisions returns must itself be a valid
// profile; if it ever would not be, the whole layer is disabled and the INPUT profile comes back. The branch is
// unreachable with real inputs (the projection only touches claims and suggestions in valid ways), so it is exercised
// by making the validator fail on exactly the result check. DB-free.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ calls: 0, failOnCall: 0 }))

vi.mock('@/lib/creator-focus/profile-validate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/creator-focus/profile-validate')>()
  return {
    ...actual,
    validateFocusProfile: (profile: unknown) => {
      state.calls++
      return state.calls === state.failOnCall ? [{ path: 'profile.forced', code: 'forced_for_the_test' }] : actual.validateFocusProfile(profile)
    },
  }
})

import { applyDecisions } from '@/lib/creator-focus'
import { confirmEvent, world } from './support/creator-focus-decision-fixtures'

beforeEach(() => { state.calls = 0; state.failOnCall = 0 })

describe('applyDecisions validates its own result', () => {
  it('sanity: without a forced failure the layer is applied and the profile is projected', () => {
    const w = world()
    const result = applyDecisions(w.profile, w.snapshot, [confirmEvent(1, 'specific_focus', { revision: '5' })])
    expect(result.read_model.layer).toBe('applied')
    expect(result.profile.claims.specific_focus?.origin).toBe('user_confirmed')
    expect(state.calls).toBe(2) // the input check and the result check
  })

  it('an invalid RESULT disables the layer, reports why, and hands back the unchanged INPUT profile', () => {
    const w = world()
    state.failOnCall = 2 // the second validation is the one on the result
    const result = applyDecisions(w.profile, w.snapshot, [confirmEvent(1, 'specific_focus', { revision: '5' })])
    expect(result.read_model.layer).toBe('disabled')
    expect(result.read_model.issues).toEqual([
      { path: 'result', code: 'result_profile_invalid' },
      { path: 'profile.forced', code: 'forced_for_the_test' },
    ])
    expect(result.profile).toEqual(w.profile)
    expect(result.profile.decision_projection).toBeUndefined()
    expect(result.profile.claims.specific_focus?.origin).toBe('unknown') // nothing was upgraded
    for (const field of ['specific_focus', 'main_category'] as const) {
      expect(result.read_model.claims[field].confirmation).toEqual({ status: 'unverifiable', decision_id: null })
    }
  })
})
