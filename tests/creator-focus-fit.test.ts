// Creator Intelligence 2A: the conservative focus-fit and lane suggestion.
import { describe, expect, it } from 'vitest'
import { adaptProfileRow, assessFocusFit, confirmSuggestion, isFactEligible, type FocusFitInput } from '@/lib/creator-focus'
import { AT, CHANNEL_A, allKeys, candidate, deepFreeze, row } from './support/creator-focus-fixtures'

const FOCUS = 'otthoni edzés kezdőknek'

function fit(rowOver: Record<string, unknown>, topic: string, cluster?: string | null) {
  const profile = adaptProfileRow(row(rowOver))
  return assessFocusFit({ contract_version: 'creator-focus.v1', profile, topic: { text: topic, ...(cluster !== undefined ? { linked_signal_cluster_id: cluster } : {}) } })
}

describe('fits / partial: only a fact-eligible focus is matched', () => {
  it('three focus words matched: fits, with the matched terms and the claim origin as the reason', () => {
    const r = fit({ specific_focus: FOCUS }, 'otthoni edzés kezdőknek 4 hét alatt')
    expect(r.status).toBe('fits')
    expect(r.unknown_because).toEqual([])
    expect(r.reasons).toEqual([{ code: 'focus_terms_matched', claim_field: 'specific_focus', claim_origin: 'user_declared', matched_terms: ['edzes', 'kezdoknek', 'otthoni'] }])
    expect(r.basis.claims_used).toEqual([{ field: 'specific_focus', origin: 'user_declared' }])
  })

  it('an inflected word still matches through the shared-prefix rule (otthon / otthoni)', () => {
    expect(fit({ specific_focus: FOCUS }, 'gyors edzés otthon').status).toBe('fits')
  })

  it('exactly one focus word matched: partial, never fits', () => {
    const r = fit({ specific_focus: FOCUS }, 'edzés program hetente')
    expect(r.status).toBe('partial')
    expect(r.reasons[0]).toMatchObject({ code: 'single_focus_term_matched', matched_terms: ['edzes'] })
  })

  it('no shared word is "we do not know", NOT "does not fit"', () => {
    const r = fit({ specific_focus: FOCUS }, 'bolygók mozgása a naprendszerben')
    expect(r.status).toBe('unknown')
    expect(r.unknown_because).toEqual(['no_lexical_overlap'])
  })
})

describe('unknown has precedence whenever the basis is incomplete or contradictory', () => {
  it('system suggestions alone are never a fact, even when the topic repeats their words', () => {
    const r = fit({ detected_niche_candidates: [candidate(FOCUS, 'health')], active_channel_id: CHANNEL_A }, 'otthoni edzés kezdőknek 4 hét alatt')
    expect(r.status).toBe('unknown')
    expect(r.unknown_because).toEqual(['no_eligible_focus'])
    expect(r.reasons[0]).toMatchObject({ code: 'focus_only_system_suggested' })
    expect(r.basis.claims_used).toEqual([])
    expect(r.warnings).toContain('system_suggestions_not_used_as_facts')
  })

  it('the same suggestion becomes usable only after an explicit confirmation', () => {
    const profile = adaptProfileRow(row({ detected_niche_candidates: [candidate(FOCUS, 'health')], active_channel_id: CHANNEL_A }))
    const confirmed = confirmSuggestion(profile, 0, AT)
    if (!confirmed.ok) throw new Error('expected ok')
    const r = assessFocusFit({ contract_version: 'creator-focus.v1', profile: confirmed.profile, topic: { text: 'otthoni edzés kezdőknek 4 hét alatt' } })
    expect(r.status).toBe('fits')
    expect(r.basis.claims_used).toEqual([{ field: 'specific_focus', origin: 'user_confirmed' }])
  })

  it('a focus of unknown origin is not a fact', () => {
    const r = fit({ specific_focus: FOCUS, detected_niche_candidates: [candidate(FOCUS, 'health')], active_channel_id: CHANNEL_A }, 'otthoni edzés kezdőknek 4 hét alatt')
    expect(r.status).toBe('unknown')
    expect(r.reasons[0]).toMatchObject({ code: 'focus_claim_origin_unknown', claim_origin: 'unknown' })
  })

  it('an adopted, channel-derived focus under a pending review is unknown; a self-typed focus under the same review is not', () => {
    const adopted = { specific_focus: FOCUS, detected_niche_candidates: [candidate(FOCUS, 'health')], active_channel_id: CHANNEL_A, niche_validated_for_channel_id: CHANNEL_A, niche_needs_review: true }
    const a = fit(adopted, 'otthoni edzés kezdőknek 4 hét alatt')
    expect(a.status).toBe('unknown')
    expect(a.reasons[0]).toMatchObject({ code: 'focus_claim_not_eligible_channel_context_uncertain' })
    expect(a.warnings).toEqual(expect.arrayContaining(['niche_review_pending', 'channel_derived_claims_unreliable']))

    const typed = fit({ specific_focus: 'retró számítógépek', niche_needs_review: true, channel_connection_type: 'mismatch', active_channel_id: CHANNEL_A }, 'retró számítógépek felújítása')
    expect(typed.status).toBe('fits')
    expect(typed.warnings).toEqual(expect.arrayContaining(['niche_review_pending', 'channel_mismatch']))
  })

  it('a declared stats_only mode beats a perfect overlap; the database-default manual mode does not block', () => {
    expect(fit({ specific_focus: FOCUS, channel_usage_mode: 'stats_only' }, 'otthoni edzés kezdőknek 4 hét alatt')).toMatchObject({ status: 'unknown', unknown_because: ['stats_only_mode'] })
    expect(fit({ specific_focus: FOCUS, channel_usage_mode: 'manual' }, 'otthoni edzés kezdőknek 4 hét alatt').status).toBe('fits')
  })

  it.each([['edzés'], ['otthon'], ['  ab cd  '], ['']])('a topic that is too short (%p) is unknown', (topic) => {
    expect(fit({ specific_focus: FOCUS }, topic)).toMatchObject({ status: 'unknown', unknown_because: ['topic_too_short'] })
  })

  it('an avoid topic and a focus match together contradict: unknown, lane unknown too', () => {
    const r = fit({ specific_focus: FOCUS, avoid_topics: 'politika, hírek' }, 'politika és edzés otthon', 'cluster-1')
    expect(r.status).toBe('unknown')
    expect(r.unknown_because).toEqual(['conflicting_claims'])
    expect(r.lane_suggestion.value).toBe('unknown')
  })
})

describe('does_not_fit: only an explicit, user-declared avoid topic can say no', () => {
  it('a single avoid term', () => {
    const r = fit({ specific_focus: FOCUS, avoid_topics: 'politika, hírek' }, 'politika hírek elemzés')
    expect(r.status).toBe('does_not_fit')
    expect(r.reasons[0]).toMatchObject({ code: 'avoid_topic_matched', claim_field: 'avoid_topics', claim_origin: 'user_declared' })
  })

  it('a multi-word avoid phrase needs ALL its words', () => {
    const profile = { specific_focus: FOCUS, avoid_topics: 'kripto befektetés' }
    expect(fit(profile, 'befektetés lépésről lépésre egyszerűen').status).not.toBe('does_not_fit')
    expect(fit(profile, 'kripto befektetés tippek').status).toBe('does_not_fit')
  })

  it('an unknown-origin avoid topic would not count (no such row can be produced from the adapter, so it is built by hand)', () => {
    const profile = adaptProfileRow(row({ specific_focus: FOCUS, avoid_topics: 'politika' }))
    profile.claims.avoid_topics = { ...profile.claims.avoid_topics!, origin: 'unknown', fact_eligible: false }
    const r = assessFocusFit({ contract_version: 'creator-focus.v1', profile, topic: { text: 'politika hírek elemzés' } })
    expect(r.status).toBe('unknown')
  })
})

describe('lane suggestion: always unknown in 2A; a cluster id is only an unverified hint', () => {
  const CLUSTER = 'cluster-1'
  const LANE_REASON = 'lane_requires_an_authenticated_link_and_decision'
  const hint = { kind: 'linked_signal_cluster_id', value: CLUSTER, status: 'unverified' }

  it.each([
    ['an empty profile', {}, 'bármilyen hosszabb téma szöveg'],
    ['stats_only mode', { specific_focus: FOCUS, channel_usage_mode: 'stats_only' }, 'otthoni edzés kezdőknek 4 hét alatt'],
    ['a too short topic', { specific_focus: FOCUS }, 'edzés'],
    ['contradicting claims', { specific_focus: FOCUS, avoid_topics: 'politika' }, 'politika és edzés otthon'],
    ['a perfect fit', { specific_focus: FOCUS }, 'otthoni edzés kezdőknek 4 hét alatt'],
    ['an explicit avoid hit', { specific_focus: FOCUS, avoid_topics: 'politika' }, 'politika hírek elemzés'],
    ['a profile that says entertainment', { specific_focus: FOCUS, main_category: 'entertainment', primary_creator_lane: 'entertainment_led' }, 'otthoni edzés kezdőknek 4 hét alatt'],
  ])('%s: with a cluster id the lane is still unknown and the id is returned only as an unverified hint', (_name, over, topic) => {
    const without = fit(over, topic)
    const withId = fit(over, topic, CLUSTER)
    for (const r of [without, withId]) {
      expect(r.lane_suggestion.value).toBe('unknown')
      expect(r.lane_suggestion.reasons).toContain(LANE_REASON)
    }
    expect(without.lane_suggestion.unverified_link).toBeNull()
    expect(withId.lane_suggestion.unverified_link).toEqual(hint)
    expect(withId.lane_suggestion.reasons).toContain('linked_signal_cluster_id_is_an_unverified_hint')
    // the id changes nothing else: status, reasons, basis and warnings are identical with and without it
    expect({ ...withId, lane_suggestion: null }).toEqual({ ...without, lane_suggestion: null })
  })

  it('the id is never evidence: no output field says evidence_led', () => {
    const outputs = [fit({}, 'bármilyen hosszabb téma szöveg', CLUSTER), fit({ specific_focus: FOCUS }, 'otthoni edzés kezdőknek 4 hét alatt', CLUSTER)]
    for (const output of outputs) expect(JSON.stringify(output)).not.toContain('evidence_led')
  })

  it('a well-formed id next to otherwise invalid input is not echoed either', () => {
    const input = { contract_version: 'creator-focus.v1', profile: adaptProfileRow(row({ specific_focus: FOCUS })), topic: { text: 42, linked_signal_cluster_id: CLUSTER } }
    const r = assessFocusFit(input as unknown as FocusFitInput)
    expect(r.unknown_because).toEqual(['invalid_input'])
    expect(r.lane_suggestion.unverified_link).toBeNull()
  })

  it('a malformed id is an invalid input, with no hint echoed', () => {
    const r = fit({ specific_focus: FOCUS }, 'otthoni edzés kezdőknek 4 hét alatt', 'x'.repeat(200))
    expect(r.unknown_because).toEqual(['invalid_input'])
    expect(r.lane_suggestion).toMatchObject({ value: 'unknown', unverified_link: null })
  })
})

describe('a profile that did not come from the adapter is not trusted: its flags are checked, never obeyed', () => {
  const TOPIC = 'otthoni edzés kezdőknek 4 hét alatt'
  const base = () => structuredClone(adaptProfileRow(row({ specific_focus: FOCUS, audience: 'kezdők', channel_usage_mode: 'primary_profile', active_channel_id: CHANNEL_A })))
  const run = (profile: unknown, topic = TOPIC) => assessFocusFit({ contract_version: 'creator-focus.v1', profile, topic: { text: topic } } as unknown as FocusFitInput)

  function expectRejected(profile: unknown, path: string, code: string) {
    const r = run(profile)
    expect(r.status).toBe('unknown')
    expect(r.unknown_because).toEqual(['invalid_input'])
    expect(r.issues).toContainEqual({ path, code })
    expect(r.basis.claims_used).toEqual([])
    expect(r.reasons).toEqual([])
  }

  it.each([
    ['unknown origin marked as a fact', { origin: 'unknown', fact_eligible: true }],
    ['a system suggestion hand-made into a claim and marked as a fact', { origin: 'system_suggested', fact_eligible: true }],
    ['a system suggestion hand-made into a claim, marked honestly', { origin: 'system_suggested', fact_eligible: false }],
  ])('%s on specific_focus: rejected, never matched', (_name, over) => {
    const profile = base()
    profile.claims.specific_focus = { ...profile.claims.specific_focus!, ...over } as never
    const r = run(profile)
    expect(r.status).toBe('unknown')
    expect(r.unknown_because).toEqual(['invalid_input'])
    expect(r.issues.length).toBeGreaterThan(0)
    expect(r.basis.claims_used).toEqual([])
  })

  it('a channel-derived claim marked as a fact under an uncertain channel context: rejected', () => {
    const profile = adaptProfileRow(row({
      specific_focus: FOCUS, detected_niche_candidates: [candidate(FOCUS, 'health')], active_channel_id: CHANNEL_A,
      niche_validated_for_channel_id: CHANNEL_A, niche_needs_review: true,
    }))
    expect(profile.claims.specific_focus).toMatchObject({ origin: 'user_confirmed', fact_eligible: false })
    const forged = structuredClone(profile)
    forged.claims.specific_focus!.fact_eligible = true
    expectRejected(forged, 'profile.claims.specific_focus.fact_eligible', 'inconsistent_with_origin_and_channel_context')
    // and the honest one is a clean unknown, not an error
    expect(run(profile)).toMatchObject({ status: 'unknown', unknown_because: ['no_eligible_focus'] })
  })

  it('the context flags must agree with each other: a hidden mismatch or review is rejected', () => {
    const hidden = base()
    hidden.channel.connection = 'mismatch'
    expectRejected(hidden, 'profile.channel.mismatch', 'inconsistent_with_connection')
    const quiet = base()
    quiet.channel.niche_review_required = true
    expectRejected(quiet, 'profile.channel.context_uncertain', 'inconsistent_with_review_and_mismatch')
  })

  it('a flag that is false although the origin is a fact is also rejected (the profile was not produced by this module)', () => {
    const profile = base()
    profile.claims.specific_focus!.fact_eligible = false
    expectRejected(profile, 'profile.claims.specific_focus.fact_eligible', 'inconsistent_with_origin_and_channel_context')
  })

  it('a confirmed claim that denies being channel-derived, and own words that claim to be channel-derived, are rejected', () => {
    const a = base()
    a.claims.specific_focus = { ...a.claims.specific_focus!, origin: 'user_confirmed', channel_derived: false }
    expectRejected(a, 'profile.claims.specific_focus.channel_derived', 'confirmed_claim_must_be_channel_derived')
    const b = base()
    b.claims.specific_focus = { ...b.claims.specific_focus!, channel_derived: true }
    expectRejected(b, 'profile.claims.specific_focus.channel_derived', 'own_words_cannot_be_channel_derived')
  })

  it.each([
    ['a claim stored under the wrong key', (p: ReturnType<typeof base>) => { (p.claims as Record<string, unknown>).audience = { ...p.claims.specific_focus! } }, 'profile.claims.audience.field', 'does_not_match_key'],
    ['an unknown claim key', (p: ReturnType<typeof base>) => { (p.claims as Record<string, unknown>).niche = { ...p.claims.specific_focus!, field: 'niche' } }, 'profile.claims.niche', 'unknown_field'],
    ['an origin that does not exist', (p: ReturnType<typeof base>) => { (p.claims.specific_focus as unknown as Record<string, unknown>).origin = 'trusted' }, 'profile.claims.specific_focus.origin', 'invalid_value'],
    ['an invalid category value', (p: ReturnType<typeof base>) => { (p.claims as Record<string, unknown>).main_category = { field: 'main_category', value: 'bogus', origin: 'user_declared', channel_derived: false, fact_eligible: true, reasons: [] } }, 'profile.claims.main_category.value', 'invalid_value'],
    ['an extra claim key', (p: ReturnType<typeof base>) => { (p.claims.specific_focus as unknown as Record<string, unknown>).score = 99 }, 'profile.claims.specific_focus', 'invalid_value'],
    ['a suggestion marked as a fact', (p: ReturnType<typeof base>) => { p.suggestions.push({ index: 0, main_category: 'health', specific_focus: 'otthoni edzés', source_channel_id: CHANNEL_A, origin: 'system_suggested', fact_eligible: true } as never) }, 'profile.suggestions[0].fact_eligible', 'a_suggestion_is_never_a_fact'],
    ['a suggestion of another channel', (p: ReturnType<typeof base>) => { p.suggestions.push({ index: 0, main_category: 'health', specific_focus: 'otthoni edzés', source_channel_id: 'UC_other', origin: 'system_suggested', fact_eligible: false }) }, 'profile.suggestions[0].source_channel_id', 'not_the_active_channel'],
    ['a profile claiming to be persisted', (p: ReturnType<typeof base>) => { (p as unknown as Record<string, unknown>).persistence = 'database' }, 'profile.persistence', 'invalid_value'],
    ['a history entry claiming to be persisted', (p: ReturnType<typeof base>) => { p.history.push({ seq: 1, type: 'declared', field: null, from: null, to: null, at: AT, persisted: true as never }) }, 'profile.history', 'invalid_value'],
    ['an unknown top-level key', (p: ReturnType<typeof base>) => { (p as unknown as Record<string, unknown>).trusted = true }, 'profile.trusted', 'unknown_field'],
  ])('%s', (_name, mutate, path, code) => {
    const profile = base()
    mutate(profile)
    expectRejected(profile, path, code)
  })

  it('an honest, hand-built but CONSISTENT profile is accepted: consistency is checked, authenticity is not', () => {
    const handBuilt = base()
    handBuilt.claims.specific_focus = { field: 'specific_focus', value: 'retró számítógépek', origin: 'user_declared', channel_derived: false, fact_eligible: true, reasons: [] }
    const r = run(handBuilt, 'retró számítógépek felújítása otthon')
    expect(r.status).toBe('fits')
    expect(r.limitations).toContain('claim_origin_is_asserted_by_the_caller_and_not_authenticated')
  })

  it('the module itself decides eligibility: isFactEligible is the one rule, whatever a flag says', () => {
    const ctx = { context_uncertain: false }
    expect(isFactEligible({ origin: 'user_declared', channel_derived: false }, ctx)).toBe(true)
    expect(isFactEligible({ origin: 'user_confirmed', channel_derived: true }, ctx)).toBe(true)
    expect(isFactEligible({ origin: 'user_confirmed', channel_derived: true }, { context_uncertain: true })).toBe(false)
    expect(isFactEligible({ origin: 'user_corrected', channel_derived: false }, { context_uncertain: true })).toBe(true)
    expect(isFactEligible({ origin: 'unknown', channel_derived: false }, ctx)).toBe(false)
    expect(isFactEligible({ origin: 'system_suggested', channel_derived: false }, ctx)).toBe(false)
  })
})

describe('invalid input is an unknown result, never an exception', () => {
  const profile = adaptProfileRow(row({ specific_focus: FOCUS }))
  it.each([
    ['null', null],
    ['a string', 'x'],
    ['an unknown key', { contract_version: 'creator-focus.v1', profile, topic: { text: 'otthoni edzés kezdőknek' }, extra: 1 }],
    ['an unsupported version', { contract_version: 'creator-focus.v9', profile, topic: { text: 'otthoni edzés kezdőknek' } }],
    ['a non-string topic', { contract_version: 'creator-focus.v1', profile, topic: { text: 42 } }],
    ['an unknown topic key', { contract_version: 'creator-focus.v1', profile, topic: { text: 'otthoni edzés kezdőknek', url: 'x' } }],
    ['a non-string cluster id', { contract_version: 'creator-focus.v1', profile, topic: { text: 'otthoni edzés kezdőknek', linked_signal_cluster_id: 7 } }],
    ['a garbage profile', { contract_version: 'creator-focus.v1', profile: { x: 1 }, topic: { text: 'otthoni edzés kezdőknek' } }],
    ['an over-long topic', { contract_version: 'creator-focus.v1', profile, topic: { text: 'x'.repeat(301) } }],
  ])('%s', (_name, input) => {
    const r = assessFocusFit(input as unknown as FocusFitInput)
    expect(r.status).toBe('unknown')
    expect(r.unknown_because).toEqual(['invalid_input'])
    expect(r.lane_suggestion.value).toBe('unknown')
    expect(r.issues.length).toBeGreaterThan(0)
  })
})

describe('the assessment says nothing it cannot know', () => {
  const FORBIDDEN_KEY = /score|predict|retention|preference|performance|ctr|views|viral|confidence|rank/i

  it('no output ever carries a score, prediction, retention, preference or performance field', () => {
    const outputs = [
      fit({ specific_focus: FOCUS }, 'otthoni edzés kezdőknek 4 hét alatt', 'c1'),
      fit({ specific_focus: FOCUS, avoid_topics: 'politika' }, 'politika hírek elemzés'),
      fit({}, 'bolygók mozgása a naprendszerben'),
      assessFocusFit(null as unknown as FocusFitInput),
    ]
    for (const output of outputs) {
      expect(allKeys(output).filter(k => FORBIDDEN_KEY.test(k))).toEqual([])
      expect(output.limitations).toEqual(expect.arrayContaining([
        'no_audience_preference_claim', 'no_retention_or_performance_estimate', 'lexical_overlap_only_no_semantic_understanding',
      ]))
    }
  })

  it('unknown_because is non-empty exactly for the unknown status', () => {
    for (const r of [fit({ specific_focus: FOCUS }, 'otthoni edzés kezdőknek 4 hét alatt'), fit({}, 'bolygók mozgása a naprendszerben'), fit({ specific_focus: FOCUS, avoid_topics: 'politika' }, 'politika hírek elemzés')]) {
      expect(r.unknown_because.length > 0).toBe(r.status === 'unknown')
    }
  })

  it('is deterministic and does not mutate a frozen input', () => {
    const input = deepFreeze<FocusFitInput>({
      contract_version: 'creator-focus.v1',
      profile: adaptProfileRow(row({ specific_focus: FOCUS, avoid_topics: 'politika', detected_niche_candidates: [candidate('főzés gyorsan', 'lifestyle')], active_channel_id: CHANNEL_A })),
      topic: { text: 'otthoni edzés kezdőknek 4 hét alatt' },
    })
    expect(JSON.stringify(assessFocusFit(input))).toBe(JSON.stringify(assessFocusFit(input)))
  })
})
