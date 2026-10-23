// 2026-10-01 incident follow-up -- TS-layer tests for
// lib/paid-results/atomic-charge-save.ts, the wrapper around the new
// spend_credits_and_save_paid_result RPC (migration 093). DB-/providermentes:
// @supabase/ssr is mocked, nothing here touches a real Postgres instance --
// this file proves the TS-side parameter mapping, response mapping, and
// error-classification/logging contract; it does NOT (and cannot) prove the
// RPC's own transactional/atomicity behavior -- that needs a real Postgres
// and is covered separately by the pgTAP-style spec in
// tests/sql/093_spend_credits_and_save_paid_result.test.sql (written, NOT
// run, per the explicit "no DB/Docker" constraint on this pass).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@supabase/ssr', () => ({ createServerClient: vi.fn() }))

function makeFakeAdmin(rpcResult: { data: unknown; error: unknown }) {
  return { rpc: vi.fn((_fnName: string, _params: Record<string, unknown>) => Promise.resolve(rpcResult)) }
}

const baseInput = {
  userId: 'user-1',
  feature: 'video_package_long',
  cost: 6,
  chargeMetadata: { topic: 'Node.js Async/Await', platform: 'youtube', video_length: '6-10min' },
  toolType: 'video_package' as const,
  inputHash: 'hash-abc',
  normalizedInput: 'node.js async|await',
  originalInput: 'Node.js Async/Await',
  region: null,
  language: null,
  platform: 'youtube',
  resultJson: { hook: 'a secret-free hook', narration: 'a very long generated narration body' },
  summaryJson: { topic: 'Node.js Async/Await', platform: 'youtube', video_length: '6-10min', quality_status: 'verified' },
  creditCost: 6,
  freshForHours: 24,
  provider: 'anthropic',
  model: 'combined',
  promptTemplateId: 'video_package',
  promptVersion: 'v1',
  estimatedCost: 0.15,
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  consoleErrorSpy.mockRestore()
})

describe('chargeFeatureAndSavePaidResult -- success (non-duplicate) path', () => {
  it('forwards every parameter to the RPC under its exact p_-prefixed name, and maps a fresh (duplicate:false) response correctly', async () => {
    const fakeAdmin = makeFakeAdmin({
      data: {
        duplicate: false,
        paid_result: { id: 'paid-1', result_json: baseInput.resultJson },
        total_balance: 94,
        credit_transaction_id: 'ledger-1',
        operation_id: 'op-1',
      },
      error: null,
    })
    const ssr = await import('@supabase/ssr')
    vi.mocked(ssr.createServerClient).mockReturnValue(fakeAdmin as never)

    const { chargeFeatureAndSavePaidResult } = await import('@/lib/paid-results/atomic-charge-save')
    const result = await chargeFeatureAndSavePaidResult(baseInput)

    expect(fakeAdmin.rpc).toHaveBeenCalledTimes(1)
    const [fnName, params] = fakeAdmin.rpc.mock.calls[0]
    expect(fnName).toBe('spend_credits_and_save_paid_result')
    expect(params).toMatchObject({
      p_user_id: 'user-1',
      p_feature: 'video_package_long',
      p_cost: 6,
      p_charge_metadata: baseInput.chargeMetadata,
      p_tool_type: 'video_package',
      p_input_hash: 'hash-abc',
      p_normalized_input: 'node.js async|await',
      p_original_input: 'Node.js Async/Await',
      p_result_json: baseInput.resultJson,
      p_credit_cost: 6,
      p_provider: 'anthropic',
      p_model: 'combined',
      p_prompt_template_id: 'video_package',
      p_prompt_version: 'v1',
      p_estimated_cost: 0.15,
    })
    expect(typeof params.p_fresh_until).toBe('string') // freshForHours:24 -> ISO timestamp, not null

    expect(result).toEqual({
      success: true,
      duplicate: false,
      paidResult: { id: 'paid-1', result_json: baseInput.resultJson },
      newBalance: 94,
      creditTransactionId: 'ledger-1',
    })
  })

  it('p_fresh_until is null when freshForHours is not given', async () => {
    const fakeAdmin = makeFakeAdmin({ data: { duplicate: false, paid_result: { id: 'p' }, total_balance: 1 }, error: null })
    const ssr = await import('@supabase/ssr')
    vi.mocked(ssr.createServerClient).mockReturnValue(fakeAdmin as never)
    const { chargeFeatureAndSavePaidResult } = await import('@/lib/paid-results/atomic-charge-save')
    await chargeFeatureAndSavePaidResult({ ...baseInput, freshForHours: undefined })
    const [, params] = fakeAdmin.rpc.mock.calls[0]
    expect(params.p_fresh_until).toBeNull()
  })
})

describe('chargeFeatureAndSavePaidResult -- duplicate (idempotent replay) path', () => {
  it('a duplicate:true RPC response is mapped with the EXACT saved payload, paid_result_id (inside paidResult) and balance the RPC returned -- no new charge fields invented', async () => {
    const savedPayload = { hook: 'the ORIGINAL saved hook, not a freshly regenerated one', narration: 'original narration' }
    const fakeAdmin = makeFakeAdmin({
      data: {
        duplicate: true,
        paid_result: { id: 'paid-existing-1', result_json: savedPayload, fresh_until: '2026-11-01T00:00:00.000Z' },
        total_balance: 88,
        operation_id: 'op-1',
        // NOTE: credit_transaction_id intentionally absent here, mirroring
        // the RPC's duplicate branch, which does not look it up.
      },
      error: null,
    })
    const ssr = await import('@supabase/ssr')
    vi.mocked(ssr.createServerClient).mockReturnValue(fakeAdmin as never)

    const { chargeFeatureAndSavePaidResult } = await import('@/lib/paid-results/atomic-charge-save')
    const result = await chargeFeatureAndSavePaidResult(baseInput)

    expect(result.success).toBe(true)
    expect(result.duplicate).toBe(true)
    expect(result.paidResult).toEqual({ id: 'paid-existing-1', result_json: savedPayload, fresh_until: '2026-11-01T00:00:00.000Z' })
    expect(result.newBalance).toBe(88)
    expect(result.creditTransactionId).toBeUndefined()
  })
})

describe('chargeFeatureAndSavePaidResult -- error classification', () => {
  it('"insufficient credits" RPC error -> errorCode insufficient_credits, Hungarian message, no partial success fields', async () => {
    const fakeAdmin = makeFakeAdmin({ data: null, error: { code: 'P0001', message: 'insufficient credits' } })
    const ssr = await import('@supabase/ssr')
    vi.mocked(ssr.createServerClient).mockReturnValue(fakeAdmin as never)
    const { chargeFeatureAndSavePaidResult } = await import('@/lib/paid-results/atomic-charge-save')
    const result = await chargeFeatureAndSavePaidResult(baseInput)
    expect(result).toEqual({ success: false, error: 'Nincs elég kredited ehhez a művelethez.', errorCode: 'insufficient_credits' })
  })

  it('P0003 (conflicting non-completed row) RPC error -> errorCode conflicting_incomplete_result, explicit stop, no overwrite implied', async () => {
    const fakeAdmin = makeFakeAdmin({ data: null, error: { code: 'P0003', message: 'paid_results row already exists with non-completed status: failed' } })
    const ssr = await import('@supabase/ssr')
    vi.mocked(ssr.createServerClient).mockReturnValue(fakeAdmin as never)
    const { chargeFeatureAndSavePaidResult } = await import('@/lib/paid-results/atomic-charge-save')
    const result = await chargeFeatureAndSavePaidResult(baseInput)
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('conflicting_incomplete_result')
  })

  it('any other RPC error (e.g. a concurrent-insert unique_violation after the debit) -> errorCode unknown, generic no-charge message', async () => {
    const fakeAdmin = makeFakeAdmin({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "idx_paid_results_user_tool_hash"' } })
    const ssr = await import('@supabase/ssr')
    vi.mocked(ssr.createServerClient).mockReturnValue(fakeAdmin as never)
    const { chargeFeatureAndSavePaidResult } = await import('@/lib/paid-results/atomic-charge-save')
    const result = await chargeFeatureAndSavePaidResult(baseInput)
    expect(result).toEqual({ success: false, error: 'A mentés sikertelen volt. Kredit nem került levonásra.', errorCode: 'unknown' })
  })

  it('on ANY error, logs OUTSIDE the (already-rolled-back) transaction via a plain console.error -- WITHOUT the generated content (resultJson) or any secret value', async () => {
    const fakeAdmin = makeFakeAdmin({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } })
    const ssr = await import('@supabase/ssr')
    vi.mocked(ssr.createServerClient).mockReturnValue(fakeAdmin as never)
    const { chargeFeatureAndSavePaidResult } = await import('@/lib/paid-results/atomic-charge-save')
    await chargeFeatureAndSavePaidResult(baseInput)

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
    const loggedArgs = consoleErrorSpy.mock.calls[0]
    const loggedText = JSON.stringify(loggedArgs)
    // the actual generated content must never appear in the failure log
    expect(loggedText).not.toContain('a very long generated narration body')
    expect(loggedText).not.toContain('a secret-free hook')
    // sanity: the log IS still useful -- identifiers are present
    expect(loggedText).toContain('hash-abc')
    expect(loggedText).toContain('user-1')
  })
})

describe('chargeFeatureAndSavePaidResult -- "DB commitolt, de az RPC-válasz elveszett": confirmed rollback vs. uncertain network/timeout outcome', () => {
  it('a genuine Postgres-raised error (non-empty SQLSTATE code) IS treated as a confirmed rollback -- "no charge" language is accurate here', async () => {
    const fakeAdmin = makeFakeAdmin({ data: null, error: { code: 'P0001', message: 'insufficient credits' } })
    const ssr = await import('@supabase/ssr')
    vi.mocked(ssr.createServerClient).mockReturnValue(fakeAdmin as never)
    const { chargeFeatureAndSavePaidResult } = await import('@/lib/paid-results/atomic-charge-save')
    const result = await chargeFeatureAndSavePaidResult(baseInput)
    expect(result.errorCode).toBe('insufficient_credits') // not uncertain_outcome -- this IS confirmed
  })

  it('a network/timeout-shaped failure (empty code -- exactly how the installed @supabase/postgrest-js shapes a fetch-level error, per its own PostgrestBuilder.ts catch handler) is NOT treated as a confirmed rollback', async () => {
    // This exact shape -- code: '' -- is what node_modules/@supabase/postgrest-js/
    // src/PostgrestBuilder.ts's `.catch((fetchError) => ...)` branch always
    // produces for a fetch()-level failure (network error, DNS failure,
    // connection reset, or an exhausted-retry AbortError) -- verified by
    // reading that source directly, not assumed.
    const fakeAdmin = makeFakeAdmin({
      data: null,
      error: { message: 'TypeError: fetch failed', details: 'FetchError: fetch failed\n\nCaused by: Error: read ECONNRESET', hint: '', code: '' },
    })
    const ssr = await import('@supabase/ssr')
    vi.mocked(ssr.createServerClient).mockReturnValue(fakeAdmin as never)
    const { chargeFeatureAndSavePaidResult } = await import('@/lib/paid-results/atomic-charge-save')
    const result = await chargeFeatureAndSavePaidResult(baseInput)

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('uncertain_outcome')
    // the user-facing message must NOT claim the charge definitely didn't happen
    expect(result.error).not.toMatch(/nincs levonás|kreditet nem vontunk le|kredit nem lett levonva/i)
    expect(result.error).toMatch(/bizonytalan/i)
  })

  it('on an uncertain-outcome failure, the log is marked as uncertain -- NOT worded as a confirmed rollback -- and still carries no secrets or generated content', async () => {
    const fakeAdmin = makeFakeAdmin({ data: null, error: { message: 'AbortError: The operation was aborted', code: '' } })
    const ssr = await import('@supabase/ssr')
    vi.mocked(ssr.createServerClient).mockReturnValue(fakeAdmin as never)
    const { chargeFeatureAndSavePaidResult } = await import('@/lib/paid-results/atomic-charge-save')
    await chargeFeatureAndSavePaidResult(baseInput)

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
    const loggedText = JSON.stringify(consoleErrorSpy.mock.calls[0])
    expect(loggedText).toMatch(/BIZONYTALAN/i)
    expect(loggedText).not.toMatch(/megerősítetten visszagördült/i)
    expect(loggedText).not.toContain('a very long generated narration body')
    expect(loggedText).not.toContain('a secret-free hook')
  })

  it('an uncertain-outcome failure never triggers an automatic retry: the RPC is still called exactly once', async () => {
    const fakeAdmin = makeFakeAdmin({ data: null, error: { message: 'fetch failed', code: '' } })
    const ssr = await import('@supabase/ssr')
    vi.mocked(ssr.createServerClient).mockReturnValue(fakeAdmin as never)
    const { chargeFeatureAndSavePaidResult } = await import('@/lib/paid-results/atomic-charge-save')
    await chargeFeatureAndSavePaidResult(baseInput)
    expect(fakeAdmin.rpc).toHaveBeenCalledTimes(1)
  })

  it('PGRST202 (PostgREST "function not found in schema cache" -- the request never reached our function) is NOT treated as a confirmed rollback, even though its code is non-empty', async () => {
    const fakeAdmin = makeFakeAdmin({
      data: null,
      error: { code: 'PGRST202', message: "Could not find the function public.spend_credits_and_save_paid_result(...) in the schema cache" },
    })
    const ssr = await import('@supabase/ssr')
    vi.mocked(ssr.createServerClient).mockReturnValue(fakeAdmin as never)
    const { chargeFeatureAndSavePaidResult } = await import('@/lib/paid-results/atomic-charge-save')
    const result = await chargeFeatureAndSavePaidResult(baseInput)
    expect(result.errorCode).toBe('uncertain_outcome')
    expect(result.error).not.toMatch(/nincs levonás/i)
  })

  it('PGRST003 (a PostgREST-layer connection/pool problem) is NOT treated as a confirmed rollback either', async () => {
    const fakeAdmin = makeFakeAdmin({ data: null, error: { code: 'PGRST003', message: 'Could not query the database for the schema cache' } })
    const ssr = await import('@supabase/ssr')
    vi.mocked(ssr.createServerClient).mockReturnValue(fakeAdmin as never)
    const { chargeFeatureAndSavePaidResult } = await import('@/lib/paid-results/atomic-charge-save')
    const result = await chargeFeatureAndSavePaidResult(baseInput)
    expect(result.errorCode).toBe('uncertain_outcome')
  })

  it('an unrecognized SQLSTATE-shaped code (not in the explicit allowlist, e.g. a Postgres error this RPC has no documented reason to raise) also falls back to uncertain_outcome, not confirmed', async () => {
    const fakeAdmin = makeFakeAdmin({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } })
    const ssr = await import('@supabase/ssr')
    vi.mocked(ssr.createServerClient).mockReturnValue(fakeAdmin as never)
    const { chargeFeatureAndSavePaidResult } = await import('@/lib/paid-results/atomic-charge-save')
    const result = await chargeFeatureAndSavePaidResult(baseInput)
    expect(result.errorCode).toBe('uncertain_outcome')
  })

  it('each of the 4 explicitly allowlisted SQLSTATEs (P0001, P0003, P0004, 23505) IS treated as confirmed -- the allowlist is not accidentally empty or too narrow', async () => {
    const ssr = await import('@supabase/ssr')
    const { chargeFeatureAndSavePaidResult } = await import('@/lib/paid-results/atomic-charge-save')
    for (const code of ['P0001', 'P0003', 'P0004', '23505']) {
      const fakeAdmin = makeFakeAdmin({ data: null, error: { code, message: `simulated ${code}` } })
      vi.mocked(ssr.createServerClient).mockReturnValue(fakeAdmin as never)
      const result = await chargeFeatureAndSavePaidResult(baseInput)
      expect(result.errorCode, code).not.toBe('uncertain_outcome')
    }
  })

  it('the RPC call itself throwing (rejecting), not just resolving with an {error} shape, is also treated as uncertain_outcome -- there is no code at all to inspect in this case', async () => {
    const fakeAdmin = { rpc: vi.fn(() => Promise.reject(new Error('unexpected: connection pool exhausted'))) }
    const ssr = await import('@supabase/ssr')
    vi.mocked(ssr.createServerClient).mockReturnValue(fakeAdmin as never)
    const { chargeFeatureAndSavePaidResult } = await import('@/lib/paid-results/atomic-charge-save')
    const result = await chargeFeatureAndSavePaidResult(baseInput)
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('uncertain_outcome')
    expect(result.error).toMatch(/bizonytalan/i)
  })

  it('both uncertain paths log the attempt start time + elapsed ms and point to the reconciliation runbook (needed to bound WHEN the original transaction may have written)', async () => {
    const ssr = await import('@supabase/ssr')
    const { chargeFeatureAndSavePaidResult } = await import('@/lib/paid-results/atomic-charge-save')

    // path 1: resolved {error} shape, non-confirmed
    vi.mocked(ssr.createServerClient).mockReturnValue(makeFakeAdmin({ data: null, error: { message: 'fetch failed', code: '' } }) as never)
    await chargeFeatureAndSavePaidResult(baseInput)
    // path 2: thrown
    vi.mocked(ssr.createServerClient).mockReturnValue({ rpc: vi.fn(() => Promise.reject(new Error('boom'))) } as never)
    await chargeFeatureAndSavePaidResult(baseInput)

    expect(consoleErrorSpy).toHaveBeenCalledTimes(2)
    for (const call of consoleErrorSpy.mock.calls) {
      const ctx = call[1] as Record<string, unknown>
      expect(typeof ctx.attemptStartedAt).toBe('string')
      expect(Number.isNaN(Date.parse(ctx.attemptStartedAt as string))).toBe(false)
      expect(typeof ctx.elapsedMs).toBe('number')
      expect(ctx.elapsedMs as number).toBeGreaterThanOrEqual(0)
      expect(ctx.reconciliation).toBe('docs/operations/video-package-uncertain-outcome-reconciliation.md')
    }
  })

  it('the referenced reconciliation runbook exists and never concludes "no row => no charge => safe retry"', () => {
    const doc = readFileSync(join(process.cwd(), 'docs/operations/video-package-uncertain-outcome-reconciliation.md'), 'utf8')
    expect(doc).toMatch(/NEM bizonyíték|nem bizonyíték/i)
    // absence of rows can never be declared "proven not committed"; pg_stat_activity is not a closure gate
    expect(doc).not.toMatch(/bizonyítottan nem commitolt/i)
    expect(doc).toMatch(/nem találtunk commitot, a kimenet továbbra is bizonytalan/i)
    expect(doc).not.toMatch(/FROM pg_stat_activity/i)
    expect(doc).toMatch(/Nem alkalmas erre|NEM alkalmas erre/i)
    expect(doc).not.toMatch(/nincs sor\s*(=>|→|-)\s*(biztosan )?nem történt levonás/i)
    const src = readFileSync(join(process.cwd(), 'lib/paid-results/atomic-charge-save.ts'), 'utf8')
    expect(src).not.toMatch(/no row means\s+it definitely did NOT/i)
  })
})
