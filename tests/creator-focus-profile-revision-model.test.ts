// Creator Focus 2B: the profiles field-revision invariants, tested on the TypeScript REFERENCE MODEL of migration 094
// (tests/support/profile-revision-model.ts) and on the real decision core. DB-free.
//
// WHAT THIS PROVES: the specification is self-consistent, and lib/creator-focus behaves correctly on revisions that
// follow it (focus A -> B -> A, form re-saves, ...).
// WHAT THIS DOES NOT PROVE: that the migration's plpgsql behaves like the model. That is an OPEN item that needs a real
// database (see docs/operations/profiles-field-revision.md). The SQL text is pinned separately by
// 094-profiles-field-revision-migration-source-policy.test.ts.
import { describe, expect, it } from 'vitest'
import { applyDecisions, type FocusDecisionEvent } from '@/lib/creator-focus'
import { candidate } from './support/creator-focus-fixtures'
import { CHANNEL_A, COOKING, FOCUS, confirmEvent, world } from './support/creator-focus-decision-fixtures'
import {
  ProfileRevisionModel,
  isCanonicalRevisionText,
  revisionViolations,
  type ModelRow,
} from './support/profile-revision-model'

const U = 'user-1'
const revs = (row: ModelRow) => [row.specific_focus_revision, row.main_category_revision]

describe('INSERT: always fresh, never client-chosen', () => {
  it('both fields get distinct, positive revisions', () => {
    const m = new ProfileRevisionModel()
    const row = m.insert(U, { specific_focus: FOCUS, main_category: 'health' })
    expect(row.specific_focus_revision).toBeGreaterThan(0)
    expect(row.main_category_revision).toBeGreaterThan(0)
    expect(row.specific_focus_revision).not.toBe(row.main_category_revision)
  })

  it('a client-supplied revision is OVERWRITTEN', () => {
    const m = new ProfileRevisionModel()
    const row = m.insert(U, { specific_focus: FOCUS, specific_focus_revision: 999, main_category_revision: 999 })
    expect(revs(row)).not.toContain(999)
    expect(m.everIssued).toContain(row.specific_focus_revision)
    expect(m.everIssued).toContain(row.main_category_revision)
  })

  it('two users never share a revision', () => {
    const m = new ProfileRevisionModel()
    const a = m.insert('a', { specific_focus: FOCUS })
    const b = m.insert('b', { specific_focus: FOCUS })
    expect(new Set([...revs(a), ...revs(b)]).size).toBe(4)
  })

  it('with the trigger disabled and no DEFAULT, an INSERT without revisions fails (NOT NULL) instead of getting a silent value', () => {
    const m = new ProfileRevisionModel()
    m.triggersDisabled = true
    expect(() => m.insert(U, { specific_focus: FOCUS })).toThrow(/not-null/)
  })
})

describe('UPDATE: a new revision exactly when the value changes', () => {
  it('a form re-save that writes every field with the SAME values changes no revision', () => {
    const m = new ProfileRevisionModel()
    const before = m.insert(U, { specific_focus: FOCUS, main_category: 'health' })
    const after = m.update(U, { specific_focus: FOCUS, main_category: 'health' })
    expect(revs(after)).toEqual(revs(before))
  })

  it('NULL -> NULL is unchanged; NULL -> value and value -> NULL are changes', () => {
    const m = new ProfileRevisionModel()
    const r0 = m.insert(U, { specific_focus: null })
    const r1 = m.update(U, { specific_focus: null })
    expect(r1.specific_focus_revision).toBe(r0.specific_focus_revision)
    const r2 = m.update(U, { specific_focus: FOCUS })
    expect(r2.specific_focus_revision).not.toBe(r1.specific_focus_revision)
    const r3 = m.update(U, { specific_focus: null })
    expect(r3.specific_focus_revision).not.toBe(r2.specific_focus_revision)
  })

  it('a column that is not in the SET list is unchanged', () => {
    const m = new ProfileRevisionModel()
    const before = m.insert(U, { specific_focus: FOCUS, main_category: 'health' })
    const after = m.update(U, {}) // e.g. channel_usage_mode / onboarding_completed updates elsewhere on the row
    expect(revs(after)).toEqual(revs(before))
  })

  it('a client-supplied revision is ignored, with or without a value change', () => {
    const m = new ProfileRevisionModel()
    const before = m.insert(U, { specific_focus: FOCUS, main_category: 'health' })
    const same = m.update(U, { specific_focus: FOCUS, specific_focus_revision: 12345 })
    expect(same.specific_focus_revision).toBe(before.specific_focus_revision)
    const changed = m.update(U, { specific_focus: COOKING, specific_focus_revision: before.specific_focus_revision })
    expect(changed.specific_focus_revision).not.toBe(before.specific_focus_revision)
    expect(m.everIssued).toContain(changed.specific_focus_revision)
  })

  it('REGRESSION: A -> B -> A gives three DIFFERENT revisions (the third is never the first)', () => {
    const m = new ProfileRevisionModel()
    const a1 = m.insert(U, { specific_focus: FOCUS }).specific_focus_revision
    const b = m.update(U, { specific_focus: COOKING }).specific_focus_revision
    const a2 = m.update(U, { specific_focus: FOCUS }).specific_focus_revision
    expect(new Set([a1, b, a2]).size).toBe(3)
  })

  it('the fields are independent: changing the focus does not touch the category revision, and vice versa', () => {
    const m = new ProfileRevisionModel()
    const before = m.insert(U, { specific_focus: FOCUS, main_category: 'health' })
    const focusChanged = m.update(U, { specific_focus: COOKING })
    expect(focusChanged.main_category_revision).toBe(before.main_category_revision)
    expect(focusChanged.specific_focus_revision).not.toBe(before.specific_focus_revision)
    const categoryChanged = m.update(U, { main_category: 'lifestyle' })
    expect(categoryChanged.specific_focus_revision).toBe(focusChanged.specific_focus_revision)
    expect(categoryChanged.main_category_revision).not.toBe(before.main_category_revision)
  })

  it('a change that only differs in whitespace is a change (the trigger compares the raw column value)', () => {
    const m = new ProfileRevisionModel()
    const before = m.insert(U, { specific_focus: FOCUS })
    const after = m.update(U, { specific_focus: `${FOCUS} ` })
    expect(after.specific_focus_revision).not.toBe(before.specific_focus_revision)
  })
})

describe('the sequence: uniqueness, not order, not continuity', () => {
  it('aborted transactions burn values: later revisions are unique but NOT contiguous', () => {
    const m = new ProfileRevisionModel()
    const first = m.insert(U, { specific_focus: FOCUS })
    m.abortedTransaction(3)
    const after = m.update(U, { specific_focus: COOKING })
    expect(after.specific_focus_revision - first.main_category_revision).toBeGreaterThan(1)
    expect(new Set(m.everIssued).size).toBe(m.everIssued.length) // never a value twice
  })

  it('across many mixed operations no value is ever issued twice', () => {
    const m = new ProfileRevisionModel()
    for (let u = 0; u < 20; u++) m.insert(`u${u}`, { specific_focus: 'a', main_category: 'health' })
    for (let step = 0; step < 400; step++) {
      const user = `u${step % 20}`
      if (step % 7 === 0) m.abortedTransaction(1 + (step % 3))
      m.update(user, { specific_focus: step % 3 === 0 ? 'a' : step % 3 === 1 ? 'b' : 'a' })
    }
    expect(new Set(m.everIssued).size).toBe(m.everIssued.length)
    const live = [...m.rows.values()].flatMap(revs)
    expect(new Set(live).size).toBe(live.length) // the live revisions are pairwise different too
  })

  it('exhaustion is an error (NO CYCLE), never a wrap-around that could reuse a revision', () => {
    const m = new ProfileRevisionModel(3) // MAXVALUE 3
    m.nextval()
    m.nextval()
    m.nextval()
    expect(() => m.nextval()).toThrow(/maximum value/)
    expect(m.everIssued).toEqual([1, 2, 3]) // nothing was handed out twice
  })

  it('the text form is a canonical decimal of at most 19 digits for every bigint the sequence can issue', () => {
    const bigintMax = '9223372036854775807' // 2^63 - 1, the sequence's MAXVALUE
    for (const text of ['1', '9', '10', '12345678901234567', bigintMax]) expect(isCanonicalRevisionText(text)).toBe(true)
    expect(bigintMax).toHaveLength(19)
    expect(isCanonicalRevisionText('0123')).toBe(false)
  })
})

describe('the AFTER assertion (fail-closed), mirrored', () => {
  const base: ModelRow = { user_id: U, specific_focus: 'a', main_category: 'health', specific_focus_revision: 1, main_category_revision: 2 }
  const issued = 5

  it('a consistent transition has no violation', () => {
    expect(revisionViolations(base, { ...base }, issued)).toEqual([])
    expect(revisionViolations(base, { ...base, specific_focus: 'b', specific_focus_revision: 3 }, issued)).toEqual([])
  })

  it.each([
    ['a value change without a new revision', { specific_focus: 'b' }],
    ['a revision change without a value change', { specific_focus_revision: 3 }],
    ['a category change without a new revision', { main_category: 'lifestyle' }],
    ['a revision that was never issued', { specific_focus: 'b', specific_focus_revision: 99 }],
    ['a non-positive revision', { specific_focus: 'b', specific_focus_revision: 0 }],
    ['two fields sharing a revision', { specific_focus: 'b', specific_focus_revision: 2 }],
  ])('flags %s', (_name, patch) => {
    expect(revisionViolations(base, { ...base, ...patch }, issued).length).toBeGreaterThan(0)
  })

  it('DOCUMENTED LIMIT: with the triggers disabled, a revision can be reused and nothing notices', () => {
    const m = new ProfileRevisionModel()
    const first = m.insert(U, { specific_focus: FOCUS })
    m.update(U, { specific_focus: COOKING })
    m.triggersDisabled = true
    // privileged intervention: the old revision is written back together with the old value (A -> B -> A, revision reused)
    const back = m.update(U, { specific_focus: FOCUS, specific_focus_revision: first.specific_focus_revision })
    expect(back.specific_focus_revision).toBe(first.specific_focus_revision)
  })
})

describe('the decision core on revisions that follow the model (no database)', () => {
  const candidates = [candidate(FOCUS, 'health', CHANNEL_A), candidate(COOKING, 'health', CHANNEL_A)]
  const read = (m: ProfileRevisionModel, events: FocusDecisionEvent[]) => {
    const s = m.snapshot(U)
    const w = world({ focus: s.value.specific_focus, category: s.value.main_category, fRev: s.revision.specific_focus, cRev: s.revision.main_category, candidates })
    return applyDecisions(w.profile, w.snapshot, events)
  }

  it('REGRESSION: a category confirmation does not come back when the FOCUS goes A -> B -> A (category untouched)', () => {
    const m = new ProfileRevisionModel()
    m.insert(U, { specific_focus: FOCUS, main_category: 'health' })
    const seen = m.snapshot(U)
    const confirmation = confirmEvent(1, 'main_category', { revision: seen.revision.main_category, focusRevision: seen.revision.specific_focus })
    expect(read(m, [confirmation]).read_model.claims.main_category.confirmation.status).toBe('valid')

    m.update(U, { specific_focus: COOKING })
    expect(read(m, [confirmation]).read_model.claims.main_category.confirmation.status).toBe('invalidated_by_value_change')

    m.update(U, { specific_focus: FOCUS })
    const back = m.snapshot(U)
    expect(back.revision.main_category).toBe(seen.revision.main_category) // the category revision never changed
    expect(back.revision.specific_focus).not.toBe(seen.revision.specific_focus)
    const result = read(m, [confirmation])
    expect(result.read_model.claims.main_category.confirmation.status).toBe('invalidated_by_value_change')
    expect(result.profile.claims.main_category?.origin).toBe('unknown')
  })

  it('REGRESSION: a focus confirmation does not come back when the focus goes A -> B -> A', () => {
    const m = new ProfileRevisionModel()
    m.insert(U, { specific_focus: FOCUS, main_category: 'health' })
    const confirmation = confirmEvent(1, 'specific_focus', { revision: m.snapshot(U).revision.specific_focus })
    expect(read(m, [confirmation]).read_model.claims.specific_focus.confirmation.status).toBe('valid')
    m.update(U, { specific_focus: COOKING })
    m.update(U, { specific_focus: FOCUS })
    expect(read(m, [confirmation]).read_model.claims.specific_focus.confirmation.status).toBe('invalidated_by_value_change')
  })

  it('a profile form re-save with unchanged values does NOT end the confirmations', () => {
    const m = new ProfileRevisionModel()
    m.insert(U, { specific_focus: FOCUS, main_category: 'health' })
    const seen = m.snapshot(U)
    const events = [
      confirmEvent(1, 'specific_focus', { revision: seen.revision.specific_focus }),
      confirmEvent(2, 'main_category', { revision: seen.revision.main_category, focusRevision: seen.revision.specific_focus }),
    ]
    m.update(U, { specific_focus: FOCUS, main_category: 'health' }) // the form writes every field on every save
    const result = read(m, events)
    expect(result.read_model.claims.specific_focus.confirmation.status).toBe('valid')
    expect(result.read_model.claims.main_category.confirmation.status).toBe('valid')
  })
})
