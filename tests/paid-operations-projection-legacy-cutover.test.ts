// D1/D2: the three DECISIONS recorded before the model (docs/operations/paid-operations-d1-d2-state-model.md), each pinned by targeted tests.
// DB-FREE, PROVIDER-FREE, PURE, no live request. SIMULATED: the triggers, CHECKs and the function privileges are MODELLED in
// tests/support/paid-operations-state-model.ts; whether a real PostgreSQL enforces them that way needs a real database.
//
//   Decision 1 -- the paid_results projection advances WITHOUT a generation column: it is derived from the generation table, advances by exactly one
//                 inside the commit transaction, and out-of-band divergence is detected and fails closed.
//   Decision 2 -- a legacy generation 1 that cannot be tied to a charge is marked `unlinked_legacy` (no credit transaction, its own deterministic
//                 operation id), and nothing may treat it as a refundable or creditable charge.
//   Decision 3 -- the old writers are excluded on a cut-over tool_type WITHOUT any caller identity (current_user inside a SECURITY DEFINER function is
//                 the owner for every caller): paid_results by a DATA INVARIANT every writer faces, spend by a hard-wired wrapper plus a core that
//                 service_role cannot EXECUTE (a privilege rule over a catalog snapshot); the cut-over is BLOCKED until that snapshot passes. On a
//                 tool_type that is NOT cut over there is NO fence (the documented residual).
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  ALL_PAID_RESULT_COLUMNS, DELIBERATELY_MUTABLE_FIELDS, GENERATION_BOUND_FIELDS, GENERATION_CARRIED_FIELDS, IDENTITY_FIELDS, LEGACY_SEED_TIME, PaidOperationsModel,
  carriedOf, catalogToday, checkInvariants, checkSpendFenceCatalog, deriveOperationId, digestOf, legacyOperationId, makeToken, referenceCatalogAfterSplit,
  type CarriedExtras, type CarriedField, type CatalogSnapshot, type PaidResultRow,
  type Binding,
} from './support/paid-operations-state-model'

const TOOL = 'title_studio'
const U1 = 'user-1'
const HASH = 'input-hash-1'
const binding = (o: Partial<Binding> = {}): Binding => ({ userId: U1, deviceDigest: 'device-a', toolType: TOOL, inputHash: HASH, ...o })
const nonce = (n: string) => `nonce-${n}`.padEnd(24, 'x')
const fresh = (o: { cutover?: boolean; guardRefund?: boolean } = {}) => {
  const m = new PaidOperationsModel({ balances: { [U1]: 100 }, featureTool: { opportunity_similar: 'opportunity_explain' }, guardRefundOfOpSpends: o.guardRefund ?? true, spendFence: referenceCatalogAfterSplit() })
  if (o.cutover !== false) m.enableCutover(TOOL)
  return m
}
const tok = (m: PaidOperationsModel, n: string, expected: number, b: Binding = binding()) => makeToken(b, { nonce: nonce(n), expectedGeneration: expected, issuedAt: m.nowMs })
const commit = (m: PaidOperationsModel, n: string, expected: number, b: Binding = binding(), resultJson: unknown = { v: n }, fields?: CarriedExtras) => m.commit({ token: tok(m, n, expected, b), request: b, resultJson, fields })
const debits = (m: PaidOperationsModel) => m.state.ledger.filter(l => l.reason === 'credit_spend')
const LEGACY = { v: 'legacy-content' }

describe('decision 1 -- the projection advances without a generation column', () => {
  it('the paid_results row keeps EXACTLY its existing columns after any number of commits (no generation column appears)', () => {
    const m = fresh(); commit(m, 'a', 0); commit(m, 'b', 1); commit(m, 'c', 2)
    expect(Object.keys(m.paidResultOf(binding())!).sort()).toEqual([...ALL_PAID_RESULT_COLUMNS].sort())
    expect(ALL_PAID_RESULT_COLUMNS).not.toContain('generation' as never)
  })

  it('the projection generation is DERIVED: it equals the max generation row and the row is its content (digest equality)', () => {
    const m = fresh()
    for (let i = 0; i < 3; i++) { commit(m, `n${i}`, i); expect(m.projectionStatus(binding())).toEqual({ generation: i + 1, consistent: true }) }
    const top = m.generationsOf(binding()).at(-1)!
    expect(digestOf(m.paidResultOf(binding())!.result_json)).toBe(top.resultDigest)
    expect(checkInvariants(m)).toEqual([])
  })

  it('it advances by EXACTLY one per commit and only through the compare-and-set: expected 0 over an existing generation is refused and the projection stays', () => {
    const m = fresh(); commit(m, 'a', 0); commit(m, 'b', 1)
    const before = JSON.stringify(m.state)
    expect(commit(m, 'c', 0)).toMatchObject({ ok: false, code: 'generation_conflict', currentGeneration: 2 })
    expect(commit(m, 'd', 5)).toMatchObject({ ok: false, code: 'generation_conflict', currentGeneration: 2 }) // skipping ahead is refused as well
    expect(JSON.stringify(m.state)).toBe(before)
    expect(m.generationsOf(binding()).map(g => g.generation)).toEqual([1, 2])
  })

  it('a stale writer (expected n-1) can never move the projection back to older content', () => {
    const m = fresh(); commit(m, 'a', 0); commit(m, 'b', 1)
    expect(commit(m, 'stale', 1, binding(), { v: 'stale' })).toMatchObject({ ok: false, code: 'generation_conflict' })
    expect(m.paidResultOf(binding())!.result_json).toEqual({ v: 'b' })
  })

  it('out-of-band divergence (a manual edit, a pre-cutover legacy writer) is DETECTED and the commit FAILS CLOSED with no debit', () => {
    const m = fresh(); commit(m, 'a', 0)
    m.paidResultOf(binding())!.result_json = { v: 'tampered' } // an edit that bypassed the fence (e.g. a superuser)
    expect(m.projectionStatus(binding())).toEqual({ generation: 1, consistent: false })
    expect(checkInvariants(m).some(x => x.startsWith('projection_diverged'))).toBe(true)
    const before = JSON.stringify(m.state)
    expect(commit(m, 'b', 1)).toEqual({ ok: false, code: 'projection_diverged' })
    expect(JSON.stringify(m.state)).toBe(before)
    expect(debits(m)).toHaveLength(1)
  })

  it('a row that is no longer `completed` while generations exist is divergence as well', () => {
    const m = fresh(); commit(m, 'a', 0)
    m.paidResultOf(binding())!.status = 'archived'
    expect(m.projectionStatus(binding()).consistent).toBe(false)
    expect(commit(m, 'b', 1)).toEqual({ ok: false, code: 'projection_diverged' })
  })

  it('a legacy completed row with NO generation row is an implicit generation 1: expected 0 is a conflict, so no second FIRST charge', () => {
    const m = fresh(); m.seedLegacyRow({ userId: U1, toolType: TOOL, inputHash: HASH, resultJson: LEGACY })
    expect(m.projectionStatus(binding())).toEqual({ generation: 1, consistent: true })
    const before = JSON.stringify(m.state)
    expect(commit(m, 'a', 0)).toEqual({ ok: false, code: 'generation_conflict', currentGeneration: 1 })
    expect(JSON.stringify(m.state)).toBe(before) // a REFUSED commit materialises nothing and debits nothing
    expect(debits(m)).toHaveLength(0)
  })

  it('copy-on-first-refresh: the first generation-aware commit over a legacy row keeps the old content as generation 1 BEFORE the projection moves to 2', () => {
    const m = fresh(); m.seedLegacyRow({ userId: U1, toolType: TOOL, inputHash: HASH, resultJson: LEGACY })
    expect(commit(m, 'a', 1)).toMatchObject({ ok: true, duplicate: false, generation: 2 })
    const gens = m.generationsOf(binding())
    expect(gens.map(g => g.generation)).toEqual([1, 2])
    expect(gens[0].resultJson).toEqual(LEGACY)
    expect(gens[0].resultDigest).toBe(digestOf(LEGACY))
    expect(m.paidResultOf(binding())!.result_json).toEqual({ v: 'a' })
    expect(m.projectionStatus(binding())).toEqual({ generation: 2, consistent: true })
    expect(debits(m)).toHaveLength(1) // only the NEW generation was charged
    expect(checkInvariants(m)).toEqual([])
  })

  it.each(['failed', 'refreshed', 'archived'] as const)('a legacy row with status %s counts as NO result (as the readers treat it today): expected 0, the commit replaces it with a completed row', (status) => {
    const m = fresh(); m.seedLegacyRow({ userId: U1, toolType: TOOL, inputHash: HASH, status, resultJson: LEGACY })
    expect(m.projectionStatus(binding())).toEqual({ generation: 0, consistent: true })
    expect(commit(m, 'a', 0)).toMatchObject({ ok: true, duplicate: false, generation: 1 })
    expect(m.paidResultOf(binding())).toMatchObject({ status: 'completed', result_json: { v: 'a' } })
    expect(m.state.generations.filter(g => g.origin === 'legacy_backfill')).toHaveLength(0) // a non-completed row is never materialised
    expect(checkInvariants(m)).toEqual([])
  })
})

describe('decision 2 -- a legacy generation 1 that cannot be tied to a charge is MARKED, never invented a charge for', () => {
  const refreshed = () => {
    const m = fresh()
    const row = m.seedLegacyRow({ userId: U1, toolType: TOOL, inputHash: HASH, resultJson: LEGACY })
    commit(m, 'a', 1)
    const gen1 = m.generationsOf(binding())[0]
    return { m, row, gen1 }
  }

  it('the materialised generation 1 is `unlinked_legacy`, has NO credit transaction, and its operation row is committed with origin legacy_backfill', () => {
    const { m, gen1 } = refreshed()
    expect(gen1).toMatchObject({ generation: 1, chargeLink: 'unlinked_legacy', creditTransactionId: null, origin: 'legacy_backfill' })
    expect(m.operation(gen1.operationId)).toMatchObject({ state: 'committed', origin: 'legacy_backfill', creditTransactionId: null, generation: 1, generationId: gen1.id })
  })

  it('NO ledger row exists for it: the materialisation never moves money, and the new generation 2 is the only linked one', () => {
    const { m, gen1 } = refreshed()
    expect(m.ledgerByRef(`op:${gen1.operationId}`)).toHaveLength(0)
    expect(m.state.ledger).toHaveLength(1)
    const gen2 = m.generationsOf(binding())[1]
    expect(gen2).toMatchObject({ chargeLink: 'linked', origin: 'atomic', creditTransactionId: m.state.ledger[0].id })
  })

  it('its operation id is deterministic from the paid_results row id, in its OWN namespace: stable, and never equal to a derived operation id', () => {
    const { row, gen1 } = refreshed()
    expect(gen1.operationId).toBe(legacyOperationId(row.id))
    expect(legacyOperationId(row.id)).toBe(legacyOperationId(row.id))
    expect(legacyOperationId(row.id)).not.toBe(deriveOperationId(makeToken(binding(), { nonce: nonce('a'), expectedGeneration: 1 })))
  })

  it('materialisation happens ONCE: a later refresh does not create a second legacy row', () => {
    const { m } = refreshed()
    commit(m, 'b', 2); commit(m, 'c', 3)
    expect(m.state.generations.filter(g => g.origin === 'legacy_backfill')).toHaveLength(1)
    expect(m.state.operations.filter(o => o.origin === 'legacy_backfill')).toHaveLength(1)
    expect(checkInvariants(m)).toEqual([])
  })

  it('a business credit on the legacy generation is REFUSED (charge_not_linkable): there is no charge to anchor it to', () => {
    const { m, gen1 } = refreshed()
    const before = JSON.stringify(m.state)
    expect(m.businessCredit({ operationId: gen1.operationId, amount: 1, operatorId: 'op-1' })).toEqual({ ok: false, code: 'charge_not_linkable' })
    expect(JSON.stringify(m.state)).toBe(before)
  })

  it('an atomic spend is refused by the refund and by the uncertain operator credit (an atomic spend is never an orphan); with the guard OFF the refund goes through and the invariants flag it', () => {
    const { m } = refreshed()
    const spend = debits(m)[0]
    expect(m.refundCreditSpend(spend.id)).toEqual({ ok: false, code: 'op_spend_not_refundable' })
    expect(m.operatorCreditUncertain({ spendLedgerId: spend.id, amount: 1, operatorId: 'op', evidence: ['x'] })).toEqual({ ok: false, code: 'atomic_spend_not_orphanable' })
    // negative control: without the guard the refund of an `op:` spend is possible -- that is exactly what the guard (D-d) is for
    const off = fresh({ guardRefund: false }); commit(off, 'a', 0)
    expect(off.refundCreditSpend(debits(off)[0].id)).toMatchObject({ ok: true })
    expect(checkInvariants(off).some(x => x.startsWith('refund_of_op_spend'))).toBe(true)
  })

  describe('a LEGACY orphan spend is a HUMAN decision under uncertainty -- never automatic, never a claim, never a change to results', () => {
    const withOrphan = () => { const m = fresh({ cutover: false }); const spend = m.seedLegacySpend({ userId: U1, feature: TOOL, cost: 2 }); return { m, spend } }

    it('is recorded with its OWN reason and reference (not credit_refund), the operator and the evidence, and marked uncertain', () => {
      const { m, spend } = withOrphan()
      const r = m.operatorCreditUncertain({ spendLedgerId: spend.id, amount: 2, operatorId: 'op-7', evidence: ['no completed row seen', 'older than the lock TTL'] })
      expect(r.ok).toBe(true)
      expect(m.ledgerByRef(`opc:${spend.id}`)[0]).toMatchObject({ reason: 'operator_credit_uncertain', delta: 2, relatedTransactionId: spend.id })
      expect(m.ledgerByRef(`opc:${spend.id}`)[0].note).toMatch(/^uncertain; operator:op-7; evidence:/)
      expect(m.state.ledger.filter(l => l.reason === 'credit_refund')).toHaveLength(0)
      expect(checkInvariants(m)).toEqual([])
    })

    it('needs an operator and non-empty evidence, decides once per spend, and never exceeds the spend', () => {
      const { m, spend } = withOrphan()
      expect(m.operatorCreditUncertain({ spendLedgerId: spend.id, amount: 2, operatorId: '', evidence: ['x'] })).toEqual({ ok: false, code: 'operator_required' })
      expect(m.operatorCreditUncertain({ spendLedgerId: spend.id, amount: 2, operatorId: 'op', evidence: [] })).toEqual({ ok: false, code: 'evidence_required' })
      expect(m.operatorCreditUncertain({ spendLedgerId: spend.id, amount: 3, operatorId: 'op', evidence: ['x'] })).toEqual({ ok: false, code: 'invalid_amount' })
      expect(m.operatorCreditUncertain({ spendLedgerId: 'nope', amount: 1, operatorId: 'op', evidence: ['x'] })).toEqual({ ok: false, code: 'spend_not_found' })
      expect(m.operatorCreditUncertain({ spendLedgerId: spend.id, amount: 2, operatorId: 'op', evidence: ['x'] }).ok).toBe(true)
      expect(m.operatorCreditUncertain({ spendLedgerId: spend.id, amount: 2, operatorId: 'op', evidence: ['x'] })).toEqual({ ok: false, code: 'already_decided' })
    })

    it('changes NOTHING about results: a late legacy save after the credit is still possible and is NOT blocked (the documented residual, only the report can show it)', () => {
      const { m, spend } = withOrphan()
      m.operatorCreditUncertain({ spendLedgerId: spend.id, amount: 2, operatorId: 'op', evidence: ['x'] })
      expect(m.legacySavePaidResult({ userId: U1, toolType: TOOL, inputHash: HASH, resultJson: { v: 'late' } })).toEqual({ ok: true, fenced: false })
      expect(m.paidResultOf(binding())?.result_json).toEqual({ v: 'late' })
      expect(m.state.generations).toHaveLength(0)
      expect(m.state.operations).toHaveLength(0)
    })

    it('the two instruments EXCLUDE each other for one spend, in both orders (needs the proposed guard in the real refund RPC; a change to an existing RPC)', () => {
      const a = withOrphan()
      a.m.operatorCreditUncertain({ spendLedgerId: a.spend.id, amount: 2, operatorId: 'op', evidence: ['x'] })
      expect(a.m.refundCreditSpend(a.spend.id)).toEqual({ ok: false, code: 'already_decided' })
      const b = withOrphan()
      expect(b.m.refundCreditSpend(b.spend.id)).toMatchObject({ ok: true })
      expect(b.m.operatorCreditUncertain({ spendLedgerId: b.spend.id, amount: 2, operatorId: 'op', evidence: ['x'] })).toEqual({ ok: false, code: 'already_decided' })
      expect(checkInvariants(a.m)).toEqual([]); expect(checkInvariants(b.m)).toEqual([])
    })
  })
})

describe('decision 3 -- the old writers are excluded on a cut-over tool_type WITHOUT a caller identity', () => {
  it('BEFORE the cutover nothing is fenced: the legacy save, delete and spend all work, and say so (fenced:false)', () => {
    const m = fresh({ cutover: false })
    expect(m.legacySavePaidResult({ userId: U1, toolType: TOOL, inputHash: HASH, resultJson: { v: 1 } })).toEqual({ ok: true, fenced: false })
    expect(m.legacySpend({ userId: U1, feature: TOOL, cost: 2, externalRef: 'spend:r1' })).toMatchObject({ ok: true, fenced: false })
    expect(m.legacyDeletePaidResult({ userId: U1, toolType: TOOL, inputHash: HASH })).toEqual({ ok: true, fenced: false })
  })

  it('AFTER the cutover a legacy upsert with other content and the delete are refused and the row is untouched; the commit still writes through the SAME check', () => {
    const m = fresh(); commit(m, 'a', 0)
    const before = JSON.stringify(m.state)
    expect(m.legacySavePaidResult({ userId: U1, toolType: TOOL, inputHash: HASH, resultJson: { v: 'old writer' } })).toEqual({ ok: false, code: 'cutover_write_forbidden' })
    expect(m.legacyDeletePaidResult({ userId: U1, toolType: TOOL, inputHash: HASH })).toEqual({ ok: false, code: 'cutover_write_forbidden' })
    expect(JSON.stringify(m.state)).toBe(before)
    expect(commit(m, 'b', 1)).toMatchObject({ ok: true, generation: 2 }) // no privileged identity: the generation row it inserted first justifies its projection write
  })

  it('the paid_results fence is an INVARIANT, not an identity: a legacy rewrite that equals the max-generation snapshot in EVERY carried field is an allowed no-op; changed content is refused', () => {
    const m = fresh(); commit(m, 'a', 0)
    const { result_json, ...extras } = m.generationsOf(binding())[0].carried
    expect(m.legacySavePaidResult({ userId: U1, toolType: TOOL, inputHash: HASH, resultJson: result_json, fields: extras })).toEqual({ ok: true, fenced: false })
    expect(m.projectionStatus(binding())).toEqual({ generation: 1, consistent: true })
    expect(m.legacySavePaidResult({ userId: U1, toolType: TOOL, inputHash: HASH, resultJson: { v: 'a', extra: 1 }, fields: extras })).toEqual({ ok: false, code: 'cutover_write_forbidden' })
    expect(checkInvariants(m)).toEqual([])
  })

  it('a legacy-only row (completed, NO generation row yet) is fenced too: the old writer cannot overwrite it after the cutover', () => {
    const m = fresh(); m.seedLegacyRow({ userId: U1, toolType: TOOL, inputHash: HASH, resultJson: LEGACY })
    expect(m.legacySavePaidResult({ userId: U1, toolType: TOOL, inputHash: HASH, resultJson: { v: 'overwrite' } })).toEqual({ ok: false, code: 'cutover_write_forbidden' })
    expect(m.legacySavePaidResult({ userId: U1, toolType: TOOL, inputHash: HASH, resultJson: LEGACY })).toEqual({ ok: false, code: 'cutover_write_forbidden' }) // the same result_json, but the real save call also moves last_refreshed_at (a protected field) and no generation justifies it
    expect(m.paidResultOf(binding())!.result_json).toEqual(LEGACY)
  })

  it('a LATE legacy writer (an in-flight old request after the cutover) cannot create a row for a new input', () => {
    const m = fresh()
    expect(m.legacySavePaidResult({ userId: U1, toolType: TOOL, inputHash: 'brand-new-input', resultJson: { v: 'late' } })).toEqual({ ok: false, code: 'cutover_write_forbidden' })
    expect(m.state.paidResults).toHaveLength(0)
  })

  it('the spend WRAPPER refuses a cut-over feature and the reserved op: namespace for EVERY caller (its decision depends on its arguments, never on who calls), while the commit still debits', () => {
    const m = fresh()
    const before = JSON.stringify(m.state)
    expect(m.legacySpend({ userId: U1, feature: TOOL, cost: 2, externalRef: 'spend:random' })).toEqual({ ok: false, code: 'cutover_spend_forbidden' })
    expect(m.legacySpend({ userId: U1, feature: TOOL, cost: 2, externalRef: 'op:forged' })).toEqual({ ok: false, code: 'reserved_external_ref' })
    expect(m.legacySpend({ userId: U1, feature: 'unrelated_tool', cost: 2, externalRef: 'op:forged' })).toEqual({ ok: false, code: 'reserved_external_ref' }) // reserved even off the cut-over tool
    expect(JSON.stringify(m.state)).toBe(before)
    expect(commit(m, 'a', 0)).toMatchObject({ ok: true }) // the commit reaches the CORE, not the wrapper
    expect(debits(m)).toHaveLength(1)
  })

  it('a direct spend on a feature that is NOT cut over still works (NO fence) and says fenced:false -- the documented, unprovable residual', () => {
    const m = fresh()
    expect(m.legacySpend({ userId: U1, feature: 'keyword_research', cost: 2, externalRef: 'spend:r' })).toMatchObject({ ok: true, fenced: false })
    expect(m.legacySavePaidResult({ userId: U1, toolType: 'keyword_research', inputHash: HASH, resultJson: {} })).toEqual({ ok: true, fenced: false })
  })

  it('the cut-over unit is the tool_type: a feature alias that maps to the cut-over tool_type (two routes, one feature) is fenced too', () => {
    const m = fresh(); m.enableCutover('opportunity_explain')
    expect(m.legacySpend({ userId: U1, feature: 'opportunity_explain', cost: 1, externalRef: 'spend:a' })).toEqual({ ok: false, code: 'cutover_spend_forbidden' })
    expect(m.legacySpend({ userId: U1, feature: 'opportunity_similar', cost: 1, externalRef: 'spend:b' })).toEqual({ ok: false, code: 'cutover_spend_forbidden' })
  })

  it('NO caller-supplied field can lift the fence: extra fields such as identity, actor or bypass are ignored by every legacy entry point', () => {
    const m = fresh()
    const extra = { identity: 'paid_commit_owner', actor: 'paid_commit_owner', bypass: true }
    expect(m.legacySavePaidResult({ userId: U1, toolType: TOOL, inputHash: HASH, resultJson: {}, ...extra } as never)).toEqual({ ok: false, code: 'cutover_write_forbidden' })
    expect(m.legacySpend({ userId: U1, feature: TOOL, cost: 2, externalRef: 'op:x', ...extra } as never)).toEqual({ ok: false, code: 'reserved_external_ref' })
    expect(m.legacySpend({ userId: U1, feature: TOOL, cost: 2, externalRef: 'spend:y', ...extra } as never)).toEqual({ ok: false, code: 'cutover_spend_forbidden' })
    expect(PaidOperationsModel.prototype.legacySavePaidResult.length).toBe(1) // one input object, nothing else to pass
  })

  it('only the commit debits a cut-over feature: after many commits every spend row on the tool carries an op: reference', () => {
    const m = fresh(); commit(m, 'a', 0); commit(m, 'b', 1); commit(m, 'c', 2)
    expect(debits(m).every(l => l.externalRef.startsWith('op:'))).toBe(true)
    expect(checkInvariants(m)).toEqual([])
  })

  describe('the back-step (rollback of a cut-over)', () => {
    it('is REFUSED after a committed, charge-linked atomic generation -- GENERATION 1 INCLUDED -- and the old "atomic gen1 -> rollback -> legacy overwrite" path stays closed', () => {
      const m = fresh(); commit(m, 'a', 0)
      expect(m.generationsOf(binding())).toHaveLength(1) // ONLY generation 1 exists
      expect(m.rollbackCutover(TOOL)).toEqual({ ok: false, code: 'atomic_generation_exists' })
      expect(m.state.cutover[TOOL]).toBe(true) // still cut over
      expect(m.legacySavePaidResult({ userId: U1, toolType: TOOL, inputHash: HASH, resultJson: { v: 'legacy overwrite' } })).toEqual({ ok: false, code: 'cutover_write_forbidden' })
      expect(m.paidResultOf(binding())!.result_json).toEqual({ v: 'a' }) // the content the debit paid for is intact
      expect(m.projectionStatus(binding())).toEqual({ generation: 1, consistent: true })
      expect(checkInvariants(m)).toEqual([])
    })

    it('is refused with later generations as well, and when the first atomic commit was over a legacy row (the linked generation 2 exists)', () => {
      const a = fresh(); commit(a, 'a', 0); commit(a, 'b', 1)
      expect(a.rollbackCutover(TOOL)).toEqual({ ok: false, code: 'atomic_generation_exists' })
      const b = fresh(); b.seedLegacyRow({ userId: U1, toolType: TOOL, inputHash: HASH, resultJson: LEGACY }); commit(b, 'a', 1)
      expect(b.generationsOf(binding()).map(g => g.chargeLink)).toEqual(['unlinked_legacy', 'linked'])
      expect(b.rollbackCutover(TOOL)).toEqual({ ok: false, code: 'atomic_generation_exists' })
    })

    it('is allowed only while NO atomic generation exists (nothing committed, or only a sealed tombstone), and then the legacy writer works again', () => {
      const empty = fresh()
      expect(empty.rollbackCutover(TOOL)).toEqual({ ok: true })
      expect(empty.legacySavePaidResult({ userId: U1, toolType: TOOL, inputHash: HASH, resultJson: { v: 'legacy' } })).toEqual({ ok: true, fenced: false })
      const sealed = fresh()
      sealed.seal({ token: tok(sealed, 'a', 0), request: binding() }, 'operator') // a tombstone carries no debit and no generation
      expect(sealed.rollbackCutover(TOOL)).toEqual({ ok: true })
    })

    it('is per tool_type: another tool_type\'s atomic generation does not block it', () => {
      const m = fresh(); m.enableCutover('thumbnail_studio')
      const other = binding({ toolType: 'thumbnail_studio' })
      commit(m, 'a', 0, other)
      expect(m.rollbackCutover(TOOL)).toEqual({ ok: true })
      expect(m.rollbackCutover('thumbnail_studio')).toEqual({ ok: false, code: 'atomic_generation_exists' })
    })
  })
})

describe('decision 3b -- the spend fence is a PRIVILEGE property over a catalog snapshot, not an identity claim (current_user inside a SECURITY DEFINER function is its owner)', () => {
  const variant = (mutate: (c: CatalogSnapshot) => void) => { const c = referenceCatalogAfterSplit(); mutate(c); return c }
  const fn = (c: CatalogSnapshot, name: string) => c.functions.find(f => f.name === name)!
  const role = (c: CatalogSnapshot, name: string) => c.roles.find(r => r.name === name)!

  it('the catalog the migrations pin TODAY (090: spend_credits, owner postgres, SECURITY DEFINER, EXECUTE for postgres and service_role, nothing else) does NOT satisfy the fence: the CUTOVER IS BLOCKED', () => {
    expect(checkSpendFenceCatalog(catalogToday())).toEqual(expect.arrayContaining(['spend_credits_core missing', 'paid_operation_commit missing']))
    const m = new PaidOperationsModel({ balances: { [U1]: 10 }, spendFence: catalogToday() })
    const r = m.enableCutover(TOOL)
    expect(r).toMatchObject({ ok: false, code: 'cutover_blocked_spend_fence_unverified' })
    expect(m.state.cutover).toEqual({})
    expect(m.commit({ token: tok(m, 'a', 0), request: binding(), resultJson: {} })).toEqual({ ok: false, code: 'tool_not_cutover' })
  })

  it('no catalog snapshot at all is unverified as well: no cut-over', () => {
    const m = new PaidOperationsModel({ balances: { [U1]: 10 } })
    expect(m.enableCutover(TOOL)).toMatchObject({ ok: false, code: 'cutover_blocked_spend_fence_unverified', violations: ['no catalog snapshot: the spend fence is unverified'] })
  })

  it('the reference catalog after a wrapper/core split satisfies every rule, and only then the cutover is allowed', () => {
    expect(checkSpendFenceCatalog(referenceCatalogAfterSplit())).toEqual([])
    const m = new PaidOperationsModel({ balances: { [U1]: 10 }, spendFence: referenceCatalogAfterSplit() })
    expect(m.enableCutover(TOOL)).toEqual({ ok: true, evidence: 'simulated' }) // NOT database evidence: the snapshot is authored in this test
    expect(m.state.cutover[TOOL]).toBe(true)
    expect(m.state.cutoverEvidence[TOOL]).toBe('simulated')
  })

  it.each([
    ['the core is executable by service_role (a direct caller could charge a cut-over feature)', (c: CatalogSnapshot) => fn(c, 'spend_credits_core').executeGrantees.push('service_role'), 'spend_credits_core executable by service_role'],
    ['the core is executable by PUBLIC', (c: CatalogSnapshot) => fn(c, 'spend_credits_core').executeGrantees.push('PUBLIC'), 'spend_credits_core executable by PUBLIC'],
    ['the core is executable by anon', (c: CatalogSnapshot) => fn(c, 'spend_credits_core').executeGrantees.push('anon'), 'spend_credits_core executable by anon'],
    ['the core is executable by authenticated', (c: CatalogSnapshot) => fn(c, 'spend_credits_core').executeGrantees.push('authenticated'), 'spend_credits_core executable by authenticated'],
    ['the legacy wrapper lost EXECUTE for service_role (the legacy callers would break)', (c: CatalogSnapshot) => { fn(c, 'spend_credits').executeGrantees = ['postgres'] }, 'legacy spend_credits not executable by service_role (legacy callers would break)'],
    ['the legacy wrapper is executable by anon', (c: CatalogSnapshot) => fn(c, 'spend_credits').executeGrantees.push('anon'), 'spend_credits executable by anon'],
    ['the commit function is executable by PUBLIC', (c: CatalogSnapshot) => fn(c, 'paid_operation_commit').executeGrantees.push('PUBLIC'), 'paid_operation_commit executable by PUBLIC'],
    ['the commit function is not SECURITY DEFINER (it would run with the caller\'s rights and could not reach the core)', (c: CatalogSnapshot) => { fn(c, 'paid_operation_commit').securityDefiner = false }, 'paid_operation_commit is not SECURITY DEFINER'],
    ['the commit owner differs from the core owner and cannot execute the core', (c: CatalogSnapshot) => { fn(c, 'paid_operation_commit').owner = 'paid_owner'; c.roles.push({ name: 'paid_owner', memberOf: [] }) }, 'commit owner cannot execute spend_credits_core'],
    ['service_role is a direct member of the core owner', (c: CatalogSnapshot) => role(c, 'service_role').memberOf.push('postgres'), 'service_role can become postgres, the owner of spend_credits_core'],
    ['service_role reaches the core owner through a CHAIN of memberships', (c: CatalogSnapshot) => { role(c, 'service_role').memberOf.push('ops_role'); c.roles.push({ name: 'ops_role', memberOf: ['postgres'] }) }, 'service_role can become postgres, the owner of spend_credits_core'],
    ['authenticator (the PostgREST login role) reaches the core owner', (c: CatalogSnapshot) => role(c, 'authenticator').memberOf.push('postgres'), 'authenticator can become postgres, the owner of spend_credits_core'],
  ])('a catalog where %s is a violation, and the cutover is blocked', (_name, mutate, expected) => {
    const c = variant(mutate)
    expect(checkSpendFenceCatalog(c)).toContain(expected)
    expect(new PaidOperationsModel({ balances: { [U1]: 10 }, spendFence: c }).enableCutover(TOOL)).toMatchObject({ ok: false, code: 'cutover_blocked_spend_fence_unverified' })
  })

  it('the ordinary Supabase role layout (authenticator may become anon, authenticated and service_role -- NOT the owner) is not a violation', () => {
    const c = referenceCatalogAfterSplit()
    expect(role(c, 'authenticator').memberOf).toEqual(['anon', 'authenticated', 'service_role'])
    expect(checkSpendFenceCatalog(c)).toEqual([])
  })
})

describe('paid_results fields -- generation-bound versus deliberately mutable (the real columns of 019 + 021, classified exactly once)', () => {
  const REAL_COLUMNS_FROM_SQL = (() => {
    const dir = path.join(process.cwd(), 'supabase', 'migrations')
    const cols = new Set<string>()
    const m019 = fs.readFileSync(path.join(dir, '019_paid_results.sql'), 'utf8')
    const start = m019.indexOf('CREATE TABLE IF NOT EXISTS paid_results (')
    const body = m019.slice(start, m019.indexOf(');', start))
    for (const line of body.split('\n')) { const hit = line.match(/^\s{2}([a-z_]+)\s+(UUID|TEXT|JSONB|NUMERIC|TIMESTAMPTZ)\b/); if (hit) cols.add(hit[1]) }
    for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.sql'))) {
      const sql = fs.readFileSync(path.join(dir, f), 'utf8')
      for (const stmt of sql.match(/ALTER TABLE\s+(?:public\.)?paid_results\b[^;]*;/gi) ?? []) for (const hit of stmt.matchAll(/ADD COLUMN\s+(?:IF NOT EXISTS\s+)?([a-z_]+)/gi)) cols.add(hit[1])
    }
    return [...cols].sort()
  })()

  const committed = (extras?: CarriedExtras, resultJson: unknown = { v: 'a' }) => { const m = fresh(); commit(m, 'a', 0, binding(), resultJson, extras); return m }
  const snapshotOf = (m: PaidOperationsModel) => { const { result_json, ...extras } = m.generationsOf(binding()).at(-1)!.carried; return { result_json, extras } }
  const CHANGED: Record<Exclude<CarriedField, 'result_json'>, unknown> = {
    normalized_input: 'other normalized', original_input: 'other original', main_category: 'other', specific_focus: 'other', region: 'XX', language: 'xx', platform: 'other',
    summary_json: { tampered: true }, credit_cost: 99, status: 'archived', last_refreshed_at: '2031-01-01T00:00:00.000Z', fresh_until: '2031-01-01T00:00:00.000Z', source_run_id: 'run-other',
    provider: 'other', model: 'other', prompt_template_id: 'other', prompt_version: 'other', estimated_cost: 5,
  }
  const OTHER_FIELDS = Object.keys(CHANGED) as Array<Exclude<CarriedField, 'result_json'>>

  describe('the classification covers every REAL column exactly once (derived from the migration SQL, so a new column fails here until it is classified)', () => {
    it('019 + 021 declare exactly the 27 columns the model classifies', () => {
      expect(REAL_COLUMNS_FROM_SQL).toEqual([...ALL_PAID_RESULT_COLUMNS].sort())
      expect(REAL_COLUMNS_FROM_SQL).toHaveLength(27)
    })
    it('the three classes are disjoint and nothing is classified twice', () => {
      const all = [...IDENTITY_FIELDS, ...GENERATION_CARRIED_FIELDS, ...DELIBERATELY_MUTABLE_FIELDS]
      expect(new Set(all).size).toBe(all.length)
      expect([...GENERATION_BOUND_FIELDS].sort()).toEqual([...IDENTITY_FIELDS, ...GENERATION_CARRIED_FIELDS].sort())
      expect([...DELIBERATELY_MUTABLE_FIELDS]).toEqual(['updated_at', 'last_opened_at', 'linked_video_idea_id'])
    })
    it('the model and its generation rows carry exactly the carried fields', () => {
      const m = committed()
      expect(Object.keys(m.generationsOf(binding())[0].carried).sort()).toEqual([...GENERATION_CARRIED_FIELDS].sort())
    })
  })

  describe('the writers the classification rests on (a source-policy test: a new writer of paid_results fails here until it is classified)', () => {
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(path.join(dir, e.name))) : /\.(ts|tsx)$/.test(e.name) ? [path.join(dir, e.name)] : [])
    const files = [...walk('app'), ...walk('lib')]
    it('the only writes to paid_results in app/ and lib/ are the savePaidResult upsert and the openPaidResult last_opened_at update', () => {
      const writers: Array<{ file: string; op: string; snippet: string }> = []
      for (const file of files) {
        const lines = fs.readFileSync(file, 'utf8').split('\n')
        lines.forEach((line, i) => {
          if (!/from\('paid_results'\)/.test(line)) return
          const window = lines.slice(i, i + 6).join('\n')
          const op = window.match(/\.(insert|upsert|update|delete)\(/)
          if (op) writers.push({ file: file.split(path.sep).join('/'), op: op[1], snippet: window })
        })
      }
      expect(writers.map(w => w.file + ':' + w.op).sort()).toEqual(['lib/paid-results/paid-results-service.ts:update', 'lib/paid-results/paid-results-service.ts:upsert'])
      expect(writers.find(w => w.op === 'update')!.snippet).toMatch(/\.update\(\{ last_opened_at: now \}\)/)
    })
    it('linked_video_idea_id is written only by the savePaidResult payload (the FK ON DELETE SET NULL of 021 is the only other writer, and it is a database action)', () => {
      const users = files.filter(f => fs.readFileSync(f, 'utf8').includes('linked_video_idea_id')).map(f => f.split(path.sep).join('/'))
      expect(users).toEqual(['lib/paid-results/paid-results-service.ts'])
    })
  })

  describe('a commit stores every carried field in the generation snapshot AND in the row', () => {
    it('summary_json, credit_cost (the price), source_run_id, freshness and provenance are carried; an older generation keeps ITS OWN values', () => {
      const m = fresh()
      commit(m, 'a', 0, binding(), { v: 'a' }, { summary_json: { s: 1 }, source_run_id: 'run-1', provider: 'p1', fresh_until: '2030-01-01T00:00:00.000Z' })
      commit(m, 'b', 1, binding(), { v: 'b' }, { summary_json: { s: 2 }, source_run_id: 'run-2', provider: 'p2' })
      const [g1, g2] = m.generationsOf(binding())
      expect(g1.carried).toMatchObject({ summary_json: { s: 1 }, credit_cost: 2, source_run_id: 'run-1', provider: 'p1', fresh_until: '2030-01-01T00:00:00.000Z', status: 'completed' })
      expect(g2.carried).toMatchObject({ summary_json: { s: 2 }, credit_cost: 2, source_run_id: 'run-2', provider: 'p2', fresh_until: null })
      expect(carriedOf(m.paidResultOf(binding())!)).toEqual(g2.carried)
      expect(checkInvariants(m)).toEqual([])
    })
    it('the first generation-aware commit over a legacy row copies EVERY carried field of that row into generation 1', () => {
      const m = fresh()
      const row = m.seedLegacyRow({ userId: U1, toolType: TOOL, inputHash: HASH, resultJson: LEGACY, fields: { summary_json: { s: 'legacy' }, source_run_id: 'legacy-run', provider: 'legacy-provider', credit_cost: 3 } })
      const before = carriedOf(structuredClone(row))
      commit(m, 'a', 1)
      expect(m.generationsOf(binding())[0].carried).toEqual(before)
      expect(m.generationsOf(binding())[0].carried).toMatchObject({ summary_json: { s: 'legacy' }, source_run_id: 'legacy-run', credit_cost: 3 })
    })
  })

  describe('an IDENTICAL result_json does not let a legacy writer change a protected field on a cut-over tool_type', () => {
    it.each(OTHER_FIELDS)('legacy upsert, result_json identical, only %s differs -> refused, the row and the generation snapshot are untouched', (field) => {
      const m = committed()
      const { result_json, extras } = snapshotOf(m)
      const before = JSON.stringify(m.state)
      expect(m.legacySavePaidResult({ userId: U1, toolType: TOOL, inputHash: HASH, resultJson: result_json, fields: { ...extras, [field]: CHANGED[field] } })).toEqual({ ok: false, code: 'cutover_write_forbidden' })
      expect(JSON.stringify(m.state)).toBe(before)
      expect(m.projectionStatus(binding())).toEqual({ generation: 1, consistent: true })
    })

    it.each(['summary_json', 'credit_cost', 'source_run_id', 'status'] as const)('a plain UPDATE of %s alone (result_json untouched) is refused as well', (field) => {
      const m = committed({ summary_json: { s: 1 }, source_run_id: 'run-1' })
      const before = JSON.stringify(m.state)
      expect(m.legacyUpdatePaidResult({ userId: U1, toolType: TOOL, inputHash: HASH, patch: { [field]: CHANGED[field] } })).toEqual({ ok: false, code: 'cutover_write_forbidden' })
      expect(JSON.stringify(m.state)).toBe(before)
    })

    it('summary_json, credit_cost, source_run_id and status together, result_json identical: refused', () => {
      const m = committed()
      const { result_json, extras } = snapshotOf(m)
      expect(m.legacySavePaidResult({ userId: U1, toolType: TOOL, inputHash: HASH, resultJson: result_json, fields: { ...extras, summary_json: CHANGED.summary_json, credit_cost: 99, source_run_id: 'run-other', status: 'archived' } })).toEqual({ ok: false, code: 'cutover_write_forbidden' })
    })

    it('the REAL savePaidResult call shape (same result_json, default summary_json {}, credit_cost 0, fresh timestamps) is refused', () => {
      const m = committed()
      expect(m.legacySavePaidResult({ userId: U1, toolType: TOOL, inputHash: HASH, resultJson: { v: 'a' } })).toEqual({ ok: false, code: 'cutover_write_forbidden' })
    })

    it('a replay that equals the snapshot in EVERY carried field is the only allowed legacy upsert (a no-op that moves only deliberately mutable fields)', () => {
      const m = committed({ summary_json: { s: 1 }, source_run_id: 'run-1' })
      const { result_json, extras } = snapshotOf(m)
      m.advance(5000)
      expect(m.legacySavePaidResult({ userId: U1, toolType: TOOL, inputHash: HASH, resultJson: result_json, fields: extras })).toEqual({ ok: true, fenced: false })
      expect(carriedOf(m.paidResultOf(binding())!)).toEqual(m.generationsOf(binding())[0].carried)
      expect(m.paidResultOf(binding())!.updated_at).toBe(new Date(5000).toISOString()) // the deliberately mutable fields moved
      expect(checkInvariants(m)).toEqual([])
    })

    it('a legacy-only row (no generation yet) is protected in every carried field too', () => {
      const m = fresh(); m.seedLegacyRow({ userId: U1, toolType: TOOL, inputHash: HASH, resultJson: LEGACY, fields: { summary_json: { s: 'legacy' }, source_run_id: 'legacy-run', credit_cost: 3 } })
      const before = JSON.stringify(m.state)
      for (const field of ['summary_json', 'credit_cost', 'source_run_id', 'status'] as const)
        expect(m.legacyUpdatePaidResult({ userId: U1, toolType: TOOL, inputHash: HASH, patch: { [field]: CHANGED[field] } }), field).toEqual({ ok: false, code: 'cutover_write_forbidden' })
      expect(JSON.stringify(m.state)).toBe(before)
    })
  })

  describe('identity fields never change, on any write', () => {
    it.each(IDENTITY_FIELDS)('an UPDATE that changes %s is refused', (field) => {
      const m = committed()
      const before = JSON.stringify(m.state)
      expect(m.legacyUpdatePaidResult({ userId: U1, toolType: TOOL, inputHash: HASH, patch: { [field]: field === 'created_at' ? '2031-01-01T00:00:00.000Z' : 'changed' } as Partial<PaidResultRow> })).toEqual({ ok: false, code: 'cutover_write_forbidden' })
      expect(JSON.stringify(m.state)).toBe(before)
    })
  })

  describe('the deliberately mutable fields stay writable on a cut-over tool_type (cache hits and FK actions must keep working)', () => {
    it.each(DELIBERATELY_MUTABLE_FIELDS)('an UPDATE of %s alone is allowed and leaves the projection consistent', (field) => {
      const m = committed()
      const value = field === 'linked_video_idea_id' ? 'idea-1' : '2031-01-01T00:00:00.000Z'
      expect(m.legacyUpdatePaidResult({ userId: U1, toolType: TOOL, inputHash: HASH, patch: { [field]: value } })).toEqual({ ok: true, fenced: false })
      expect(m.paidResultOf(binding())![field]).toBe(value)
      expect(m.projectionStatus(binding())).toEqual({ generation: 1, consistent: true })
      expect(checkInvariants(m)).toEqual([])
    })
    it('the FK ON DELETE SET NULL (linked_video_idea_id -> null) is an UPDATE that is allowed', () => {
      const m = committed()
      m.legacyUpdatePaidResult({ userId: U1, toolType: TOOL, inputHash: HASH, patch: { linked_video_idea_id: 'idea-1' } })
      expect(m.legacyUpdatePaidResult({ userId: U1, toolType: TOOL, inputHash: HASH, patch: { linked_video_idea_id: null } })).toEqual({ ok: true, fenced: false })
      expect(m.paidResultOf(binding())!.linked_video_idea_id).toBeNull()
    })
    it('openPaidResult (a last_opened_at UPDATE) works on a legacy-only row after the cutover: opening an old result keeps working', () => {
      const m = fresh(); m.seedLegacyRow({ userId: U1, toolType: TOOL, inputHash: HASH, resultJson: LEGACY })
      expect(m.legacyUpdatePaidResult({ userId: U1, toolType: TOOL, inputHash: HASH, patch: { last_opened_at: '2031-01-01T00:00:00.000Z' } })).toEqual({ ok: true, fenced: false })
      expect(m.paidResultOf(binding())!.last_opened_at).toBe('2031-01-01T00:00:00.000Z')
      expect(m.paidResultOf(binding())!.created_at).toBe(LEGACY_SEED_TIME)
    })
    it('a MIXED update (a mutable field plus one protected field) is refused as a whole: the mutable field does not move either', () => {
      const m = committed()
      const before = JSON.stringify(m.state)
      expect(m.legacyUpdatePaidResult({ userId: U1, toolType: TOOL, inputHash: HASH, patch: { last_opened_at: '2031-01-01T00:00:00.000Z', summary_json: { tampered: true } } })).toEqual({ ok: false, code: 'cutover_write_forbidden' })
      expect(JSON.stringify(m.state)).toBe(before)
    })
  })

  describe('divergence is detected over ALL carried fields, not only result_json', () => {
    it.each(OTHER_FIELDS)('a direct edit of %s makes the projection inconsistent, and the next commit FAILS CLOSED with no debit', (field) => {
      const m = committed()
      ;(m.paidResultOf(binding())! as Record<string, unknown>)[field] = CHANGED[field] // an edit that bypassed the fence (e.g. a superuser)
      expect(m.projectionStatus(binding()).consistent).toBe(false)
      expect(checkInvariants(m).some(x => x.startsWith('projection_diverged'))).toBe(true)
      const before = JSON.stringify(m.state)
      expect(commit(m, 'b', 1)).toEqual({ ok: false, code: 'projection_diverged' })
      expect(JSON.stringify(m.state)).toBe(before)
    })
  })

  describe('a tool_type that is NOT cut over has NO field protection (the documented residual)', () => {
    it('every protected field can be changed by a legacy writer, and it says fenced:false', () => {
      const m = fresh({ cutover: false })
      m.legacySavePaidResult({ userId: U1, toolType: TOOL, inputHash: HASH, resultJson: { v: 1 } })
      expect(m.legacySavePaidResult({ userId: U1, toolType: TOOL, inputHash: HASH, resultJson: { v: 1 }, fields: { summary_json: { x: 1 }, credit_cost: 9, source_run_id: 'r', status: 'archived' } })).toEqual({ ok: true, fenced: false })
      expect(m.legacyUpdatePaidResult({ userId: U1, toolType: TOOL, inputHash: HASH, patch: { tool_type: 'other' } })).toEqual({ ok: true, fenced: false })
    })
  })
})

describe('the simulated catalog is never reported as database evidence', () => {
  it('the snapshots this model builds are labelled authored_in_test / derived_from_migrations -- neither is a pg_catalog query', () => {
    expect(referenceCatalogAfterSplit().provenance).toBe('authored_in_test')
    expect(catalogToday().provenance).toBe('derived_from_migrations')
  })
  it('a cut-over enabled on such a snapshot is recorded with evidence simulated', () => {
    const m = new PaidOperationsModel({ balances: { [U1]: 10 }, spendFence: referenceCatalogAfterSplit() })
    expect(m.enableCutover(TOOL)).toEqual({ ok: true, evidence: 'simulated' })
    expect(m.state.cutoverEvidence).toEqual({ [TOOL]: 'simulated' })
    expect(m.rollbackCutover(TOOL)).toEqual({ ok: true })
    expect(m.state.cutoverEvidence).toEqual({}) // the label goes away with the cut-over
  })
  it('the evidence label follows ONLY the snapshot provenance (a mapping test: no database was read, and none is claimed)', () => {
    const labelled: CatalogSnapshot = { ...referenceCatalogAfterSplit(), provenance: 'pg_catalog_query' }
    const m = new PaidOperationsModel({ balances: { [U1]: 10 }, spendFence: labelled })
    expect(m.enableCutover(TOOL)).toEqual({ ok: true, evidence: 'database' })
  })
  it('source policy: no file in this repository except the model and its tests ever labels a snapshot pg_catalog_query', () => {
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? (e.name === 'node_modules' || e.name === '.next' ? [] : walk(path.join(dir, e.name))) : /\.(ts|tsx|js|mjs)$/.test(e.name) ? [path.join(dir, e.name)] : [])
    const hits = [...walk('app'), ...walk('lib'), ...walk('scripts'), ...walk('tests')].filter(f => fs.readFileSync(f, 'utf8').includes('pg_catalog_query')).map(f => f.split(path.sep).join('/')).sort()
    expect(hits).toEqual(['tests/paid-operations-projection-legacy-cutover.test.ts', 'tests/support/paid-operations-state-model.ts'])
  })
})
