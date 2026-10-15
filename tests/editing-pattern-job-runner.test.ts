// Editing Pattern Engine 1B: the asynchronous, idempotent job layer (in-memory reference store).
// DB-free. The durable store is a migration + retention decision and is NOT tested here because it does not exist.
import { describe, expect, it } from 'vitest'
import { editingIdempotencyKey, editingJobIdFor, MAX_JOB_ATTEMPTS, runEditingAnalysisJob, submitEditingAnalysis } from '@/lib/editing-pattern/job-runner'
import { InMemoryEditingJobStore } from '@/lib/editing-pattern/job-store-memory'
import { validateEditingAnalysisInput } from '@/lib/editing-pattern/validate'
import { FixtureFrameSource, fastMontage, inputFor, slowTalkingHead } from './support/editing-pattern-fixtures'

function setup(hooks: ConstructorParameters<typeof FixtureFrameSource>[1] = {}) {
  const store = new InMemoryEditingJobStore()
  const slow = slowTalkingHead()
  const fast = fastMontage()
  const source = new FixtureFrameSource({ slow: slow.frames, fast: fast.frames }, hooks)
  let clock = 1_000_000
  const deps = { store, source, now: () => clock, leaseMs: 40_000 }
  return { store, source, deps, slow, fast, advance: (ms: number) => { clock += ms } }
}

describe('submit is idempotent', () => {
  it('the same owner and input is the same job; the second submit creates nothing and starts nothing', async () => {
    const { deps, slow } = setup()
    const first = await submitEditingAnalysis(deps, 'user-1', inputFor(slow, 'slow'))
    const second = await submitEditingAnalysis(deps, 'user-1', inputFor(slow, 'slow'))
    expect(first).toMatchObject({ ok: true, created: true, state: 'queued' })
    expect(second).toMatchObject({ ok: true, created: false })
    expect(second.ok && second.job_id).toBe(first.ok && first.job_id)
  })

  it('an input with the defaults spelled out is the same job as one that relies on them', async () => {
    const { deps, slow } = setup()
    const a = await submitEditingAnalysis(deps, 'u', inputFor(slow, 'slow'))
    const b = await submitEditingAnalysis(deps, 'u', inputFor(slow, 'slow', { params: { cut_sensitivity: 'normal', min_shot_length_ms: 500 } }))
    expect(a.ok && b.ok && a.job_id === b.job_id).toBe(true)
  })

  it('concurrent submits create exactly one job', async () => {
    const { deps, slow } = setup()
    const results = await Promise.all(Array.from({ length: 8 }, () => submitEditingAnalysis(deps, 'user-1', inputFor(slow, 'slow'))))
    expect(results.filter((r) => r.ok && r.created)).toHaveLength(1)
    expect(new Set(results.map((r) => r.ok && r.job_id)).size).toBe(1)
  })

  it('a different owner, source, parameter or limit is a different job', async () => {
    const { deps, slow } = setup()
    const base = await submitEditingAnalysis(deps, 'user-1', inputFor(slow, 'slow'))
    const variants = [
      await submitEditingAnalysis(deps, 'user-2', inputFor(slow, 'slow')),
      await submitEditingAnalysis(deps, 'user-1', inputFor(slow, 'other-source')),
      await submitEditingAnalysis(deps, 'user-1', inputFor(slow, 'slow', { params: { cut_sensitivity: 'high' } })),
      await submitEditingAnalysis(deps, 'user-1', inputFor(slow, 'slow', { limits: { max_frames: 300 } })),
    ]
    for (const v of variants) expect(v.ok && base.ok && v.job_id !== base.job_id).toBe(true)
  })

  it('rejects an invalid input and an invalid owner without creating a job', async () => {
    const { deps, store, slow } = setup()
    expect(await submitEditingAnalysis(deps, 'u', { contract_version: 'nope' })).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(await submitEditingAnalysis(deps, '', inputFor(slow, 'slow'))).toMatchObject({ ok: false, code: 'invalid_owner' })
    const key = editingIdempotencyKey('u', (validateEditingAnalysisInput(inputFor(slow, 'slow')) as { ok: true; input: never }).input)
    expect(await store.get(editingJobIdFor(key))).toBeNull()
  })
})

describe('run', () => {
  it('runs a queued job once and stores the result; running it again does nothing', async () => {
    const { deps, source, slow } = setup()
    const sub = await submitEditingAnalysis(deps, 'u', inputFor(slow, 'slow'))
    if (!sub.ok) throw new Error('submit failed')
    const first = await runEditingAnalysisJob(deps, sub.job_id)
    expect(first).toMatchObject({ ran: true, state: 'completed', status: 'complete' })
    expect(source.openCalls).toBe(1)
    const again = await runEditingAnalysisJob(deps, sub.job_id)
    expect(again).toEqual({ ran: false, reason: 'not_claimable' })
    expect(source.openCalls).toBe(1)
    const job = await deps.store.get(sub.job_id)
    expect(job).toMatchObject({ state: 'completed', attempt: 1, error_code: null })
    expect(job!.result!.metrics!.shot_count).toBe(6)
  })

  it('two workers racing for one job: exactly one analysis runs', async () => {
    const { deps, source, fast } = setup()
    const sub = await submitEditingAnalysis(deps, 'u', inputFor(fast, 'fast'))
    if (!sub.ok) throw new Error('submit failed')
    const outcomes = await Promise.all([runEditingAnalysisJob(deps, sub.job_id), runEditingAnalysisJob(deps, sub.job_id), runEditingAnalysisJob(deps, sub.job_id)])
    expect(outcomes.filter((o) => o.ran)).toHaveLength(1)
    expect(source.openCalls).toBe(1)
  })

  it('a deterministic non-result (insufficient data, limit exceeded) is a completed job and is never retried', async () => {
    const { deps, source, slow } = setup()
    const sub = await submitEditingAnalysis(deps, 'u', inputFor(slow, 'slow', { limits: { max_frames: 50 } }))
    if (!sub.ok) throw new Error('submit failed')
    expect(await runEditingAnalysisJob(deps, sub.job_id)).toMatchObject({ ran: true, state: 'completed', status: 'limit_exceeded' })
    expect(await runEditingAnalysisJob(deps, sub.job_id)).toEqual({ ran: false, reason: 'not_claimable' })
    expect(source.openCalls).toBe(0)
  })

  it('the result of a job equals a direct analysis of the same input (the job layer adds nothing and hides nothing)', async () => {
    const { deps, fast } = setup()
    const sub = await submitEditingAnalysis(deps, 'u', inputFor(fast, 'fast'))
    if (!sub.ok) throw new Error('submit failed')
    await runEditingAnalysisJob(deps, sub.job_id)
    const { analyzeEditingPattern } = await import('@/lib/editing-pattern/analyzer')
    const direct = await analyzeEditingPattern(inputFor(fast, 'fast'), new FixtureFrameSource({ fast: fast.frames }))
    expect((await deps.store.get(sub.job_id))!.result).toEqual(direct)
  })
})

describe('transient failures, leases and fencing', () => {
  it('a source error is retried until the attempts are exhausted, then the job is failed with the explicit outcome', async () => {
    const { deps, source, slow } = setup({ failAfter: 5 })
    const sub = await submitEditingAnalysis(deps, 'u', inputFor(slow, 'slow'))
    if (!sub.ok) throw new Error('submit failed')
    for (let i = 1; i < MAX_JOB_ATTEMPTS; i += 1) {
      expect(await runEditingAnalysisJob(deps, sub.job_id)).toMatchObject({ ran: true, state: 'queued', requeued: true })
    }
    expect(await runEditingAnalysisJob(deps, sub.job_id)).toMatchObject({ ran: true, state: 'failed', status: 'failed' })
    expect(source.openCalls).toBe(MAX_JOB_ATTEMPTS)
    const job = await deps.store.get(sub.job_id)
    expect(job).toMatchObject({ state: 'failed', error_code: 'source_error', attempt: MAX_JOB_ATTEMPTS })
    expect(job!.result).toMatchObject({ status: 'failed', reason_code: 'source_error' })
    expect(await runEditingAnalysisJob(deps, sub.job_id)).toEqual({ ran: false, reason: 'not_claimable' })
  })

  it('a live lease blocks other workers; an expired lease can be taken over', async () => {
    const { deps, store, advance, slow } = setup()
    const sub = await submitEditingAnalysis(deps, 'u', inputFor(slow, 'slow'))
    if (!sub.ok) throw new Error('submit failed')
    const claimed = await store.claim(sub.job_id, 1_000_000, 40_000, MAX_JOB_ATTEMPTS)
    expect(claimed).toMatchObject({ state: 'running', attempt: 1 })
    expect(await runEditingAnalysisJob(deps, sub.job_id)).toEqual({ ran: false, reason: 'not_claimable' })
    advance(40_001)
    expect(await runEditingAnalysisJob(deps, sub.job_id)).toMatchObject({ ran: true, state: 'completed' })
    expect((await store.get(sub.job_id))!.attempt).toBe(2)
  })

  it('a worker whose lease expired cannot overwrite the result of the worker that took over (attempt fencing)', async () => {
    const { deps, store, slow } = setup()
    const sub = await submitEditingAnalysis(deps, 'u', inputFor(slow, 'slow'))
    if (!sub.ok) throw new Error('submit failed')
    const stale = await store.claim(sub.job_id, 1_000_000, 10, MAX_JOB_ATTEMPTS) // attempt 1, lease 10 ms
    const fresh = await store.claim(sub.job_id, 1_000_100, 40_000, MAX_JOB_ATTEMPTS) // attempt 2 after expiry
    expect(stale!.attempt).toBe(1)
    expect(fresh!.attempt).toBe(2)
    const { analyzeEditingPattern } = await import('@/lib/editing-pattern/analyzer')
    const r = await analyzeEditingPattern(inputFor(slow, 'slow'), new FixtureFrameSource({ slow: slow.frames }))
    expect(await store.complete(sub.job_id, 1, { ...r, status: 'failed', reason_code: 'cancelled' }, 1_000_200)).toBe(false) // the stale worker is refused
    expect(await store.complete(sub.job_id, 2, r, 1_000_300)).toBe(true)
    expect((await store.get(sub.job_id))!.result!.status).toBe('complete')
  })

  it('a job whose leases keep expiring runs out of attempts and fails explicitly instead of looping', async () => {
    const { deps, store, advance, slow } = setup()
    const sub = await submitEditingAnalysis(deps, 'u', inputFor(slow, 'slow'))
    if (!sub.ok) throw new Error('submit failed')
    for (let i = 0; i < MAX_JOB_ATTEMPTS; i += 1) {
      expect(await store.claim(sub.job_id, 1_000_000 + i * 100_000, 10, MAX_JOB_ATTEMPTS)).not.toBeNull()
      advance(100_000)
    }
    expect(await runEditingAnalysisJob(deps, sub.job_id)).toEqual({ ran: false, reason: 'not_claimable' })
    expect(await store.get(sub.job_id)).toMatchObject({ state: 'failed', error_code: 'attempts_exhausted' })
  })
})
