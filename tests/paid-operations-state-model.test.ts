// D1/D2 state model, contract tests (tests/support/paid-operations-state-model.ts). DB-FREE, PROVIDER-FREE, PURE, no live request.
// SIMULATED: the model is an executable specification of the design. It proves the DESIGN is consistent; it does NOT prove how a real PostgreSQL
// behaves (advisory locks, READ COMMITTED re-read after a lock, trigger / CHECK enforcement, function privileges) -- that needs a real database.
//
// Covers: the transition table (atomic operations), the intent-token binding, the read-only status (R class), seal / tombstone, business credit,
// the race matrix (EVERY permutation of the calls, lock-serialised), the crash matrix (a crash at every step rolls the whole transaction back),
// response loss, and the mandatory lock order (with a negative control that really deadlocks in the simulation).
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  COMMIT_STEPS, FAIL_CLOSED_REOPEN_GATE, SEAL_STEPS, MIN_NONCE_LENGTH, ModelCrash, PaidOperationsModel, assertLockOrder, checkInvariants, deriveOperationId, makeToken,
  referenceCatalogAfterSplit, simulateLockAcquisition, type Binding, type CommitResult, type IntentToken,
} from './support/paid-operations-state-model'

const TOOL = 'title_studio'
const U1 = 'user-1'
const U2 = 'user-2'
const HASH = 'input-hash-1'
const binding = (o: Partial<Binding> = {}): Binding => ({ userId: U1, deviceDigest: 'device-a', toolType: TOOL, inputHash: HASH, ...o })
const nonce = (n: string) => `nonce-${n}`.padEnd(24, 'x')
const fresh = () => { const m = new PaidOperationsModel({ balances: { [U1]: 100, [U2]: 100 }, spendFence: referenceCatalogAfterSplit() }); m.enableCutover(TOOL); return m }
const tok = (m: PaidOperationsModel, n: string, expected: number, b: Binding = binding()): IntentToken => makeToken(b, { nonce: nonce(n), expectedGeneration: expected, issuedAt: m.nowMs })
const commit = (m: PaidOperationsModel, n: string, expected: number, b: Binding = binding(), resultJson: unknown = { v: n }) => m.commit({ token: tok(m, n, expected, b), request: b, resultJson })
const debits = (m: PaidOperationsModel) => m.state.ledger.filter(l => l.reason === 'credit_spend')
const okFresh = (r: CommitResult) => r.ok && !r.duplicate

describe('transition table -- atomic operations (the rows of the plan)', () => {
  it('row 1: a valid first commit debits once, writes the generation, advances the projection and the operation row, all linked', () => {
    const m = fresh()
    const r = commit(m, 'a', 0)
    expect(r).toMatchObject({ ok: true, duplicate: false, generation: 1 })
    const opId = deriveOperationId(tok(m, 'a', 0))
    expect(debits(m)).toHaveLength(1)
    expect(debits(m)[0]).toMatchObject({ externalRef: `op:${opId}`, delta: -2 })
    expect(m.state.balances[U1]).toBe(98)
    expect(m.operation(opId)).toMatchObject({ state: 'committed', generation: 1, creditTransactionId: debits(m)[0].id, origin: 'atomic' })
    expect(m.paidResultOf(binding())?.result_json).toEqual({ v: 'a' })
    expect(checkInvariants(m)).toEqual([])
  })

  it('row 2: not enough credit is a rejection with NO state change', () => {
    const m = new PaidOperationsModel({ balances: { [U1]: 1 }, spendFence: referenceCatalogAfterSplit() }); m.enableCutover(TOOL)
    const before = JSON.stringify(m.state)
    expect(commit(m, 'a', 0)).toEqual({ ok: false, code: 'insufficient_credits' })
    expect(JSON.stringify(m.state)).toBe(before)
  })

  it('row 3: generation_conflict (expected != current) debits nothing and names the current generation', () => {
    const m = fresh(); commit(m, 'a', 0)
    const before = JSON.stringify(m.state)
    expect(commit(m, 'b', 0)).toEqual({ ok: false, code: 'generation_conflict', currentGeneration: 1 })
    expect(JSON.stringify(m.state)).toBe(before)
  })

  it('row 4: an expired token is rejected before any write', () => {
    const m = fresh(); const t = tok(m, 'a', 0)
    m.advance(10 * 60 * 1000 + 1)
    const before = JSON.stringify(m.state)
    expect(m.commit({ token: t, request: binding(), resultJson: {} })).toEqual({ ok: false, code: 'intent_expired' })
    expect(JSON.stringify(m.state)).toBe(before)
  })

  it('row 5: the SAME token again is a free duplicate -- even after the deadline', () => {
    const m = fresh(); const t = tok(m, 'a', 0)
    const first = m.commit({ token: t, request: binding(), resultJson: { v: 1 } })
    m.advance(60 * 60 * 1000)
    const again = m.commit({ token: t, request: binding(), resultJson: { v: 'other content must be ignored' } })
    expect(again).toMatchObject({ ok: true, duplicate: true })
    expect(again.ok && first.ok && again.generationId === first.generationId && again.paidResultId === first.paidResultId).toBe(true)
    expect(debits(m)).toHaveLength(1)
    expect(m.paidResultOf(binding())?.result_json).toEqual({ v: 1 })
  })

  it('row 6: a NEW token with expected = current is a deliberate force refresh: generation 2, a second debit, both generations kept', () => {
    const m = fresh(); commit(m, 'a', 0)
    expect(commit(m, 'b', 1)).toMatchObject({ ok: true, duplicate: false, generation: 2 })
    expect(debits(m)).toHaveLength(2)
    expect(m.generationsOf(binding()).map(g => g.resultJson)).toEqual([{ v: 'a' }, { v: 'b' }])
    expect(m.paidResultOf(binding())?.result_json).toEqual({ v: 'b' })
    expect(checkInvariants(m)).toEqual([])
  })

  it('rows 7-9: seal -- too early for the user, fine for an operator; afterwards the SAME token can never commit, a NEW token can', () => {
    const m = fresh(); const t = tok(m, 'a', 0)
    expect(m.seal({ token: t, request: binding() }, 'user')).toMatchObject({ ok: false, code: 'seal_too_early', sealNotBefore: t.deadline + 60_000 })
    expect(m.state.operations).toHaveLength(0)
    expect(m.seal({ token: t, request: binding() }, 'operator')).toEqual({ ok: true, state: 'sealed' })
    expect(m.seal({ token: t, request: binding() }, 'operator')).toEqual({ ok: true, state: 'sealed', alreadySealed: true }) // idempotent
    const before = JSON.stringify(m.state)
    expect(m.commit({ token: t, request: binding(), resultJson: {} })).toEqual({ ok: false, code: 'operation_sealed' })
    expect(JSON.stringify(m.state)).toBe(before)
    expect(debits(m)).toHaveLength(0)
    expect(commit(m, 'new', 0)).toMatchObject({ ok: true, duplicate: false, generation: 1 }) // the explicit new attempt
    expect(debits(m)).toHaveLength(1)
    expect(checkInvariants(m)).toEqual([])
  })

  it('a user may seal once deadline + margin has passed', () => {
    const m = fresh(); const t = tok(m, 'a', 0)
    m.advance(t.deadline + 60_000)
    expect(m.seal({ token: t, request: binding() }, 'user')).toEqual({ ok: true, state: 'sealed' })
  })

  it('row 10: a seal AFTER the commit is a no-op that reports committed and writes no tombstone', () => {
    const m = fresh(); const t = tok(m, 'a', 0)
    m.commit({ token: t, request: binding(), resultJson: {} })
    const before = JSON.stringify(m.state)
    expect(m.seal({ token: t, request: binding() }, 'operator')).toEqual({ ok: true, state: 'committed' })
    expect(JSON.stringify(m.state)).toBe(before)
  })

  it('a commit on a tool_type that is NOT cut over is refused (this RPC is the atomic path only)', () => {
    const m = new PaidOperationsModel({ balances: { [U1]: 10 } })
    const before = JSON.stringify(m.state)
    expect(m.commit({ token: tok(m, 'a', 0), request: binding(), resultJson: {} })).toEqual({ ok: false, code: 'tool_not_cutover' })
    expect(JSON.stringify(m.state)).toBe(before)
  })
})

describe('the client key is MANDATORILY bound to user, device, input and tool', () => {
  it.each([
    ['another user', { userId: U2 }],
    ['another device', { deviceDigest: 'device-b' }],
    ['another input', { inputHash: 'input-hash-2' }],
    ['another tool', { toolType: 'thumbnail_studio' }],
  ])('a token issued for one binding used with %s is rejected BEFORE any effect (no lock, no write)', (_n, other) => {
    const m = fresh(); m.enableCutover('thumbnail_studio')
    const t = tok(m, 'a', 0)
    const before = JSON.stringify(m.state)
    const locksBefore = m.lockLog.length
    expect(m.commit({ token: t, request: binding(other as Partial<Binding>), resultJson: {} })).toEqual({ ok: false, code: 'binding_mismatch' })
    expect(m.seal({ token: t, request: binding(other as Partial<Binding>) }, 'operator')).toEqual({ ok: false, code: 'binding_mismatch' })
    expect(m.status(t, binding(other as Partial<Binding>))).toEqual({ state: 'rejected', code: 'binding_mismatch' })
    expect(JSON.stringify(m.state)).toBe(before)
    expect(m.lockLog).toHaveLength(locksBefore)
  })

  it('a missing or too short key is refused (the key is mandatory)', () => {
    const m = fresh()
    for (const bad of ['', 'x'.repeat(MIN_NONCE_LENGTH - 1)]) {
      const t = makeToken(binding(), { nonce: bad, expectedGeneration: 0 })
      expect(m.commit({ token: t, request: binding(), resultJson: {} })).toEqual({ ok: false, code: 'idempotency_key_required' })
    }
    expect(debits(m)).toHaveLength(0)
  })

  it('the operation id is derived from ALL binding fields: any field changed gives another operation (the same key is never "re-claimed")', () => {
    const base = tok(fresh(), 'a', 0)
    const ids = new Set([deriveOperationId(base)])
    for (const change of [{ userId: U2 }, { deviceDigest: 'device-b' }, { inputHash: 'other' }, { toolType: 'seo_optimizer' }, { nonce: nonce('b') }]) ids.add(deriveOperationId({ ...base, ...change }))
    expect(ids.size).toBe(6)
  })

  it('the length-prefixed encoding cannot be forged by moving characters between fields', () => {
    const a = deriveOperationId({ userId: 'ab', deviceDigest: 'c', toolType: TOOL, inputHash: HASH, nonce: nonce('a') })
    const b = deriveOperationId({ userId: 'a', deviceDigest: 'bc', toolType: TOOL, inputHash: HASH, nonce: nonce('a') })
    expect(a).not.toBe(b)
  })
})

describe('status is READ-ONLY (R class): it cannot start a charge, and its answer carries nothing that could', () => {
  it('in all three states it changes nothing, takes no lock and writes no ledger row', () => {
    const m = fresh()
    const tNone = tok(m, 'none', 0); const tCommitted = tok(m, 'done', 0); const tSealed = tok(m, 'sealed', 0)
    m.commit({ token: tCommitted, request: binding(), resultJson: {} })
    m.seal({ token: tSealed, request: binding() }, 'operator')
    const stateBefore = JSON.stringify(m.state); const locksBefore = m.lockLog.length
    expect(m.status(tNone, binding())).toEqual({ state: 'not_visible', sealNotBefore: tNone.deadline + 60_000 })
    expect(m.status(tCommitted, binding())).toMatchObject({ state: 'committed', generation: 1 })
    expect(m.status(tSealed, binding())).toEqual({ state: 'sealed' })
    expect(JSON.stringify(m.state)).toBe(stateBefore)
    expect(m.lockLog).toHaveLength(locksBefore)
  })

  it('no status answer holds a token, a nonce or a key: R can never become C', () => {
    const m = fresh(); const t = tok(m, 'a', 0)
    for (const r of [m.status(t, binding()), (m.commit({ token: t, request: binding(), resultJson: {} }), m.status(t, binding()))]) {
      expect(Object.keys(r).every(k => ['state', 'generation', 'generationId', 'paidResultId', 'paidResultGeneration', 'sealNotBefore', 'code'].includes(k))).toBe(true)
      expect(JSON.stringify(r)).not.toMatch(/nonce|token|expectedGeneration/i)
    }
  })

  it('not_visible does NOT license a charge: a status check followed by nothing leaves 0 debits (there is no automatic R -> C path in the model)', () => {
    const m = fresh(); const t = tok(m, 'a', 0)
    m.status(t, binding()); m.status(t, binding())
    expect(debits(m)).toHaveLength(0)
    expect(m.state.operations).toHaveLength(0)
  })
})

describe('business credit -- only after a COMPLETED, LINKED result; separate reason and reference', () => {
  it('a committed linked operation can be credited once, with its own reason; result and operation row stay untouched', () => {
    const m = fresh(); const t = tok(m, 'a', 0)
    m.commit({ token: t, request: binding(), resultJson: { v: 1 } })
    const opId = deriveOperationId(t)
    const opBefore = JSON.stringify(m.operation(opId)); const resultBefore = JSON.stringify(m.paidResultOf(binding()))
    const r = m.businessCredit({ operationId: opId, amount: 1, operatorId: 'op-1' })
    expect(r.ok).toBe(true)
    expect(m.ledgerByRef(`bc:${opId}`)).toHaveLength(1)
    expect(m.ledgerByRef(`bc:${opId}`)[0]).toMatchObject({ reason: 'business_credit', delta: 1, relatedTransactionId: debits(m)[0].id })
    expect(JSON.stringify(m.operation(opId))).toBe(opBefore)
    expect(JSON.stringify(m.paidResultOf(binding()))).toBe(resultBefore)
    expect(m.businessCredit({ operationId: opId, amount: 1, operatorId: 'op-1' })).toEqual({ ok: false, code: 'already_credited' })
    expect(checkInvariants(m)).toEqual([])
  })

  it('refused on a sealed operation, on an unknown operation, with a bad amount and without an operator', () => {
    const m = fresh(); const t = tok(m, 'a', 0)
    m.seal({ token: t, request: binding() }, 'operator')
    const opId = deriveOperationId(t)
    expect(m.businessCredit({ operationId: opId, amount: 1, operatorId: 'op-1' })).toEqual({ ok: false, code: 'operation_not_committed' })
    expect(m.businessCredit({ operationId: 'unknown', amount: 1, operatorId: 'op-1' })).toEqual({ ok: false, code: 'operation_not_committed' })
    const t2 = tok(m, 'b', 0); m.commit({ token: t2, request: binding(), resultJson: {} })
    const op2 = deriveOperationId(t2)
    expect(m.businessCredit({ operationId: op2, amount: 0, operatorId: 'op-1' })).toEqual({ ok: false, code: 'invalid_amount' })
    expect(m.businessCredit({ operationId: op2, amount: 3, operatorId: 'op-1' })).toEqual({ ok: false, code: 'invalid_amount' }) // more than the price
    expect(m.businessCredit({ operationId: op2, amount: 1, operatorId: '' })).toEqual({ ok: false, code: 'operator_required' })
    expect(m.state.ledger.filter(l => l.reason === 'business_credit')).toHaveLength(0)
  })

  it('an atomic operation can never be refunded as an orphan: the refund of its spend is refused (guard ON) and a business credit is the only instrument', () => {
    const m = fresh(); commit(m, 'a', 0)
    expect(m.refundCreditSpend(debits(m)[0].id)).toEqual({ ok: false, code: 'op_spend_not_refundable' })
    expect(m.state.ledger.filter(l => l.reason === 'credit_refund')).toHaveLength(0)
  })
})

// ───────────────────────────── the race matrix: every permutation of lock-serialised calls ─────────────────────────────
function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs]
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map(rest => [x, ...rest]))
}
function everyOrder(setup: (m: PaidOperationsModel) => void, calls: Array<(m: PaidOperationsModel) => unknown>, check: (m: PaidOperationsModel, results: unknown[], order: number[]) => void) {
  for (const order of permutations(calls.map((_c, i) => i))) {
    const m = fresh(); setup(m)
    const results: unknown[] = new Array(calls.length)
    for (const i of order) results[i] = calls[i](m)
    expect(checkInvariants(m), `order ${order.join(',')}`).toEqual([])
    check(m, results, order)
  }
}

describe('race matrix -- every order of the calls (the advisory locks serialise them), invariants checked after each', () => {
  it('V1: two commits with the SAME token: exactly one debit, one fresh and one duplicate', () => {
    everyOrder(() => {}, [m => commit(m, 'x', 0), m => commit(m, 'x', 0)], (m, r) => {
      expect((r as CommitResult[]).filter(okFresh)).toHaveLength(1)
      expect((r as CommitResult[]).filter(x => x.ok && x.duplicate)).toHaveLength(1)
      expect(debits(m)).toHaveLength(1)
      expect(m.generationsOf(binding())).toHaveLength(1)
    })
  })

  it('V2: commit versus seal (operator): exactly one wins -- a seal that wins means NO debit ever, a commit that wins makes the seal report committed', () => {
    everyOrder(() => {}, [m => commit(m, 'x', 0), m => m.seal({ token: tok(m, 'x', 0), request: binding() }, 'operator')], (m, r, order) => {
      const commitFirst = order[0] === 0
      if (commitFirst) { expect(debits(m)).toHaveLength(1); expect(r[1]).toEqual({ ok: true, state: 'committed' }) }
      else { expect(debits(m)).toHaveLength(0); expect(r[0]).toEqual({ ok: false, code: 'operation_sealed' }); expect(m.state.generations).toHaveLength(0) }
    })
  })

  it('V3: a LATE commit after the seal (a stale in-flight request, a replay) never debits and never writes a generation or projection', () => {
    everyOrder(() => {}, [m => commit(m, 'x', 0), m => m.seal({ token: tok(m, 'x', 0), request: binding() }, 'operator'), m => commit(m, 'x', 0)], (m, _r, order) => {
      const sealFirst = order.indexOf(1) < Math.min(order.indexOf(0), order.indexOf(2))
      expect(debits(m)).toHaveLength(sealFirst ? 0 : 1)
      if (sealFirst) { expect(m.state.generations).toHaveLength(0); expect(m.paidResultOf(binding())).toBeUndefined() }
    })
  })

  it('V4: two DIFFERENT tokens on the same input (the same device): one commits, the other gets generation_conflict -- no extra debit', () => {
    everyOrder(() => {}, [m => commit(m, 'x', 0), m => commit(m, 'y', 0)], (m, r) => {
      expect((r as CommitResult[]).filter(okFresh)).toHaveLength(1)
      expect((r as CommitResult[]).filter(x => !x.ok)).toEqual([{ ok: false, code: 'generation_conflict', currentGeneration: 1 }])
      expect(debits(m)).toHaveLength(1)
    })
  })

  it('V4b: the same from TWO DEVICES: one wins, the other is a conflict', () => {
    const other = binding({ deviceDigest: 'device-b' })
    everyOrder(() => {}, [m => commit(m, 'x', 0), m => commit(m, 'y', 0, other)], (m, r) => {
      expect((r as CommitResult[]).filter(okFresh)).toHaveLength(1)
      expect(debits(m)).toHaveLength(1)
    })
  })

  it('V5: a double force_refresh click with the SAME token creates ONE new generation; a different token from the same view is a conflict', () => {
    everyOrder(m => { commit(m, 'seed', 0) }, [m => commit(m, 'f1', 1), m => commit(m, 'f1', 1), m => commit(m, 'f2', 1)], (m, r) => {
      expect(m.generationsOf(binding())).toHaveLength(2) // seed + exactly one force refresh
      expect(debits(m)).toHaveLength(2)
      expect((r as CommitResult[]).filter(okFresh)).toHaveLength(1)
    })
  })

  it('V6: an OLDER writer (expected n-1) after a newer generation is a conflict and never moves the projection back', () => {
    everyOrder(m => { commit(m, 'seed', 0) }, [m => commit(m, 'new', 1), m => commit(m, 'stale', 0)], (m, r) => {
      expect(r[1]).toEqual({ ok: false, code: 'generation_conflict', currentGeneration: expect.any(Number) })
      expect(m.paidResultOf(binding())?.result_json).toEqual({ v: 'new' })
      expect(m.projectionStatus(binding())).toEqual({ generation: 2, consistent: true })
    })
  })

  it('V7: business credit versus commit -- the credit only succeeds AFTER the commit and then at most once', () => {
    const t = (m: PaidOperationsModel) => tok(m, 'x', 0)
    everyOrder(() => {}, [m => commit(m, 'x', 0), m => m.businessCredit({ operationId: deriveOperationId(t(m)), amount: 1, operatorId: 'op' })], (m, r, order) => {
      const creditAfter = order[0] === 0
      expect((r[1] as { ok: boolean }).ok).toBe(creditAfter)
      expect(m.state.ledger.filter(l => l.reason === 'business_credit')).toHaveLength(creditAfter ? 1 : 0)
    })
  })

  it('V8: two users with the same input never interfere (independent scopes, independent debits)', () => {
    everyOrder(() => {}, [m => commit(m, 'x', 0, binding({ userId: U1 })), m => commit(m, 'x', 0, binding({ userId: U2 }))], (m, r) => {
      expect((r as CommitResult[]).every(okFresh)).toBe(true)
      expect(debits(m)).toHaveLength(2)
    })
  })

  it('V9: the route lock having EXPIRED changes nothing -- the protection is the operation row and the CAS, so a late writer with the same or another token is still bounded', () => {
    everyOrder(() => {}, [m => commit(m, 'x', 0), m => commit(m, 'x', 0), m => commit(m, 'late', 0)], (m) => {
      expect(debits(m)).toHaveLength(1)
      expect(m.generationsOf(binding())).toHaveLength(1)
    })
  })
})

describe('crash matrix -- a crash at EVERY step rolls the whole transaction back; the same token then commits exactly once', () => {
  it.each(COMMIT_STEPS)('commit crashes %s: state is byte-identical to before, invariants hold, and a retry with the same token debits once', (step) => {
    const m = fresh(); commit(m, 'seed', 0)
    const before = JSON.stringify(m.state)
    const t = tok(m, 'f', 1)
    expect(() => m.commit({ token: t, request: binding(), resultJson: { v: 'f' } }, { crashAt: step })).toThrow(ModelCrash)
    expect(JSON.stringify(m.state)).toBe(before)
    expect(checkInvariants(m)).toEqual([])
    expect(m.commit({ token: t, request: binding(), resultJson: { v: 'f' } })).toMatchObject({ ok: true, duplicate: false, generation: 2 })
    expect(debits(m)).toHaveLength(2)
  })

  it.each(COMMIT_STEPS)('commit over a LEGACY completed row crashes %s: the materialised legacy generation and the debit roll back together', (step) => {
    const m = fresh(); m.seedLegacyRow({ userId: U1, toolType: TOOL, inputHash: HASH, resultJson: { v: 'legacy' } })
    const before = JSON.stringify(m.state)
    const t = tok(m, 'f', 1)
    expect(() => m.commit({ token: t, request: binding(), resultJson: { v: 'f' } }, { crashAt: step })).toThrow(ModelCrash)
    expect(JSON.stringify(m.state)).toBe(before)
    expect(m.state.generations).toHaveLength(0)
    expect(checkInvariants(m)).toEqual([])
  })

  it.each(SEAL_STEPS)('seal crashes %s: no tombstone, and the same token can still commit afterwards', (step) => {
    const m = fresh(); const t = tok(m, 'a', 0)
    const before = JSON.stringify(m.state)
    expect(() => m.seal({ token: t, request: binding() }, 'operator', { crashAt: step })).toThrow(ModelCrash)
    expect(JSON.stringify(m.state)).toBe(before)
    expect(m.commit({ token: t, request: binding(), resultJson: {} })).toMatchObject({ ok: true })
  })
})

describe('response loss', () => {
  it('commit succeeded, the answer is LOST: status says committed, a resend is a free duplicate, one debit in total', () => {
    const m = fresh(); const t = tok(m, 'a', 0)
    m.commit({ token: t, request: binding(), resultJson: { v: 1 } }) // the answer is dropped
    expect(m.status(t, binding())).toMatchObject({ state: 'committed', generation: 1 })
    expect(m.commit({ token: t, request: binding(), resultJson: { v: 1 } })).toMatchObject({ ok: true, duplicate: true })
    expect(debits(m)).toHaveLength(1)
  })

  it('the request never reached the database: status is not_visible (NOT proof of no charge), nothing automatic follows; wait, seal, then a NEW token is one explicit new attempt', () => {
    const m = fresh(); const t = tok(m, 'a', 0)
    expect(m.status(t, binding())).toMatchObject({ state: 'not_visible' })
    expect(debits(m)).toHaveLength(0)
    expect(m.seal({ token: t, request: binding() }, 'user')).toMatchObject({ ok: false, code: 'seal_too_early' })
    m.advance(t.deadline + 60_000)
    expect(m.seal({ token: t, request: binding() }, 'user')).toEqual({ ok: true, state: 'sealed' })
    expect(m.status(t, binding())).toEqual({ state: 'sealed' })
    expect(commit(m, 'second-attempt', 0)).toMatchObject({ ok: true, duplicate: false })
    expect(debits(m)).toHaveLength(1)
    expect(checkInvariants(m)).toEqual([])
  })

  it('the seal answer is lost: a second seal is idempotent', () => {
    const m = fresh(); const t = tok(m, 'a', 0)
    m.seal({ token: t, request: binding() }, 'operator')
    expect(m.seal({ token: t, request: binding() }, 'operator')).toMatchObject({ ok: true, state: 'sealed', alreadySealed: true })
    expect(m.state.operations).toHaveLength(1)
  })
})

describe('mandatory lock order: tool lock, then operation lock, then scope lock -- guarded, with negative controls that deadlock', () => {
  const kinds = (seq: string[]) => seq.map(l => l.split(':')[0])

  it('commit records [tool, op, scope], seal [op, scope], business credit [op], enableCutover and rollbackCutover [tool]; the status takes no lock; every sequence passes the order guard', () => {
    const m = fresh() // fresh() already enabled the cut-over: one [tool] entry
    const base = m.lockLog.length
    const t = tok(m, 'a', 0)
    m.commit({ token: t, request: binding(), resultJson: {} })
    m.seal({ token: tok(m, 'b', 1), request: binding() }, 'operator')
    m.status(t, binding())
    m.businessCredit({ operationId: deriveOperationId(t), amount: 1, operatorId: 'op' })
    m.rollbackCutover(TOOL) // refused (a committed linked generation exists), but it still takes the tool lock FIRST
    expect(m.lockLog).toHaveLength(base + 4) // the status added nothing
    for (const seq of m.lockLog) assertLockOrder(seq)
    expect(m.lockLog[0]).toEqual(['tool:' + TOOL])
    const [commitSeq, sealSeq, creditSeq, rollbackSeq] = m.lockLog.slice(base)
    expect(kinds(commitSeq)).toEqual(['tool', 'op', 'scope'])
    expect(commitSeq[0]).toBe('tool:' + TOOL)
    expect(kinds(sealSeq)).toEqual(['op', 'scope'])
    expect(kinds(creditSeq)).toEqual(['op'])
    expect(rollbackSeq).toEqual(['tool:' + TOOL])
  })

  it('the guard HAS TEETH: any sequence that takes a later-ranked lock before an earlier-ranked one is rejected', () => {
    for (const bad of [['scope:s', 'op:o'], ['op:o', 'tool:t'], ['scope:s', 'tool:t'], ['tool:t', 'scope:s', 'op:o'], ['tool:t', 'op:o', 'tool:u']]) expect(() => assertLockOrder(bad), bad.join(' -> ')).toThrow(/lock order violated/)
    for (const good of [['tool:t', 'op:o', 'scope:s'], ['op:a', 'op:b', 'scope:s'], ['tool:t'], ['tool:a', 'tool:b'], ['op:o', 'scope:s']]) expect(() => assertLockOrder(good), good.join(' -> ')).not.toThrow()
    expect(() => assertLockOrder(['mystery:x'])).toThrow(/unknown lock kind/)
  })

  it('NEGATIVE CONTROL 1: two transactions that take operation and scope in OPPOSITE orders deadlock in the simulation (never to be built into a real RPC)', () => {
    expect(simulateLockAcquisition([['op:a', 'scope:s'], ['scope:s', 'op:a']])).toBe('deadlock')
  })

  it('NEGATIVE CONTROL 2: a transaction that takes the OPERATION lock BEFORE the TOOL lock deadlocks against a commit (tool, op, scope)', () => {
    expect(simulateLockAcquisition([['tool:t', 'op:a', 'scope:s'], ['op:a', 'tool:t']])).toBe('deadlock')
  })

  it('POSITIVE: the real, ranked sequences of commit, rollback, enable, seal and credit never deadlock, in any start order of all six', () => {
    const seqs = [['tool:t', 'op:a', 'scope:s'], ['tool:t', 'op:b', 'scope:s'], ['tool:t'], ['tool:t'], ['op:a', 'scope:s'], ['op:b']]
    for (const seq of seqs) assertLockOrder(seq)
    for (const order of permutations([0, 1, 2, 3, 4, 5])) expect(simulateLockAcquisition(order.map(i => seqs[i])), order.join(',')).toBe('ok')
  })
})

describe('tool-level synchronisation: a commit and rollbackCutover decide AFTER the same tool lock', () => {
  const flip = (m: PaidOperationsModel) => m.state.cutover[TOOL] === true

  it('serial, commit first: the commit succeeds, the rollback is refused and the tool_type stays cut over', () => {
    const m = fresh()
    expect(commit(m, 'a', 0)).toMatchObject({ ok: true, duplicate: false })
    expect(m.rollbackCutover(TOOL)).toEqual({ ok: false, code: 'atomic_generation_exists' })
    expect(flip(m)).toBe(true)
    expect(checkInvariants(m)).toEqual([])
  })

  it('serial, rollback first: the rollback succeeds, the commit is refused with tool_not_cutover, nothing is debited or written', () => {
    const m = fresh()
    expect(m.rollbackCutover(TOOL)).toEqual({ ok: true })
    const before = JSON.stringify(m.state)
    expect(commit(m, 'a', 0)).toEqual({ ok: false, code: 'tool_not_cutover' })
    expect(JSON.stringify(m.state)).toBe(before)
    expect(debits(m)).toHaveLength(0)
    expect(m.state.generations).toHaveLength(0)
  })

  it('a commit that has ALREADY STARTED when the rollback runs: it decides after the tool lock, sees the back-step and is refused -- no debit, no generation, no projection', () => {
    const m = fresh()
    let rolledBack: unknown
    const r = m.commit({ token: tok(m, 'a', 0), request: binding(), resultJson: { v: 'a' } }, { afterStartBeforeLock: () => { rolledBack = m.rollbackCutover(TOOL) } })
    expect(rolledBack).toEqual({ ok: true }) // nothing was committed yet, so the back-step is legitimate
    expect(r).toEqual({ ok: false, code: 'tool_not_cutover' })
    expect(debits(m)).toHaveLength(0)
    expect(m.state.generations).toHaveLength(0)
    expect(m.paidResultOf(binding())).toBeUndefined()
    expect(checkInvariants(m)).toEqual([]) // in particular: no linked generation on a tool_type that is not cut over
  })

  it('a rollback that has ALREADY STARTED when a commit runs: it decides after the tool lock, sees the committed generation and is refused -- the tool_type stays cut over', () => {
    const m = fresh()
    let committed: CommitResult | undefined
    const r = m.rollbackCutover(TOOL, { afterStartBeforeLock: () => { committed = commit(m, 'a', 0) } })
    expect(committed).toMatchObject({ ok: true, duplicate: false })
    expect(r).toEqual({ ok: false, code: 'atomic_generation_exists' })
    expect(flip(m)).toBe(true)
    expect(m.legacySavePaidResult({ userId: U1, toolType: TOOL, inputHash: HASH, resultJson: { v: 'legacy overwrite' } })).toEqual({ ok: false, code: 'cutover_write_forbidden' })
    expect(checkInvariants(m)).toEqual([])
  })

  it('the same windows for a commit that started and an enableCutover on a tool_type that was not cut over yet: the commit decides after the lock (still not cut over until the enable completes)', () => {
    const m = new PaidOperationsModel({ balances: { [U1]: 100 }, spendFence: referenceCatalogAfterSplit() })
    const r = m.commit({ token: tok(m, 'a', 0), request: binding(), resultJson: {} }, { afterStartBeforeLock: () => { m.enableCutover(TOOL) } })
    expect(r).toMatchObject({ ok: true, duplicate: false }) // the enable took the tool lock first and finished; the commit then saw the cut-over
    expect(checkInvariants(m)).toEqual([])
  })

  it('every ORDER of {commit, rollback}: exactly one of "the commit lands" / "the rollback lands", never both and never neither', () => {
    everyOrder(() => {}, [m => commit(m, 'x', 0), m => m.rollbackCutover(TOOL)], (m, r, order) => {
      const commitFirst = order[0] === 0
      if (commitFirst) { expect(r[0]).toMatchObject({ ok: true }); expect(r[1]).toEqual({ ok: false, code: 'atomic_generation_exists' }); expect(flip(m)).toBe(true); expect(debits(m)).toHaveLength(1) }
      else { expect(r[1]).toEqual({ ok: true }); expect(r[0]).toEqual({ ok: false, code: 'tool_not_cutover' }); expect(flip(m)).toBe(false); expect(debits(m)).toHaveLength(0) }
    })
  })

  it('every ORDER of {commit on input A, commit on input B, rollback}: the rollback wins only if it runs before both commits, and then BOTH commits are refused', () => {
    const other = binding({ inputHash: 'input-hash-2' })
    everyOrder(() => {}, [m => commit(m, 'a', 0), m => commit(m, 'b', 0, other), m => m.rollbackCutover(TOOL)], (m, r, order) => {
      const rollbackFirst = order[0] === 2
      if (rollbackFirst) { expect(r[2]).toEqual({ ok: true }); expect(r[0]).toEqual({ ok: false, code: 'tool_not_cutover' }); expect(r[1]).toEqual({ ok: false, code: 'tool_not_cutover' }); expect(debits(m)).toHaveLength(0) }
      else { expect(r[2]).toEqual({ ok: false, code: 'atomic_generation_exists' }); expect(flip(m)).toBe(true); expect(debits(m).length).toBeGreaterThanOrEqual(1) }
    })
  })

  it('every ORDER of {commit, rollback, enableCutover}: no order ever leaves a charge-linked generation on a tool_type that is not cut over', () => {
    everyOrder(() => {}, [m => commit(m, 'x', 0), m => m.rollbackCutover(TOOL), m => m.enableCutover(TOOL)], (m) => {
      for (const g of m.state.generations) if (g.chargeLink === 'linked') expect(flip(m)).toBe(true)
    })
  })
})

// ───────────────────────────── the response identifier contract ─────────────────────────────
// A committed operation is answered with TWO identifiers: generationId (the generation row) and paidResultId (the paid_results row, the key of the EXISTING
// reopen path: GET ?paidResultId= -> getPaidResultById(userId, id), PATCH paid_result_id, the response field paid_result_id). They are tested on separate rows.
describe('response identifier contract: generationId and paidResultId are two different identifiers', () => {
  type Answer = Extract<CommitResult, { ok: true }> | Extract<ReturnType<PaidOperationsModel['status']>, { state: 'committed' }>
  const must = (r: CommitResult) => { if (!r.ok) throw new Error('expected ok, got ' + r.code); return r }
  const PATHS = ['success', 'duplicate', 'status'] as const
  type Path = (typeof PATHS)[number]
  const answerVia = (m: PaidOperationsModel, t: IntentToken, path: Path): Answer => {
    if (path === 'success') return must(m.commit({ token: t, request: binding(), resultJson: { v: 'a' } }))
    if (path === 'duplicate') return must(m.commit({ token: t, request: binding(), resultJson: { v: 'ignored on a duplicate' } }))
    const r = m.status(t, binding())
    if (r.state !== 'committed') throw new Error('expected committed, got ' + r.state)
    return r
  }
  // a model whose first operation (token 'a') is committed; the answer for the given path is taken from it
  const setup = (path: Path) => { const m = fresh(); const t = tok(m, 'a', 0); if (path !== 'success') m.commit({ token: t, request: binding(), resultJson: { v: 'a' } }); return { m, t, answer: () => answerVia(m, t, path) } }

  describe('generationId -- the id of the GENERATION row', () => {
    it.each(PATHS)('%s: generationId is this operation\'s own generation row (its operation, generation 1), readable through the history read', (path) => {
      const { m, t, answer } = setup(path)
      const r = answer()
      const gen = m.state.generations.find(g => g.id === r.generationId)
      expect(gen).toBeDefined()
      expect(gen!.operationId).toBe(deriveOperationId(t))
      expect(gen!.generation).toBe(1)
      expect(m.readGeneration({ userId: U1, generationId: r.generationId })).toMatchObject({ ok: true, generation: 1, resultJson: { v: 'a' }, chargeLink: 'linked' })
    })
    it.each(PATHS)('%s: generationId is NOT a paid_results id -- the existing reopen path does not find it', (path) => {
      const { m, answer } = setup(path)
      const r = answer()
      expect(m.state.paidResults.some(row => row.id === r.generationId)).toBe(false)
      expect(m.reopenPaidResult({ userId: U1, paidResultId: r.generationId })).toEqual({ ok: false, code: 'not_found' })
    })
    it.each(PATHS)('%s: generationId is the SAME on success, duplicate and status', (path) => {
      const { m, t, answer } = setup(path)
      const first = must(m.commit({ token: t, request: binding(), resultJson: { v: 'ignored' } })) // a duplicate (or the success itself for 'success')
      expect(answer().generationId).toBe(first.generationId)
    })
  })

  describe('paidResultId -- the id of the paid_results ROW (the key the existing reopen path takes)', () => {
    it.each(PATHS)('%s: paidResultId is the paid_results.id of the scope row, and the existing reopen path opens it', (path) => {
      const { m, answer } = setup(path)
      const r = answer()
      expect(r.paidResultId).toBe(m.paidResultOf(binding())!.id)
      expect(m.reopenPaidResult({ userId: U1, paidResultId: r.paidResultId! })).toMatchObject({ ok: true, paidResultId: r.paidResultId, generation: 1, resultJson: { v: 'a' } })
    })
    it.each(PATHS)('%s: paidResultId is NOT a generation id -- the history read does not find it', (path) => {
      const { m, answer } = setup(path)
      const r = answer()
      expect(m.state.generations.some(g => g.id === r.paidResultId)).toBe(false)
      expect(m.readGeneration({ userId: U1, generationId: r.paidResultId! })).toEqual({ ok: false, code: 'not_found' })
    })
    it.each(PATHS)('%s: paidResultGeneration says which generation opening paidResultId yields (the current one)', (path) => {
      const { answer } = setup(path)
      const r = answer()
      expect(r.paidResultGeneration).toBe(1)
      expect(r.paidResultGeneration).toBe(r.generation)
    })
    it.each(PATHS)('%s: the two identifiers are different values', (path) => {
      const r = setup(path).answer()
      expect(r.generationId).not.toBe(r.paidResultId)
    })
  })

  describe('after a refresh: one paidResultId for every generation, one generationId per generation', () => {
    const refreshed = () => {
      const m = fresh()
      const tA = tok(m, 'a', 0); const tB = tok(m, 'b', 1)
      const a = must(m.commit({ token: tA, request: binding(), resultJson: { v: 'a' } }))
      const b = must(m.commit({ token: tB, request: binding(), resultJson: { v: 'b' } }))
      return { m, tA, tB, a, b }
    }
    it('paidResultId is the SAME row id across generations (a client holding it stays valid across a refresh)', () => {
      const { a, b } = refreshed()
      expect(b.paidResultId).toBe(a.paidResultId)
    })
    it('generationId differs per generation', () => {
      const { a, b } = refreshed()
      expect(b.generationId).not.toBe(a.generationId)
    })
    it.each(['duplicate', 'status'] as const)('%s of the OLDER operation: its own generationId, the shared paidResultId, and paidResultGeneration = 2 (NOT its own generation 1)', (path) => {
      const { m, tA, a, b } = refreshed()
      const r = answerVia(m, tA, path)
      expect(r.generation).toBe(1)
      expect(r.generationId).toBe(a.generationId)
      expect(r.paidResultId).toBe(b.paidResultId)
      expect(r.paidResultGeneration).toBe(2)
    })
    it('opening paidResultId yields the CURRENT content (generation 2); the OLDER generation is reachable only through its generationId', () => {
      const { m, a, b } = refreshed()
      expect(m.reopenPaidResult({ userId: U1, paidResultId: a.paidResultId! })).toMatchObject({ ok: true, generation: 2, resultJson: { v: 'b' } })
      expect(m.readGeneration({ userId: U1, generationId: a.generationId })).toMatchObject({ ok: true, generation: 1, resultJson: { v: 'a' } })
      expect(m.readGeneration({ userId: U1, generationId: b.generationId })).toMatchObject({ ok: true, generation: 2, resultJson: { v: 'b' } })
    })
  })

  describe('legacy continuity: a refresh over an existing row keeps that row\'s id', () => {
    it('the success answer after the first generation-aware commit carries the LEGACY row id as paidResultId, and a NEW generation row id', () => {
      const m = fresh()
      const legacyRow = m.seedLegacyRow({ userId: U1, toolType: TOOL, inputHash: HASH, resultJson: { v: 'legacy' } })
      const r = must(m.commit({ token: tok(m, 'a', 1), request: binding(), resultJson: { v: 'a' } }))
      expect(r.paidResultId).toBe(legacyRow.id)
      expect(r.generation).toBe(2)
      expect(m.generationsOf(binding()).map(g => g.id)).toContain(r.generationId)
      expect(m.generationsOf(binding())[0].id).not.toBe(r.generationId) // the materialised legacy generation 1 has its own id
    })
  })

  describe('the RESPONSE withholds paidResultId for a row that is missing or is not the max generation (this is NOT a fail-closed reopen: see the KNOWN OPEN GAP block below)', () => {
    it.each(['duplicate', 'status'] as const)('%s: a missing row -> paidResultId null, paidResultGeneration null, generationId still present', (path) => {
      const { m, t } = setup('duplicate')
      m.state.paidResults = []
      const r = answerVia(m, t, path)
      expect(r.paidResultId).toBeNull()
      expect(r.paidResultGeneration).toBeNull()
      expect(typeof r.generationId).toBe('string')
    })
    it.each(['duplicate', 'status'] as const)('%s: a diverged row (content edited out of band) -> paidResultId null', (path) => {
      const { m, t } = setup('duplicate')
      m.paidResultOf(binding())!.summary_json = { tampered: true }
      const r = answerVia(m, t, path)
      expect(r.paidResultId).toBeNull()
      expect(r.paidResultGeneration).toBeNull()
    })
    it.each(['duplicate', 'status'] as const)('%s: a row that is no longer completed -> paidResultId null, and the reopen path does not find it either', (path) => {
      const { m, t } = setup('duplicate')
      const rowId = m.paidResultOf(binding())!.id
      m.paidResultOf(binding())!.status = 'archived'
      const r = answerVia(m, t, path)
      expect(r.paidResultId).toBeNull()
      expect(m.reopenPaidResult({ userId: U1, paidResultId: rowId })).toEqual({ ok: false, code: 'not_found' })
    })
  })

  describe('the old ambiguous name is gone, and the other answers carry no identifier', () => {
    it.each(PATHS)('%s: the answer has no resultId key', (path) => {
      const r = setup(path).answer()
      expect('resultId' in r).toBe(false)
      expect(Object.keys(r).filter(k => /id$/i.test(k)).sort()).toEqual(['generationId', 'operationId', 'paidResultId'].filter(k => k in r).sort())
    })
    it('sealed, not_visible and rejected answers carry neither identifier', () => {
      const m = fresh(); const tSealed = tok(m, 'sealed', 0); const tNone = tok(m, 'none', 0)
      m.seal({ token: tSealed, request: binding() }, 'operator')
      for (const r of [m.status(tSealed, binding()), m.status(tNone, binding()), m.status(tNone, binding({ userId: U2 }))]) {
        expect(Object.keys(r).some(k => k === 'generationId' || k === 'paidResultId' || k === 'paidResultGeneration')).toBe(false)
      }
    })
    it('a rejected commit carries neither identifier', () => {
      const m = fresh(); commit(m, 'a', 0)
      const r = commit(m, 'b', 0) // generation_conflict
      expect(r.ok).toBe(false)
      expect(Object.keys(r).some(k => k === 'generationId' || k === 'paidResultId')).toBe(false)
    })
  })

  describe('both reads are owner-checked and read-only', () => {
    it('another user finds neither the paid_results row nor the generation', () => {
      const m = fresh(); const r = must(commit(m, 'a', 0))
      expect(m.reopenPaidResult({ userId: U2, paidResultId: r.paidResultId! })).toEqual({ ok: false, code: 'not_found' })
      expect(m.readGeneration({ userId: U2, generationId: r.generationId })).toEqual({ ok: false, code: 'not_found' })
    })
    it('unknown ids are not found, and neither read changes anything', () => {
      const m = fresh(); const r = must(commit(m, 'a', 0))
      const before = JSON.stringify(m.state)
      expect(m.reopenPaidResult({ userId: U1, paidResultId: 'nope' })).toEqual({ ok: false, code: 'not_found' })
      expect(m.readGeneration({ userId: U1, generationId: 'nope' })).toEqual({ ok: false, code: 'not_found' })
      m.reopenPaidResult({ userId: U1, paidResultId: r.paidResultId! }); m.readGeneration({ userId: U1, generationId: r.generationId })
      expect(JSON.stringify(m.state)).toBe(before)
    })
  })
})

// ───────────────────────────── KNOWN OPEN GAP: the answer withholds the id, the existing reopen path does not ─────────────────────────────
// The answer of a commit / duplicate / status does not hand out paidResultId for a row that is not the max generation. The existing reopen path
// (getPaidResultById: id + owner + completed) still accepts an id the client ALREADY KNOWS and serves what the row holds. A fail-closed reopen is a
// separate route/DB gate, G-REOPEN, NOT implemented. These tests PIN today's behaviour; they do not claim the gate works.
describe('KNOWN OPEN GAP (G-REOPEN): the response withholds the id, but the existing reopen path still accepts a previously known one', () => {
  const mustOk = (r: CommitResult) => { if (!r.ok) throw new Error('expected ok, got ' + r.code); return r }
  const known = () => {
    const m = fresh(); const t = tok(m, 'a', 0)
    const r = mustOk(m.commit({ token: t, request: binding(), resultJson: { v: 'a' } }))
    return { m, t, knownId: r.paidResultId!, generationId: r.generationId }
  }
  const TAMPERS: Array<[string, (row: Record<string, unknown>) => void]> = [
    ['result_json', row => { row.result_json = { v: 'tampered' } }],
    ['summary_json', row => { row.summary_json = { tampered: true } }],
    ['credit_cost', row => { row.credit_cost = 99 }],
    ['source_run_id', row => { row.source_run_id = 'run-other' }],
  ]

  it('the gate is named, and it is NOT implemented', () => {
    expect(FAIL_CLOSED_REOPEN_GATE.id).toBe('G-REOPEN')
    expect(FAIL_CLOSED_REOPEN_GATE.implemented).toBe(false)
    expect(FAIL_CLOSED_REOPEN_GATE.options).toHaveLength(2)
    expect(FAIL_CLOSED_REOPEN_GATE.options.map(o => o.split(':')[0])).toEqual(['route gate', 'db gate'])
  })

  describe.each(TAMPERS)('a diverged row (%s edited out of band)', (_field, tamper) => {
    it('the ANSWER withholds paidResultId (duplicate and status)', () => {
      const { m, t } = known()
      tamper(m.paidResultOf(binding())! as Record<string, unknown>)
      expect(m.projectionStatus(binding()).consistent).toBe(false)
      const dup = mustOk(m.commit({ token: t, request: binding(), resultJson: { v: 'a' } }))
      const st = m.status(t, binding())
      expect(dup.paidResultId).toBeNull()
      expect(st.state === 'committed' && st.paidResultId).toBeNull()
    })
    it('KNOWN OPEN: the EXISTING reopen path still opens the previously known id and serves the diverged row, claiming the max generation', () => {
      const { m, knownId } = known()
      tamper(m.paidResultOf(binding())! as Record<string, unknown>)
      const opened = m.reopenPaidResult({ userId: U1, paidResultId: knownId })
      expect(opened.ok).toBe(true) // pinned: this is the gap, not a feature
      expect(opened.ok && opened.generation).toBe(1) // it reports generation 1 while the row no longer equals generation 1
      expect(m.projectionStatus(binding()).consistent).toBe(false)
    })
    it('the PROPOSED gate (not implemented) would refuse the same id with projection_unverified', () => {
      const { m, knownId } = known()
      tamper(m.paidResultOf(binding())! as Record<string, unknown>)
      expect(m.reopenPaidResultFailClosed({ userId: U1, paidResultId: knownId })).toEqual({ ok: false, code: 'projection_unverified' })
    })
  })

  it('a known id does not only come from an earlier answer: the dashboard summary lists the completed rows with their ids, and that id opens the diverged row as well', () => {
    const { m } = known()
    ;(m.paidResultOf(binding())! as Record<string, unknown>).result_json = { v: 'tampered' }
    // what app/api/dashboard/summary/route.ts:44 selects: the user's completed paid_results rows, id included
    const listed = m.state.paidResults.filter(r => r.user_id === U1 && r.status === 'completed').map(r => r.id)
    expect(listed).toHaveLength(1)
    expect(m.reopenPaidResult({ userId: U1, paidResultId: listed[0] }).ok).toBe(true) // KNOWN OPEN
  })

  it('what the existing path ALREADY refuses (its own filters): another user, an unknown id, a row that is not completed, a missing row -- the proposed gate agrees', () => {
    const a = known()
    const unknown = { userId: U1, paidResultId: 'nope' }
    expect(a.m.reopenPaidResult({ userId: U2, paidResultId: a.knownId })).toEqual({ ok: false, code: 'not_found' })
    expect(a.m.reopenPaidResult(unknown)).toEqual({ ok: false, code: 'not_found' })
    expect(a.m.reopenPaidResultFailClosed({ userId: U2, paidResultId: a.knownId })).toEqual({ ok: false, code: 'not_found' })
    const b = known(); b.m.paidResultOf(binding())!.status = 'archived'
    expect(b.m.reopenPaidResult({ userId: U1, paidResultId: b.knownId })).toEqual({ ok: false, code: 'not_found' }) // protected today by the status filter
    expect(b.m.reopenPaidResultFailClosed({ userId: U1, paidResultId: b.knownId })).toEqual({ ok: false, code: 'not_found' })
    const c = known(); c.m.state.paidResults = []
    expect(c.m.reopenPaidResult({ userId: U1, paidResultId: c.knownId })).toEqual({ ok: false, code: 'not_found' })
  })

  it('for a CONSISTENT row the two paths answer identically (the gate would not change the normal case), including an older operation after a refresh', () => {
    const { m, knownId } = known()
    mustOk(m.commit({ token: tok(m, 'b', 1), request: binding(), resultJson: { v: 'b' } }))
    expect(m.reopenPaidResultFailClosed({ userId: U1, paidResultId: knownId })).toEqual(m.reopenPaidResult({ userId: U1, paidResultId: knownId }))
    expect(m.reopenPaidResult({ userId: U1, paidResultId: knownId })).toMatchObject({ ok: true, generation: 2, resultJson: { v: 'b' } })
  })

  it('a legacy-only row (no generation yet) is consistent by definition: both paths open it', () => {
    const m = fresh(); const row = m.seedLegacyRow({ userId: U1, toolType: TOOL, inputHash: HASH, resultJson: { v: 'legacy' } })
    expect(m.reopenPaidResult({ userId: U1, paidResultId: row.id })).toMatchObject({ ok: true, generation: 1 })
    expect(m.reopenPaidResultFailClosed({ userId: U1, paidResultId: row.id })).toMatchObject({ ok: true, generation: 1 })
  })

  describe('source policy: today\'s path really is not fail-closed, and the gate exists nowhere in the code (when it is implemented, replace these with their positive counterpart)', () => {
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(path.join(dir, e.name))) : /\.(ts|tsx)$/.test(e.name) ? [path.join(dir, e.name)] : [])
    const service = fs.readFileSync(path.join('lib', 'paid-results', 'paid-results-service.ts'), 'utf8')
    const fn = service.slice(service.indexOf('export async function getPaidResultById'), service.indexOf('export async function getPaidResultByHash'))

    it('getPaidResultById filters on the id, the owner and the completed status ONLY -- no generation, digest or projection check', () => {
      expect(fn).toContain(".eq('id', id)")
      expect(fn).toContain(".eq('user_id', userId)")
      expect(fn).toContain(".eq('status', 'completed')")
      expect(fn).not.toMatch(/generation|digest|projection|consistent/i)
    })
    it('21 route call sites use it (a new one, or one fewer, must be reviewed against the gate first)', () => {
      const sites = walk(path.join('app', 'api')).filter(f => f.endsWith('route.ts')).flatMap(f => fs.readFileSync(f, 'utf8').split('\n').filter(l => /getPaidResultById\(/.test(l)).map(() => f))
      expect(sites).toHaveLength(21)
    })
    it('nothing in app/ or lib/ implements the gate: no G-REOPEN, no projection_unverified, no generation table access', () => {
      const hits = [...walk('app'), ...walk('lib')].filter(f => /G-REOPEN|projection_unverified|paid_result_generations/.test(fs.readFileSync(f, 'utf8'))).map(f => f.split(path.sep).join('/'))
      expect(hits).toEqual([])
    })
  })
})
