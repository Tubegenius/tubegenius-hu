// Editing Pattern Engine 1B: the deadline.
//
// WHAT IS PROVEN HERE: with a source that keeps the event loop free, the ANALYSIS (and with it the job) closes
// on its deadline even if next() never answers; the timer is always cleaned up; a late answer or a late
// rejection of a next() that was already abandoned changes nothing and writes nothing; the terminal store
// write happens exactly once.
//
// WHAT IS NOT PROVEN (and is not claimed): that the source or the decoder stops or frees anything.
// AbortSignal is cooperative, return() is only ATTEMPTED (the tests assert the attempt, not a release), and a
// synchronous CPU-bound source blocks every timer. That needs an isolated worker (decision D1).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { analyzeEditingPattern, type AnalyzeTimers } from '@/lib/editing-pattern/analyzer'
import type { FrameSignature, FrameSignatureSource } from '@/lib/editing-pattern/contract'
import { MIN_LEASE_TO_DEADLINE_RATIO, runEditingAnalysisJob, submitEditingAnalysis } from '@/lib/editing-pattern/job-runner'
import { InMemoryEditingJobStore } from '@/lib/editing-pattern/job-store-memory'
import { FixtureFrameSource, inputFor, slowTalkingHead } from './support/editing-pattern-fixtures'

class FakeTimers implements AnalyzeTimers {
  created: Array<{ ms: number; fn: () => void; cleared: boolean; fired: boolean }> = []
  setTimeout(fn: () => void, ms: number) {
    const t = { ms, fn, cleared: false, fired: false }
    this.created.push(t)
    return t
  }
  clearTimeout(handle: unknown) {
    ;(handle as { cleared: boolean }).cleared = true
  }
  /** fires the most recent timer that is still armed */
  fireLatest() {
    const armed = [...this.created].reverse().find((t) => !t.cleared && !t.fired)
    if (!armed) throw new Error('no armed timer')
    armed.fired = true
    armed.fn()
  }
  get outstanding() {
    return this.created.filter((t) => !t.cleared && !t.fired).length
  }
}

const flush = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise<void>((r) => setImmediate(r))
}

/** A source whose next() answers are decided by the test. */
class ScriptedSource implements FrameSignatureSource {
  signal: AbortSignal | undefined
  returnCalls = 0
  nextCalls = 0
  pending: Array<{ resolve: (r: IteratorResult<FrameSignature>) => void; reject: (e: unknown) => void }> = []
  constructor(private readonly answer: (index: number) => 'hang' | IteratorResult<FrameSignature>) {}
  open(_video: unknown, options?: { signal?: AbortSignal }): AsyncIterable<FrameSignature> {
    this.signal = options?.signal
    const self = this
    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<FrameSignature>> {
            const index = self.nextCalls
            self.nextCalls += 1
            const a = self.answer(index)
            if (a !== 'hang') return Promise.resolve(a)
            return new Promise((resolve, reject) => self.pending.push({ resolve, reject }))
          },
          return(): Promise<IteratorResult<FrameSignature>> {
            self.returnCalls += 1
            return Promise.resolve({ done: true, value: undefined })
          },
        }
      },
    }
  }
}

const unhandled: unknown[] = []
const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
beforeEach(() => { unhandled.length = 0; process.on('unhandledRejection', onUnhandled) })
afterEach(() => { process.off('unhandledRejection', onUnhandled) })

describe('the analysis closes on its deadline when next() never answers', () => {
  it('a source that hangs from the first next(): limit_exceeded / deadline_exceeded, with the timer sized to the deadline', async () => {
    const f = slowTalkingHead()
    const timers = new FakeTimers()
    const source = new ScriptedSource(() => 'hang')
    const promise = analyzeEditingPattern(inputFor(f, 'vid', { limits: { deadline_ms: 7_000 } }), source, { timers, now: () => 0 })
    await flush()
    expect(timers.created).toHaveLength(1)
    expect(timers.created[0].ms).toBe(7_000)
    timers.fireLatest()
    const result = await promise
    expect(result).toMatchObject({ status: 'limit_exceeded', reason_code: 'deadline_exceeded', metrics: null, cuts: [], shots: [] })
    // the source is TOLD to stop (a best effort): the signal is aborted and return() was attempted
    expect(source.signal?.aborted).toBe(true)
    expect(source.returnCalls).toBeGreaterThanOrEqual(1)
    expect(timers.outstanding).toBe(0)
  })

  it('a source that answers three frames and then hangs: the frames examined are reported, no metric is', async () => {
    const f = slowTalkingHead()
    const timers = new FakeTimers()
    const source = new ScriptedSource((i) => (i < 3 ? { done: false, value: f.frames[i] } : 'hang'))
    const promise = analyzeEditingPattern(inputFor(f, 'vid'), source, { timers, now: () => 0 })
    await flush()
    timers.fireLatest()
    const result = await promise
    expect(result).toMatchObject({ status: 'limit_exceeded', reason_code: 'deadline_exceeded', metrics: null })
    expect(result.evidence_basis).toMatchObject({ frames_examined: 3, frame_analysis_performed: true })
    expect(timers.outstanding).toBe(0)
  })

  it('the remaining time shrinks with every frame, and a spent budget stops the loop before the next read', async () => {
    const f = slowTalkingHead()
    let clock = 0
    const timers = new FakeTimers()
    const source = new FixtureFrameSource({ vid: f.frames }, { beforeFrame: () => { clock += 500 } })
    const result = await analyzeEditingPattern(inputFor(f, 'vid', { limits: { deadline_ms: 5_000 } }), source, { timers, now: () => clock })
    expect(result).toMatchObject({ status: 'limit_exceeded', reason_code: 'deadline_exceeded' })
    const ms = timers.created.map((t) => t.ms)
    expect(ms[0]).toBe(5_000)
    expect(ms).toEqual([...ms].sort((a, b) => b - a)) // never longer than the previous one
    expect(ms[ms.length - 1]).toBeLessThan(5_000)
    expect(source.framesYielded).toBeLessThan(15)
    expect(timers.outstanding).toBe(0)
  })
})

describe('late answers of an abandoned next() change nothing', () => {
  it('a late RESOLVE after the timeout is discarded: no new result, no exception', async () => {
    const f = slowTalkingHead()
    const timers = new FakeTimers()
    const source = new ScriptedSource(() => 'hang')
    const promise = analyzeEditingPattern(inputFor(f, 'vid'), source, { timers, now: () => 0 })
    await flush()
    timers.fireLatest()
    const result = await promise
    source.pending[0].resolve({ done: false, value: f.frames[0] })
    await flush()
    expect(result.status).toBe('limit_exceeded')
    expect(unhandled).toEqual([])
    expect(timers.outstanding).toBe(0)
  })

  it('a late REJECT after the timeout is observed: no unhandled rejection', async () => {
    const f = slowTalkingHead()
    const timers = new FakeTimers()
    const source = new ScriptedSource(() => 'hang')
    const promise = analyzeEditingPattern(inputFor(f, 'vid'), source, { timers, now: () => 0 })
    await flush()
    timers.fireLatest()
    await promise
    source.pending[0].reject(new Error('late failure with /private/path'))
    await flush()
    expect(unhandled).toEqual([])
  })
})

describe('the timer is always cleaned up', () => {
  it('on a normal run every timer is cleared (one per next(), including the final done)', async () => {
    const f = slowTalkingHead()
    const timers = new FakeTimers()
    const result = await analyzeEditingPattern(inputFor(f, 'vid'), new FixtureFrameSource({ vid: f.frames }), { timers })
    expect(result.status).toBe('complete')
    expect(timers.created).toHaveLength(f.frames.length + 1)
    expect(timers.outstanding).toBe(0)
    expect(timers.created.every((t) => t.cleared && !t.fired)).toBe(true)
  })

  it.each([
    ['the source throws', (f: ReturnType<typeof slowTalkingHead>) => new FixtureFrameSource({ vid: f.frames }, { failAfter: 5 })],
    ['a frame is invalid', (f: ReturnType<typeof slowTalkingHead>) => new FixtureFrameSource({ vid: f.frames }, { mutate: (fr) => fr.map((x, i) => (i === 4 ? { ...x, t_ms: -1 } : x)) })],
    ['the frame budget is exceeded', (f: ReturnType<typeof slowTalkingHead>) => new FixtureFrameSource({ vid: f.frames })],
  ])('when %s', async (_name, make) => {
    const f = slowTalkingHead()
    const timers = new FakeTimers()
    const limits = _name === 'the frame budget is exceeded' ? { limits: { max_frames: 240 } } : {}
    // for the budget case the source delivers 241 frames to a 240-frame budget
    const frames = _name === 'the frame budget is exceeded' ? [...f.frames, { ...f.frames[f.frames.length - 1], t_ms: 59_999 }] : f.frames
    const source = _name === 'the frame budget is exceeded' ? new FixtureFrameSource({ vid: frames }) : make(f)
    const result = await analyzeEditingPattern(inputFor(f, 'vid', limits), source, { timers })
    expect(result.status).not.toBe('complete')
    expect(timers.outstanding).toBe(0)
  })

  it('on cancellation the timer is cleared and the source is told to stop', async () => {
    const f = slowTalkingHead()
    const timers = new FakeTimers()
    const ac = new AbortController()
    const source = new FixtureFrameSource({ vid: f.frames }, { beforeFrame: (i) => { if (i === 3) ac.abort() } })
    const result = await analyzeEditingPattern(inputFor(f, 'vid'), source, { timers, signal: ac.signal })
    expect(result).toMatchObject({ status: 'failed', reason_code: 'cancelled' })
    expect(timers.outstanding).toBe(0)
  })
})

describe('the job layer: one terminal write, a lease that cannot be shorter than the deadline', () => {
  class SpyStore extends InMemoryEditingJobStore {
    completes = 0
    releases = 0
    claims: number[] = []
    async claim(jobId: string, nowMs: number, leaseMs: number, maxAttempts: number) {
      this.claims.push(leaseMs)
      return super.claim(jobId, nowMs, leaseMs, maxAttempts)
    }
    async complete(...args: Parameters<InMemoryEditingJobStore['complete']>) {
      this.completes += 1
      return super.complete(...args)
    }
    async release(...args: Parameters<InMemoryEditingJobStore['release']>) {
      this.releases += 1
      return super.release(...args)
    }
  }

  it('a hanging source ends in a COMPLETED job with limit_exceeded, written exactly once; a late answer writes nothing more', async () => {
    const f = slowTalkingHead()
    const store = new SpyStore()
    const timers = new FakeTimers()
    const source = new ScriptedSource(() => 'hang')
    const deps = { store, source, now: () => 1_000_000, timers }
    const sub = await submitEditingAnalysis(deps, 'u', inputFor(f, 'vid'))
    if (!sub.ok) throw new Error('submit failed')
    const run = runEditingAnalysisJob(deps, sub.job_id)
    await flush()
    timers.fireLatest()
    const outcome = await run
    expect(outcome).toMatchObject({ ran: true, state: 'completed', status: 'limit_exceeded', requeued: false })
    expect(store.completes).toBe(1)
    expect(store.releases).toBe(0)
    // the abandoned next() now answers: nothing may be written
    source.pending[0].resolve({ done: false, value: f.frames[0] })
    await flush()
    expect(store.completes).toBe(1)
    expect(store.releases).toBe(0)
    expect(unhandled).toEqual([])
    const job = await store.get(sub.job_id)
    expect(job).toMatchObject({ state: 'completed', error_code: null })
    expect(job!.result).toMatchObject({ status: 'limit_exceeded', reason_code: 'deadline_exceeded' })
  })

  it('a lease override below the deadline is raised to the floor; a larger one is kept', async () => {
    const f = slowTalkingHead()
    for (const [override, expected] of [[1, 3_000 * MIN_LEASE_TO_DEADLINE_RATIO], [500_000, 500_000]] as const) {
      const store = new SpyStore()
      const source = new FixtureFrameSource({ vid: f.frames })
      const deps = { store, source, now: () => 1_000_000, leaseMs: override }
      const sub = await submitEditingAnalysis(deps, 'u', inputFor(f, 'vid', { limits: { deadline_ms: 3_000 } }))
      if (!sub.ok) throw new Error('submit failed')
      await runEditingAnalysisJob(deps, sub.job_id)
      expect(store.claims).toEqual([expected])
    }
  })

  it('a worker that lost its lease writes nothing and reports that it is not the owner (the fenced write is refused)', async () => {
    const f = slowTalkingHead()
    const store = new SpyStore()
    const source = new FixtureFrameSource({ vid: f.frames })
    const deps = { store, source, now: () => 1_000_000 }
    const sub = await submitEditingAnalysis(deps, 'u', inputFor(f, 'vid'))
    if (!sub.ok) throw new Error('submit failed')
    const original = store.complete.bind(store)
    store.complete = async () => { store.completes += 1; return false } // the lease was taken over meanwhile
    const outcome = await runEditingAnalysisJob(deps, sub.job_id)
    expect(outcome).toEqual({ ran: true, state: 'running', status: null, requeued: false })
    expect(store.completes).toBe(1)
    expect(store.releases).toBe(0)
    store.complete = original
  })
})
