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

describe('a stored value that equals a suggestion: the row cannot prove that the suggestion was adopted', () => {
  const stored = [candidate('otthoni edzés kezdőknek', 'health'), candidate('főzés gyorsan', 'lifestyle')]
  const adoptedLooking = (over: Record<string, unknown> = {}) => row({
    specific_focus: 'otthoni edzés kezdőknek', main_category: 'health', detected_niche_candidates: stored,
    active_channel_id: CHANNEL_A, ...over,
  })

  // The four row states below are what resolve-niche-review and the profile save actually leave behind.
  it('select_candidate leaves value + marker: still unknown (the marker is a channel-level decision), never a fact', () => {
    const p = adaptProfileRow(adoptedLooking({ niche_validated_for_channel_id: CHANNEL_A }))
    expect(p.claims.specific_focus).toMatchObject({
      origin: 'unknown', channel_derived: true, fact_eligible: false,
      reasons: ['matches_system_suggestion_adoption_not_provable', 'validation_marker_proves_a_channel_level_decision_only'],
    })
    expect(p.claims.main_category).toMatchObject({ origin: 'unknown', channel_derived: true, fact_eligible: false })
  })

  it('keep_current leaves the SAME marker without touching the value: a row after keep_current is indistinguishable', () => {
    // the user typed 'otthoni edzés kezdőknek' themselves, then pressed "keep current": value equals a suggestion
    const afterKeepCurrent = adaptProfileRow(adoptedLooking({ niche_validated_for_channel_id: CHANNEL_A }))
    const afterSelectCandidate = adaptProfileRow(adoptedLooking({ niche_validated_for_channel_id: CHANNEL_A }))
    expect(afterKeepCurrent).toEqual(afterSelectCandidate)
    expect(afterKeepCurrent.claims.specific_focus!.origin).toBe('unknown')
  })

  it('keep_current on a value that matches NO suggestion: the marker changes nothing, the claim stays user_declared', () => {
    const p = adaptProfileRow(row({
      specific_focus: 'retró számítógépek', detected_niche_candidates: stored, active_channel_id: CHANNEL_A, niche_validated_for_channel_id: CHANNEL_A,
    }))
    expect(p.claims.specific_focus).toMatchObject({ origin: 'user_declared', channel_derived: false, fact_eligible: true, reasons: ['written_only_by_user_initiated_paths'] })
  })

  it('a later profile save changes the focus but leaves the marker: the new, unmatched value is user_declared; the marker adds nothing', () => {
    const afterSelect = adaptProfileRow(adoptedLooking({ niche_validated_for_channel_id: CHANNEL_A }))
    const afterLaterSave = adaptProfileRow(adoptedLooking({ specific_focus: 'retró számítógépek', main_category: 'tech_ai', niche_validated_for_channel_id: CHANNEL_A }))
    expect(afterSelect.claims.specific_focus!.origin).toBe('unknown')
    expect(afterLaterSave.claims.specific_focus).toMatchObject({ value: 'retró számítógépek', origin: 'user_declared', channel_derived: false, fact_eligible: true })
    expect(afterLaterSave.claims.main_category).toMatchObject({ origin: 'user_declared', channel_derived: false })
  })

  it('a later save that writes ANOTHER suggestion text by hand is unknown again: no marker can tell it from an adoption', () => {
    const p = adaptProfileRow(adoptedLooking({ specific_focus: 'főzés gyorsan', main_category: 'lifestyle', niche_validated_for_channel_id: CHANNEL_A }))
    expect(p.claims.specific_focus).toMatchObject({ origin: 'unknown', fact_eligible: false })
  })

  it('after the suggestion list is refreshed, the earlier text no longer matches: user_declared (the limit is stated, not hidden)', () => {
    // KNOWN LIMIT: origin = who decided to hold the claim (user-initiated writers only), not who authored the words.
    // Once discover-niche replaced the list, an earlier adoption is no longer recognisable from the row.
    const p = adaptProfileRow(adoptedLooking({
      detected_niche_candidates: [candidate('zenei gyártás otthon', 'entertainment')], niche_validated_for_channel_id: CHANNEL_A,
    }))
    expect(p.claims.specific_focus).toMatchObject({ origin: 'user_declared', channel_derived: false, fact_eligible: true })
    expect(p.suggestions.map(s => s.specific_focus)).toEqual(['zenei gyártás otthon'])
  })

  it('without any marker the result is the same unknown', () => {
    const p = adaptProfileRow(adoptedLooking())
    expect(p.claims.specific_focus).toMatchObject({ origin: 'unknown', fact_eligible: false, reasons: ['matches_system_suggestion_adoption_not_provable'] })
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

  it("the adapter never produces user_confirmed or user_corrected: those exist only after an in-memory transition", () => {
    const rows = [adoptedLooking(), adoptedLooking({ niche_validated_for_channel_id: CHANNEL_A }), adoptedLooking({ niche_validated_for_channel_id: CHANNEL_B, niche_needs_review: true })]
    for (const r of rows) {
      const origins = Object.values(adaptProfileRow(r).claims).map(c => c!.origin)
      expect(origins).not.toContain('user_confirmed')
      expect(origins).not.toContain('user_corrected')
    }
  })
})

describe('channel mismatch and pending review make exactly the channel-related claims uncertain', () => {
  const typed = row({
    specific_focus: 'retró számítógépek', main_category: 'tech_ai', audience: 'kezdők', avoid_topics: 'politika',
    channel_usage_mode: 'primary_profile', detected_niche_candidates: [candidate('otthoni edzés kezdőknek', 'health')],
    active_channel_id: CHANNEL_A, niche_validated_for_channel_id: CHANNEL_A,
  })

  it('baseline: independent, self-typed claims are all facts', () => {
    const p = adaptProfileRow(typed)
    expect(p.channel.context_uncertain).toBe(false)
    expect(Object.values(p.claims).every(c => c!.fact_eligible)).toBe(true)
  })

  it.each([
    ['niche_needs_review', { niche_needs_review: true }],
    ['channel mismatch', { channel_connection_type: 'mismatch' }],
    ['suggestions exist only for another channel (the product review predicate)', { niche_validated_for_channel_id: CHANNEL_B, detected_niche_candidates: [candidate('otthoni edzés kezdőknek', 'health', CHANNEL_B)] }],
  ])('%s: the context is uncertain, yet the independent, self-typed claims remain facts', (_name, over) => {
    const p = adaptProfileRow({ ...typed, ...over })
    expect(p.channel.context_uncertain).toBe(true)
    for (const field of ['specific_focus', 'main_category', 'audience', 'avoid_topics', 'channel_usage_mode'] as const) {
      expect(p.claims[field]!.fact_eligible, field).toBe(true)
      expect(p.claims[field]!.channel_derived, field).toBe(false)
    }
  })

  it.each([
    ['niche_needs_review', { niche_needs_review: true }],
    ['channel mismatch', { channel_connection_type: 'mismatch' }],
  ])('%s: a focus that equals a suggestion is not a fact (it was never one), the typed claims still are', (_name, over) => {
    const p = adaptProfileRow({ ...typed, specific_focus: 'otthoni edzés kezdőknek', main_category: 'health', ...over })
    expect(p.claims.specific_focus).toMatchObject({ origin: 'unknown', channel_derived: true, fact_eligible: false })
    expect(p.claims.main_category).toMatchObject({ origin: 'unknown', channel_derived: true, fact_eligible: false })
    for (const field of ['audience', 'avoid_topics', 'channel_usage_mode'] as const) expect(p.claims[field]!.fact_eligible, field).toBe(true)
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

// ───────────────────────────── a SOURCE SENTINEL for profiles writers (NOT a proof) ─────────────────────────────
// This is a text scan of app/, lib/ and components/. It notices the common writing shapes and fails when a new
// file starts to write `profiles` in one of them, so the provenance policy gets re-reviewed. It does NOT prove
// that no other writer exists. The shapes it cannot see are listed in NOT_COVERED and pinned by negative
// controls below, so the limit is a tested statement rather than a hope.
const WRITE_METHOD = /\.(update|upsert|insert|delete)\(/
const FROM_PROFILES = /from\((['"`])profiles\1\)/
/** tier 1: the write is chained directly on from('profiles') */
const DIRECT_CHAIN = /from\((['"`])profiles\1\)\s*(\.\s*\w+\([^)]*\)\s*)*\.(update|upsert|insert|delete)\(/

function profileWriterSentinel(sources: Record<string, string>): { direct: string[]; touching: string[] } {
  const direct: string[] = []
  const touching: string[] = []
  for (const [file, text] of Object.entries(sources)) {
    if (DIRECT_CHAIN.test(text)) direct.push(file)
    // tier 2: the file references the table AND contains any write call (catches a query split over variables)
    else if (FROM_PROFILES.test(text) && WRITE_METHOD.test(text)) touching.push(file)
  }
  return { direct: direct.sort(), touching: touching.sort() }
}

/** Writing shapes the sentinel is KNOWN not to see. Each has a negative control below. */
const NOT_COVERED = [
  'a wrapper that takes the table name as an argument or a constant: .from(TABLE)',
  'a query built in one file and executed in another',
  'writes through .rpc(...) or SQL functions / triggers (only handle_new_user is known)',
  'raw SQL, the Supabase console, other repositories, scripts/ and e2e/ fixtures, JavaScript files',
  'older or other application versions that wrote rows before this code existed',
]

describe('the profiles-writer source sentinel (a limited text scan, not a proof)', () => {
  const KNOWN_DIRECT_WRITERS = [
    'app/api/profile/route.ts',
    'app/api/youtube/confirm-channel/route.ts',
    'app/api/youtube/discover-niche/route.ts',
    'app/api/youtube/resolve-mismatch/route.ts',
    'app/api/youtube/resolve-niche-review/route.ts',
    'lib/channel-profile-sync.ts',
  ]
  // files that read profiles and also write OTHER tables; reviewed by hand, none of them writes profiles
  const REVIEWED_TOUCHING_ONLY = [
    'app/api/opportunity/route.ts',
    'app/api/thumbnail-studio/route.ts',
    'app/api/title-studio/route.ts',
    'app/api/video-audit/route.ts',
    'app/dashboard/opportunities/page.tsx', // a Set.delete(), and a profiles read
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

  it('the repository matches the reviewed lists', () => {
    const root = process.cwd()
    const sources: Record<string, string> = {}
    for (const file of ['app', 'lib', 'components'].flatMap(dir => walk(join(root, dir)))) {
      sources[file.slice(root.length + 1).replace(/\\/g, '/')] = readFileSync(file, 'utf8')
    }
    const { direct, touching } = profileWriterSentinel(sources)
    expect(direct).toEqual([...KNOWN_DIRECT_WRITERS].sort())
    expect(touching).toEqual([...REVIEWED_TOUCHING_ONLY].sort())
  })

  describe('negative controls: what the scan does and does not see', () => {
    const scan = (text: string) => profileWriterSentinel({ 'x.ts': text })

    it.each([
      ['a direct chain', "await admin.from('profiles').update({ a: 1 }).eq('user_id', id)"],
      ['a chain split over lines', "await admin\n  .from('profiles')\n  .update({ a: 1 })\n  .eq('user_id', id)"],
      ['double quotes', 'await admin.from("profiles").upsert({ a: 1 })'],
      ['a chain with an intermediate call', "await admin.from('profiles').select('a').insert({ a: 1 })"],
    ])('sees %s as a direct writer', (_name, text) => {
      expect(scan(text).direct).toEqual(['x.ts'])
    })

    it('does not flag a pure read, or a write to another table', () => {
      expect(scan("await admin.from('profiles').select('niche').eq('user_id', id)")).toEqual({ direct: [], touching: [] })
      expect(scan("await admin.from('video_ideas').update({ a: 1 })")).toEqual({ direct: [], touching: [] })
    })

    it('flags a query split over a variable only in the weaker "touching" tier', () => {
      const split = "const q = admin.from('profiles')\nawait q.update({ a: 1 })"
      expect(scan(split)).toEqual({ direct: [], touching: ['x.ts'] })
    })

    it.each([
      ['a table-name constant', "const T = 'profiles'\nawait admin.from(T).update({ a: 1 })"],
      ['a wrapper with the table as an argument', "export const write = (t: string, v: object) => admin.from(t).update(v)\nwrite('profiles', { a: 1 })"],
      ['an RPC', "await admin.rpc('set_profile_niche', { niche: 'x' })"],
      ['a computed table name', "await admin.from(['pro', 'files'].join('')).update({ a: 1 })"],
    ])('is BLIND to %s (documented limit)', (_name, text) => {
      expect(scan(text)).toEqual({ direct: [], touching: [] })
    })

    it('records the uncovered shapes explicitly', () => {
      expect(NOT_COVERED.length).toBeGreaterThanOrEqual(5)
    })
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

  it('the marker is documented as a channel-level decision, not as proof of adopting a value', () => {
    const marker = (PROFILE_COLUMN_PROVENANCE as Record<string, { writers: readonly string[]; proves: string }>).niche_validated_for_channel_id
    expect(marker.proves).toMatch(/channel/i)
    expect(marker.proves).toMatch(/not .*value|never .*value|no value/i)
    expect(marker.writers.join(' ')).toContain('keep_current')
  })
})
