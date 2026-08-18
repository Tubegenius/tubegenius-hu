// PFM Creator Lane Architecture v0 — lib/creator-lane/saved-lookup-
// coordinator.ts race-védelme. Kiszervezve React-mentes, tisztán tesztelhető
// modulba KIFEJEZETTEN azért, hogy a versenyhelyzet-védelem determinisztikus
// deferred-Promise teszttel bizonyítható legyen (a repo Vitest-je nem tud
// React-et renderelni — statikus forrás-ellenőrzés nem bizonyítaná, hogy a
// tényleges ütemezés helyes, csak azt, hogy a szöveg jelen van).
import { describe, expect, it, vi } from 'vitest'
import { runSavedLookupCoordinated } from '@/lib/creator-lane/saved-lookup-coordinator'
import type { FetchSavedStatusResult } from '@/lib/creator-lane/saved-lookup-coordinator'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

describe('runSavedLookupCoordinated — basic behavior', () => {
  it('empty visible-key list: goes straight to onReady(empty Set), never calls fetchStatus', async () => {
    const tracker = { current: 0 }
    const onLoading = vi.fn()
    const onReady = vi.fn()
    const onError = vi.fn()
    const fetchStatus = vi.fn()

    await runSavedLookupCoordinated([], tracker, { onLoading, onReady, onError }, fetchStatus)

    expect(fetchStatus).not.toHaveBeenCalled()
    expect(onLoading).not.toHaveBeenCalled()
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(onReady).toHaveBeenCalledWith(new Set())
    expect(onError).not.toHaveBeenCalled()
  })

  it('non-empty list, successful lookup: onLoading then onReady with the fetched topics', async () => {
    const tracker = { current: 0 }
    const onLoading = vi.fn()
    const onReady = vi.fn()
    const onError = vi.fn()
    const fetchStatus = vi.fn(async () => ({ ok: true, topics: new Set(['A']) } as FetchSavedStatusResult))

    await runSavedLookupCoordinated(['A', 'B'], tracker, { onLoading, onReady, onError }, fetchStatus)

    expect(fetchStatus).toHaveBeenCalledWith(['A', 'B'])
    expect(onLoading).toHaveBeenCalledTimes(1)
    expect(onReady).toHaveBeenCalledWith(new Set(['A']))
    expect(onError).not.toHaveBeenCalled()
  })

  it('non-empty list, failed lookup (ok:false): onError, never onReady', async () => {
    const tracker = { current: 0 }
    const onReady = vi.fn()
    const onError = vi.fn()
    const fetchStatus = vi.fn(async () => ({ ok: false, topics: new Set() } as FetchSavedStatusResult))

    await runSavedLookupCoordinated(['A'], tracker, { onLoading: vi.fn(), onReady, onError }, fetchStatus)

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onReady).not.toHaveBeenCalled()
  })

  it('every call increments the tracker, including the empty-list branch', async () => {
    const tracker = { current: 0 }
    const cb = { onLoading: vi.fn(), onReady: vi.fn(), onError: vi.fn() }
    const fetchStatus = vi.fn(async () => ({ ok: true, topics: new Set() } as FetchSavedStatusResult))

    await runSavedLookupCoordinated([], tracker, cb, fetchStatus)
    expect(tracker.current).toBe(1)
    await runSavedLookupCoordinated(['A'], tracker, cb, fetchStatus)
    expect(tracker.current).toBe(2)
    await runSavedLookupCoordinated([], tracker, cb, fetchStatus)
    expect(tracker.current).toBe(3)
  })
})

describe('runSavedLookupCoordinated — deterministic race protection (deferred Promise)', () => {
  it('SCENARIO: request A (non-empty, in-flight) is superseded by a later empty-list run that goes ready immediately; A\'s late SUCCESS must not overwrite state', async () => {
    const tracker = { current: 0 }
    const onLoading = vi.fn()
    const onReady = vi.fn()
    const onError = vi.fn()
    const callbacks = { onLoading, onReady, onError }

    const defA = deferred<FetchSavedStatusResult>()
    const fetchStatus = vi.fn(() => defA.promise)

    // Request A starts for a non-empty topic list — fetchStatus is called,
    // but its promise is deliberately left unresolved (simulates a slow
    // network response).
    const runA = runSavedLookupCoordinated(['Régi téma'], tracker, callbacks, fetchStatus)
    // Let the microtask queue advance up to (but not past) the `await
    // fetchStatus(...)` inside runA, so tracker.current is already bumped
    // to 1 and onLoading has already fired for A.
    await Promise.resolve()
    expect(tracker.current).toBe(1)
    expect(onLoading).toHaveBeenCalledTimes(1)

    // The visible topic list changes to EMPTY before A resolves (e.g. the
    // user navigated away from all topics) — this run is synchronous end-
    // to-end (no fetchStatus call) and completes before A does.
    await runSavedLookupCoordinated([], tracker, callbacks, fetchStatus)
    expect(tracker.current).toBe(2)
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(onReady).toHaveBeenCalledWith(new Set())

    // NOW resolve A with a late SUCCESS carrying a topic that would
    // incorrectly mark something "saved" if it were allowed to apply.
    defA.resolve({ ok: true, topics: new Set(['Régi téma']) })
    await runA

    // A's late success must be silently discarded — no second onReady call,
    // and definitely not one carrying A's stale topic.
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it('SCENARIO: request A (non-empty, in-flight) is superseded by a later empty-list run; A\'s late ERROR must not flip the already-ready state to error', async () => {
    const tracker = { current: 0 }
    const onLoading = vi.fn()
    const onReady = vi.fn()
    const onError = vi.fn()
    const callbacks = { onLoading, onReady, onError }

    const defA = deferred<FetchSavedStatusResult>()
    const fetchStatus = vi.fn(() => defA.promise)

    const runA = runSavedLookupCoordinated(['Régi téma'], tracker, callbacks, fetchStatus)
    await Promise.resolve()
    expect(tracker.current).toBe(1)

    await runSavedLookupCoordinated([], tracker, callbacks, fetchStatus)
    expect(tracker.current).toBe(2)
    expect(onReady).toHaveBeenCalledTimes(1)

    // A resolves LATE with a failure.
    defA.resolve({ ok: false, topics: new Set() })
    await runA

    // Must NOT flip the UI into 'error' — the newer, empty-list run already
    // legitimately settled on 'ready'.
    expect(onError).not.toHaveBeenCalled()
    expect(onReady).toHaveBeenCalledTimes(1)
  })

  it('SCENARIO (control case): with only ONE in-flight request at a time, its own late success DOES apply normally', async () => {
    const tracker = { current: 0 }
    const onReady = vi.fn()
    const defA = deferred<FetchSavedStatusResult>()
    const fetchStatus = vi.fn(() => defA.promise)

    const runA = runSavedLookupCoordinated(['A'], tracker, { onLoading: vi.fn(), onReady, onError: vi.fn() }, fetchStatus)
    defA.resolve({ ok: true, topics: new Set(['A']) })
    await runA

    expect(onReady).toHaveBeenCalledTimes(1)
    expect(onReady).toHaveBeenCalledWith(new Set(['A']))
  })

  it('SCENARIO: two overlapping non-empty requests (A then B) — only B\'s (the LATER one\'s) result applies, regardless of resolution order', async () => {
    const tracker = { current: 0 }
    const onReady = vi.fn()
    const onError = vi.fn()
    const defA = deferred<FetchSavedStatusResult>()
    const defB = deferred<FetchSavedStatusResult>()
    let call = 0
    const fetchStatus = vi.fn(() => (++call === 1 ? defA.promise : defB.promise))

    const runA = runSavedLookupCoordinated(['A'], tracker, { onLoading: vi.fn(), onReady, onError }, fetchStatus)
    await Promise.resolve()
    const runB = runSavedLookupCoordinated(['B'], tracker, { onLoading: vi.fn(), onReady, onError }, fetchStatus)
    await Promise.resolve()

    // A resolves first (even though it started first, network timing can
    // still return it "second" in real life — here we resolve it LAST to
    // prove ORDER of resolution doesn't matter, only the request-id does).
    defB.resolve({ ok: true, topics: new Set(['B']) })
    await runB
    defA.resolve({ ok: true, topics: new Set(['A']) })
    await runA

    // Only B's result must have applied.
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(onReady).toHaveBeenCalledWith(new Set(['B']))
    expect(onError).not.toHaveBeenCalled()
  })
})
