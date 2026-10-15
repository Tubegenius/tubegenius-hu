// Creator Intelligence 2A: profiles row -> FocusProfile. DB-free: rows are plain fictional objects.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAIN_CATEGORIES } from '@/lib/search/search-context'
import { adaptProfileRow, CLAIM_FIELDS, MAIN_CATEGORY_VALUES, PROFILE_COLUMN_PROVENANCE } from '@/lib/creator-focus'
import { CHANNEL_A, CHANNEL_B, candidate, deepFreeze, row } from './support/creator-focus-fixtures'

describe('constants stay in step with the product', () => {
  it('the category list equals MAIN_CATEGORIES', () => {
    expect([...MAIN_CATEGORY_VALUES].sort()).toEqual(MAIN_CATEGORIES.map(c => c.value).sort())
  })
})

describe('origin of a plain, user-typed row', () => {
  it('typed focus, category, audience, avoid list and a non-default mode are user_declared and fact-eligible', () => {
    const p = adaptProfileRow(row({
      specific_focus: 'otthoni edzés kezdőknek', main_category: 'health', audience: 'kezdők', avoid_topics: 'politika, hírek', channel_usage_mode: 'primary_profile',
    }))
    for (const field of CLAIM_FIELDS) {
      expect(p.claims[field], field).toMatchObject({ origin: 'user_declared', fact_eligible: true, channel_derived: false })
    }
    expect(p.suggestions).toEqual([])
    expect(p.persistence).toBe('none')
    expect(p.history).toEqual([])
  })

  it("the database default mode 'manual' is unknown: a default is not a declaration", () => {
    const p = adaptProfileRow(row({ channel_usage_mode: 'manual' }))
    expect(p.claims.channel_usage_mode).toMatchObject({ origin: 'unknown', fact_eligible: false, reasons: ['database_default_indistinguishable'] })
  })

  it("the form default category 'other' is unknown, and an unrecognised category makes no claim at all", () => {
    expect(adaptProfileRow(row({ main_category: 'other' })).claims.main_category).toMatchObject({ origin: 'unknown', fact_eligible: false })
    expect(adaptProfileRow(row({ main_category: 'not_a_category' })).claims.main_category).toBeUndefined()
  })

  it('columns without a provable origin are reported and never become claims', () => {
    const p = adaptProfileRow(row({ niche: 'Tech / AI: eszközök', selected_main_niche: 'tech_ai', primary_creator_lane: 'evidence_led' }))
    expect(Object.keys(p.claims)).toEqual(['channel_usage_mode']) // only the (unknown-origin) default mode
    expect(p.ignored_columns).toEqual([
      { column: 'niche', reason: 'legacy_value_format_unproven' },
      { column: 'selected_main_niche', reason: 'no_in_repo_writer_origin_unproven' },
      { column: 'primary_creator_lane', reason: 'no_in_repo_writer_origin_unproven' },
    ])
  })
})

describe('a system suggestion is never a confirmed claim by itself', () => {
  const stored = [
    candidate('otthoni edzés kezdőknek', 'health'),
    candidate('főzés gyorsan', 'lifestyle'),
    candidate('ismeretlen csatorna', 'other', CHANNEL_B),
    candidate('forrás nélkül', 'science', null),
  ]

  it('with suggestions only, there is no claim: they are listed as system_suggested and not fact-eligible', () => {
    const p = adaptProfileRow(row({ detected_niche_candidates: stored, active_channel_id: CHANNEL_A }))
    expect(p.claims.specific_focus).toBeUndefined()
    expect(p.claims.main_category).toBeUndefined()
    expect(p.suggestions.map(s => s.specific_focus)).toEqual(['otthoni edzés kezdőknek', 'főzés gyorsan'])
    expect(p.suggestions.every(s => s.origin === 'system_suggested' && s.fact_eligible === false)).toBe(true)
    expect(p.suggestions_other_channel).toBe(2)
  })

  it('neither the model confidence nor the rationale text is carried into the profile', () => {
    const json = JSON.stringify(adaptProfileRow(row({ detected_niche_candidates: stored, active_channel_id: CHANNEL_A })))
    expect(json).not.toContain('invented rationale text')
    expect(json).not.toContain('0.91')
    expect(json).not.toContain('confidence')
  })

  it('suggestions are ignored when there is no active channel', () => {
    const p = adaptProfileRow(row({ detected_niche_candidates: stored, active_channel_id: null }))
    expect(p.suggestions).toEqual([])
    expect(p.suggestions_other_channel).toBe(4)
  })
})

describe('a stored value that equals a suggestion', () => {
  const stored = [candidate('otthoni edzés kezdőknek', 'health')]

  it('with the validation marker of the SAME channel: user_confirmed, channel-derived, eligible', () => {
    const p = adaptProfileRow(row({
      specific_focus: 'Otthoni Edzes Kezdőknek', main_category: 'health', detected_niche_candidates: stored,
      active_channel_id: CHANNEL_A, niche_validated_for_channel_id: CHANNEL_A,
    }))
    expect(p.claims.specific_focus).toMatchObject({ origin: 'user_confirmed', channel_derived: true, fact_eligible: true })
    expect(p.claims.main_category).toMatchObject({ origin: 'user_confirmed', channel_derived: true, fact_eligible: true })
  })

  it('WITHOUT the validation marker: unknown and not a fact', () => {
    const p = adaptProfileRow(row({ specific_focus: 'otthoni edzés kezdőknek', detected_niche_candidates: stored, active_channel_id: CHANNEL_A }))
    expect(p.claims.specific_focus).toMatchObject({
      origin: 'unknown', channel_derived: true, fact_eligible: false, reasons: ['matches_system_suggestion_without_validation_marker'],
    })
  })

  it('a suggestion that belongs to ANOTHER channel: unknown and not a fact', () => {
    const p = adaptProfileRow(row({
      specific_focus: 'otthoni edzés kezdőknek', detected_niche_candidates: [candidate('otthoni edzés kezdőknek', 'health', CHANNEL_B)],
      active_channel_id: CHANNEL_A, niche_validated_for_channel_id: CHANNEL_A,
    }))
    expect(p.claims.specific_focus).toMatchObject({ origin: 'unknown', fact_eligible: false, reasons: ['matches_suggestion_from_other_channel'] })
  })

  it('a typed value that matches no suggestion stays user_declared even next to suggestions', () => {
    const p = adaptProfileRow(row({ specific_focus: 'retró számítógépek', detected_niche_candidates: stored, active_channel_id: CHANNEL_A }))
    expect(p.claims.specific_focus).toMatchObject({ origin: 'user_declared', channel_derived: false, fact_eligible: true })
  })
})

describe('channel mismatch and pending review make exactly the channel-derived claims uncertain', () => {
  const adopted = row({
    specific_focus: 'otthoni edzés kezdőknek', main_category: 'health', audience: 'kezdők', avoid_topics: 'politika',
    channel_usage_mode: 'primary_profile', detected_niche_candidates: [candidate('otthoni edzés kezdőknek', 'health')],
    active_channel_id: CHANNEL_A, niche_validated_for_channel_id: CHANNEL_A,
  })

  it('baseline: everything is a fact', () => {
    const p = adaptProfileRow(adopted)
    expect(p.channel.context_uncertain).toBe(false)
    expect(Object.values(p.claims).every(c => c!.fact_eligible)).toBe(true)
  })

  it.each([
    ['niche_needs_review', { niche_needs_review: true }],
    ['channel mismatch', { channel_connection_type: 'mismatch' }],
    ['suggestions exist only for another channel (the product review predicate)', { niche_validated_for_channel_id: CHANNEL_B, detected_niche_candidates: [candidate('otthoni edzés kezdőknek', 'health', CHANNEL_B)] }],
  ])('%s: the adopted focus and category become not-a-fact; the independent claims stay facts', (_name, over) => {
    const p = adaptProfileRow({ ...adopted, ...over })
    expect(p.channel.context_uncertain).toBe(true)
    expect(p.claims.specific_focus!.fact_eligible).toBe(false)
    expect(p.claims.main_category!.fact_eligible).toBe(false)
    for (const field of ['audience', 'avoid_topics', 'channel_usage_mode'] as const) {
      expect(p.claims[field]!.fact_eligible, field).toBe(true)
    }
  })

  it('a self-typed focus is NOT dropped under a review or a mismatch', () => {
    const p = adaptProfileRow(row({ specific_focus: 'retró számítógépek', niche_needs_review: true, channel_connection_type: 'mismatch', active_channel_id: CHANNEL_A }))
    expect(p.channel).toMatchObject({ niche_review_required: true, mismatch: true, context_uncertain: true })
    expect(p.claims.specific_focus).toMatchObject({ origin: 'user_declared', fact_eligible: true })
  })
})

describe('malformed rows never throw and never invent a claim', () => {
  it.each([[null], [undefined], ['a string'], [42], [[]]])('row %p', (value) => {
    const p = adaptProfileRow(value)
    expect(p.claims).toEqual({})
    expect(p.suggestions).toEqual([])
  })

  it('wrong types, over-long text and garbage candidates are skipped', () => {
    const p = adaptProfileRow(row({
      specific_focus: 12345, audience: { a: 1 }, avoid_topics: 'x'.repeat(301), main_category: ['health'],
      detected_niche_candidates: [
        null, 3,
        { specific_focus: 'jó', main_category: 'health' },
        { specific_focus: 'érvényes fókusz', main_category: 'bogus' },
        candidate('érvényes fókusz', 'health'),
        candidate('b', 'health'), candidate('c fókusz', 'health'), candidate('d fókusz', 'health'),
      ],
      active_channel_id: CHANNEL_A,
    }))
    expect(Object.keys(p.claims)).toEqual(['channel_usage_mode'])
    // only the first four stored entries are read at all (null, 3, too short, bad category): none is valid
    expect(p.suggestions).toEqual([])
  })

  it('a valid entry within the first four is listed, the rest is not read', () => {
    const p = adaptProfileRow(row({
      detected_niche_candidates: [null, candidate('érvényes fókusz', 'health'), candidate('b fókusz', 'health'), candidate('c fókusz', 'health'), candidate('hatodik fókusz', 'health')],
      active_channel_id: CHANNEL_A,
    }))
    expect(p.suggestions.map(s => s.index)).toEqual([1, 2, 3])
  })

  it('does not mutate a frozen row and is deterministic', () => {
    const frozen = deepFreeze(row({ specific_focus: 'otthoni edzés kezdőknek', detected_niche_candidates: [candidate('x fókusz', 'health')], active_channel_id: CHANNEL_A }))
    const a = adaptProfileRow(frozen)
    const b = adaptProfileRow(frozen)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

describe('the writer audit behind the provenance policy is guarded', () => {
  // Every file that writes the `profiles` table. A NEW writer must be reviewed against the policy before it is
  // added here -- that is the point of this test.
  const KNOWN_WRITERS = [
    'app/api/profile/route.ts',
    'app/api/youtube/confirm-channel/route.ts',
    'app/api/youtube/discover-niche/route.ts',
    'app/api/youtube/resolve-mismatch/route.ts',
    'app/api/youtube/resolve-niche-review/route.ts',
    'lib/channel-profile-sync.ts',
  ]

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.next') continue
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full, out)
      else if (/\.(ts|tsx)$/.test(name)) out.push(full)
    }
    return out
  }

  it('only the known files write profiles', () => {
    const root = process.cwd()
    // the update/upsert/insert/delete must be chained DIRECTLY on from('profiles'), not just appear later in the file
    const writesProfiles = /from\((['"`])profiles\1\)\s*(\.\s*\w+\([^)]*\)\s*)*\.(update|upsert|insert|delete)\(/
    const writers = ['app', 'lib', 'components']
      .flatMap(dir => walk(join(root, dir)))
      .filter(file => writesProfiles.test(readFileSync(file, 'utf8')))
      .map(file => file.slice(root.length + 1).replace(/\\/g, '/'))
      .sort()
    expect(writers).toEqual([...KNOWN_WRITERS].sort())
  })

  it('every column the adapter relies on has a documented, non-empty writer list', () => {
    const table = PROFILE_COLUMN_PROVENANCE as Record<string, { writers: readonly string[]; proves: string }>
    const columns = [
      'specific_focus', 'main_category', 'audience', 'avoid_topics', 'channel_usage_mode', 'niche', 'selected_main_niche',
      'primary_creator_lane', 'detected_niche_candidates', 'niche_validated_for_channel_id', 'niche_needs_review',
      'active_channel_id', 'channel_connection_type',
    ]
    for (const column of columns) {
      expect(table[column], column).toBeDefined()
      expect(table[column].writers.length, column).toBeGreaterThan(0)
      expect(table[column].proves.length, column).toBeGreaterThan(0)
    }
  })
})
