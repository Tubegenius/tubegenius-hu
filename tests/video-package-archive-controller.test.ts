// Az archívum-állapotgép (lib/paid-results/video-package-archive-controller.ts) VISELKEDÉSALAPÚ tesztjei.
//
// A tesztek a KLIENSOLDALI védelmet bizonyítják: egy lapra (sessionStorage) és egy böngészőprofilra (localStorage) szólnak,
// a szerver POST nem idempotens, eszközök/böngészők között semmit nem állítanak. Nincs React-renderelés: az oldal
// huzalozását a tests/video-package-save-wiring.test.ts forrásszinten, a szöveges állításokat is csak statikusan ellenőrzi.
import { describe, expect, it, vi } from 'vitest'
import {
  INITIAL_ARCHIVE_STATE,
  MISSING_PAID_RESULT_ID_MESSAGE,
  createArchiveController,
  type ArchiveState,
} from '@/lib/paid-results/video-package-archive-controller'
import {
  ARCHIVE_REF_STORAGE_KEY,
  MEMORY_ENDPOINT,
  MEMORY_LINK_TIMEOUT_MS,
  UNCERTAIN_SAVE_MESSAGE,
  VIDEO_PACKAGES_ENDPOINT,
  createStorageUncertainStore,
  createVideoPackageSaver,
  readArchiveRef,
} from '@/lib/paid-results/video-package-save-client'

const PAID_A = '3f2b8f0e-7c1a-4d5e-9b6a-1c2d3e4f5a6b'
const PAID_B = '7a1c2d3e-4b5f-4a6b-8c7d-9e0f1a2b3c4d'
const ctx = { searchKeyword: null as string | null }

class MemStorage {
  data = new Map<string, string>()
  getItem(key: string) { return this.data.has(key) ? this.data.get(key)! : null }
  setItem(key: string, value: string) { this.data.set(key, value) }
}

const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })

interface Routes {
  post?: (n: number) => Promise<Response> | Response
  memory?: (n: number, init?: RequestInit) => Promise<Response> | Response
  get?: (url: string) => Promise<Response> | Response
}

// Egyetlen, URL szerint irányító hamis fetch; minden hívást naplóz.
function makeFetch(routes: Routes) {
  const counts = { post: 0, memory: 0, get: 0 }
  const calls: Array<{ kind: 'post' | 'memory' | 'get'; url: string }> = []
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === MEMORY_ENDPOINT) { counts.memory++; calls.push({ kind: 'memory', url }); return (routes.memory ?? (() => json(200, {})))(counts.memory, init) }
    if (url.startsWith(VIDEO_PACKAGES_ENDPOINT + '?id=')) { counts.get++; calls.push({ kind: 'get', url }); return (routes.get ?? (() => json(404, {})))(url) }
    if (url === VIDEO_PACKAGES_ENDPOINT) { counts.post++; calls.push({ kind: 'post', url }); return (routes.post ?? (() => json(200, { id: 'pkg-' + counts.post })))(counts.post) }
    throw new Error('unexpected url ' + url)
  })
  return { fn: fn as unknown as typeof fetch, counts, calls }
}

// "Lap": egy saver + egy vezérlő, közös (újratöltéskor megmaradó) tárolókkal.
function makePage(opts: { fetchSpy: ReturnType<typeof makeFetch>; session: MemStorage; local: MemStorage }) {
  const states: ArchiveState[] = []
  const saver = createVideoPackageSaver(opts.fetchSpy.fn, { uncertain: createStorageUncertainStore(() => opts.local) })
  const controller = createArchiveController({
    saver,
    getSessionStorage: () => opts.session,
    fetchImpl: opts.fetchSpy.fn,
    onChange: s => states.push(s),
  })
  return { saver, controller, states }
}

const fresh = () => ({ session: new MemStorage(), local: new MemStorage() })
const pkg = (id: string | undefined = PAID_A) => ({ paid_result_id: id, topic: 'Egy téma' })

describe('fresh generation: saved only after a confirmed archive POST', () => {
  it('success: saved + id + reference stored; Memory linked; one POST', async () => {
    const f = makeFetch({})
    const { controller } = makePage({ fetchSpy: f, ...fresh() })
    const token = controller.beginGeneration()
    const outcome = await controller.persist(token, pkg(), ctx)
    expect(outcome).toMatchObject({ status: 'saved', id: 'pkg-1', memoryLinked: true })
    expect(controller.getState()).toMatchObject({ saved: true, savedPackageId: 'pkg-1', saveError: null, memoryLinkFailed: false, archiving: false })
    expect(f.counts).toEqual({ post: 1, memory: 1, get: 0 })
  })

  it('the package reference is stored in the session storage under THIS paid result', async () => {
    const session = new MemStorage()
    const { controller } = makePage({ fetchSpy: makeFetch({}), session, local: new MemStorage() })
    await controller.persist(controller.beginGeneration(), pkg(), ctx)
    expect(readArchiveRef(session.getItem(ARCHIVE_REF_STORAGE_KEY), PAID_A)).toBe('pkg-1')
    expect(readArchiveRef(session.getItem(ARCHIVE_REF_STORAGE_KEY), PAID_B)).toBeNull()
  })

  it('a missing paid_result_id sends nothing and shows an error that is not retry-safe', async () => {
    const f = makeFetch({})
    const { controller } = makePage({ fetchSpy: f, ...fresh() })
    const outcome = await controller.persist(controller.beginGeneration(), { topic: 'Egy téma' }, ctx) // no paid_result_id at all
    expect(outcome).toBeNull()
    expect(controller.getState().saveError).toEqual({ message: MISSING_PAID_RESULT_ID_MESSAGE, retrySafe: false })
    expect(f.fn).not.toHaveBeenCalled()
  })

  it('beginGeneration resets everything (saved, error, memory notice)', async () => {
    const { controller } = makePage({ fetchSpy: makeFetch({}), ...fresh() })
    await controller.persist(controller.beginGeneration(), pkg(), ctx)
    expect(controller.getState().saved).toBe(true)
    controller.beginGeneration()
    expect(controller.getState()).toEqual(INITIAL_ARCHIVE_STATE)
  })
})

describe('F4: the archive POST result is recorded at once, independent of the Memory call', () => {
  it('a HANGING Memory call: saved + id + reference are already set while Memory is pending; later memoryLinkFailed is a SEPARATE flag', async () => {
    vi.useFakeTimers()
    try {
      const session = new MemStorage()
      const f = makeFetch({
        memory: (_n, init) => new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))) }),
      })
      const { controller } = makePage({ fetchSpy: f, session, local: new MemStorage() })
      const token = controller.beginGeneration()
      const pending = controller.persist(token, pkg(), ctx)

      await vi.advanceTimersByTimeAsync(50)
      expect(f.counts.memory).toBe(1) // the Memory call is hanging ...
      expect(controller.getState()).toMatchObject({ saved: true, savedPackageId: 'pkg-1', saveError: null, memoryLinkFailed: false }) // ... but the archive state is already recorded
      expect(readArchiveRef(session.getItem(ARCHIVE_REF_STORAGE_KEY), PAID_A)).toBe('pkg-1')

      await vi.advanceTimersByTimeAsync(MEMORY_LINK_TIMEOUT_MS)
      await pending
      expect(controller.getState()).toMatchObject({ saved: true, savedPackageId: 'pkg-1', saveError: null, memoryLinkFailed: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a failing Memory call (HTTP 500): the package stays saved, no save error, the Memory failure is its own flag', async () => {
    const f = makeFetch({ memory: () => json(500, {}) })
    const { controller } = makePage({ fetchSpy: f, ...fresh() })
    await controller.persist(controller.beginGeneration(), pkg(), ctx)
    expect(controller.getState()).toMatchObject({ saved: true, saveError: null, memoryLinkFailed: true })
  })
})

describe('definite vs uncertain failures', () => {
  it('HTTP 400 (before the insert): retry-safe error; ONE explicit retry may send ONE more POST and then saves', async () => {
    const f = makeFetch({ post: n => (n === 1 ? json(400, {}) : json(200, { id: 'pkg-2' })) })
    const { controller } = makePage({ fetchSpy: f, ...fresh() })
    await controller.persist(controller.beginGeneration(), pkg(), ctx)
    expect(controller.getState().saveError).toMatchObject({ retrySafe: true })
    expect(controller.getState().saved).toBe(false)

    const retried = await controller.retry(pkg(), ctx)
    expect(retried.outcome).toMatchObject({ status: 'saved', id: 'pkg-2' })
    expect(f.counts.post).toBe(2)
    expect(controller.getState()).toMatchObject({ saved: true, savedPackageId: 'pkg-2', saveError: null })

    const again = await controller.retry(pkg(), ctx) // already saved: nothing more
    expect(again.outcome).toBeNull()
    expect(f.counts.post).toBe(2)
  })

  it.each([
    ['HTTP 500', () => json(500, {})],
    ['HTTP 503', () => json(503, {})],
    ['HTTP 504', () => json(504, {})],
    ['an unreadable 2xx', () => new Response('<html>', { status: 200 })],
  ])('%s: not saved, error NOT retry-safe, retry() sends nothing, no Memory call, and the text does not claim a failed save', async (_name, answer) => {
    const f = makeFetch({ post: answer })
    const { controller } = makePage({ fetchSpy: f, ...fresh() })
    await controller.persist(controller.beginGeneration(), pkg(), ctx)
    const state = controller.getState()
    expect(state.saved).toBe(false)
    expect(state.saveError).toEqual({ message: UNCERTAIN_SAVE_MESSAGE, retrySafe: false })
    expect(state.saveError!.message).not.toMatch(/nem sikerült|nem történt meg|memória/i)

    const retried = await controller.retry(pkg(), ctx)
    expect(retried.outcome).toBeNull()
    expect(f.counts).toEqual({ post: 1, memory: 0, get: 0 })
  })

  it('a network failure is uncertain too: no retry', async () => {
    const f = makeFetch({ post: () => { throw new TypeError('offline') } })
    const { controller } = makePage({ fetchSpy: f, ...fresh() })
    await controller.persist(controller.beginGeneration(), pkg(), ctx)
    expect(controller.getState().saveError).toMatchObject({ retrySafe: false })
    expect((await controller.retry(pkg(), ctx)).outcome).toBeNull()
    expect(f.counts.post).toBe(1)
  })

  it('retry() is refused while an archive request is still running (no second request)', async () => {
    let release: (r: Response) => void = () => {}
    const f = makeFetch({
      post: n => (n === 1 ? json(400, {}) : new Promise<Response>(resolve => { release = resolve })),
    })
    const { controller } = makePage({ fetchSpy: f, ...fresh() })
    await controller.persist(controller.beginGeneration(), pkg(), ctx)
    const first = controller.retry(pkg(), ctx)
    await Promise.resolve()
    expect(controller.getState().archiving).toBe(true)
    const second = await controller.retry(pkg(), ctx) // click while the first retry is in flight
    expect(second.outcome).toBeNull()
    release(json(200, { id: 'pkg-2' }))
    await first
    expect(f.counts.post).toBe(2)
  })
})

describe('F1: reload / cache hit never starts an automatic archive save', () => {
  it('cache hit without a stored reference: reconcileReopened sends NO POST and no GET; the result stays unverified (not saved)', async () => {
    const f = makeFetch({})
    const { controller } = makePage({ fetchSpy: f, ...fresh() })
    controller.beginGeneration()
    expect(await controller.reconcileReopened(pkg())).toBe('unverified')
    expect(controller.getState()).toEqual(INITIAL_ARCHIVE_STATE)
    expect(f.fn).not.toHaveBeenCalled()
  })

  it('reload after a CONFIRMED save: the stored reference is verified by one read-only GET, then the state is saved (no POST)', async () => {
    const shared = fresh()
    const f1 = makeFetch({})
    await makePage({ fetchSpy: f1, ...shared }).controller.persist(1, pkg(), ctx)

    const f2 = makeFetch({ get: () => json(200, { package: { id: 'pkg-1' } }) })
    const reloaded = makePage({ fetchSpy: f2, ...shared })
    expect(await reloaded.controller.reconcileReopened(pkg())).toBe('archived')
    expect(reloaded.controller.getState()).toMatchObject({ saved: true, savedPackageId: 'pkg-1' })
    expect(f2.counts).toEqual({ post: 0, memory: 0, get: 1 })
  })

  it('the stored reference is useless when the row is gone (GET 404) or unreachable (GET 500): not saved', async () => {
    for (const answer of [() => json(404, {}), () => json(500, {})]) {
      const shared = fresh()
      await makePage({ fetchSpy: makeFetch({}), ...shared }).controller.persist(1, pkg(), ctx)
      const f = makeFetch({ get: answer })
      const reloaded = makePage({ fetchSpy: f, ...shared })
      expect(await reloaded.controller.reconcileReopened(pkg())).not.toBe('archived')
      expect(reloaded.controller.getState().saved).toBe(false)
      expect(f.counts.post).toBe(0)
    }
  })

  it('a reference of ANOTHER paid result proves nothing', async () => {
    const shared = fresh()
    await makePage({ fetchSpy: makeFetch({}), ...shared }).controller.persist(1, pkg(PAID_B), ctx)
    const f = makeFetch({ get: () => json(200, { package: { id: 'pkg-1' } }) })
    const reloaded = makePage({ fetchSpy: f, ...shared })
    expect(await reloaded.controller.reconcileReopened(pkg(PAID_A))).toBe('unverified')
    expect(reloaded.controller.getState().saved).toBe(false)
    expect(f.counts.get).toBe(0)
  })

  it('RELOAD AFTER AN UNCERTAIN SAVE (HTTP 500): fail-closed — shown as uncertain, not saved, no retry, and even a direct persist() sends nothing', async () => {
    const shared = fresh()
    const before = makePage({ fetchSpy: makeFetch({ post: () => json(500, {}) }), ...shared })
    await before.controller.persist(before.controller.beginGeneration(), pkg(), ctx)

    const f = makeFetch({})
    const reloaded = makePage({ fetchSpy: f, ...shared })
    expect(await reloaded.controller.reconcileReopened(pkg())).toBe('uncertain')
    expect(reloaded.controller.getState()).toMatchObject({ saved: false, saveError: { message: UNCERTAIN_SAVE_MESSAGE, retrySafe: false } })
    expect((await reloaded.controller.retry(pkg(), ctx)).outcome).toBeNull()
    const direct = await reloaded.controller.persist(reloaded.controller.currentToken(), pkg(), ctx)
    expect(direct).toMatchObject({ status: 'error', retrySafe: false })
    expect(f.counts.post).toBe(0)
  })

  it('RELOAD WHILE THE FIRST REQUEST WAS STILL IN FLIGHT (never answered): the next page load is fail-closed too', async () => {
    const shared = fresh()
    const before = makePage({ fetchSpy: makeFetch({ post: () => new Promise<Response>(() => {}) }), ...shared })
    void before.controller.persist(before.controller.beginGeneration(), pkg(), ctx)
    await new Promise<void>(resolve => setTimeout(resolve, 0))

    const f = makeFetch({})
    const reloaded = makePage({ fetchSpy: f, ...shared })
    expect(await reloaded.controller.reconcileReopened(pkg())).toBe('uncertain')
    expect((await reloaded.controller.persist(reloaded.controller.currentToken(), pkg(), ctx))).toMatchObject({ status: 'error', retrySafe: false })
    expect(f.counts.post).toBe(0)
  })

  it('a definite 400 does NOT make the reloaded page uncertain (the marker was cleared); it is simply unverified, and still no automatic save', async () => {
    const shared = fresh()
    const before = makePage({ fetchSpy: makeFetch({ post: () => json(400, {}) }), ...shared })
    await before.controller.persist(before.controller.beginGeneration(), pkg(), ctx)
    const f = makeFetch({})
    const reloaded = makePage({ fetchSpy: f, ...shared })
    expect(await reloaded.controller.reconcileReopened(pkg())).toBe('unverified')
    expect(f.fn).not.toHaveBeenCalled()
  })

  it('without any usable storage (null) the reconcile is simply "unverified" and sends nothing', async () => {
    const f = makeFetch({})
    const controller = createArchiveController({
      saver: createVideoPackageSaver(f.fn, { uncertain: createStorageUncertainStore(() => null) }),
      getSessionStorage: () => null,
      fetchImpl: f.fn,
      onChange: () => {},
    })
    expect(await controller.reconcileReopened(pkg())).toBe('unverified')
    expect(f.fn).not.toHaveBeenCalled()
  })
})

describe('F3: a late-finishing old save cannot change the state of a newer generation', () => {
  it('old save resolves AFTER a new generation started: the new state stays untouched, only the paid-result-keyed reference is stored', async () => {
    let release: (r: Response) => void = () => {}
    const session = new MemStorage()
    const f = makeFetch({ post: () => new Promise<Response>(resolve => { release = resolve }) })
    const { controller, states } = makePage({ fetchSpy: f, session, local: new MemStorage() })

    const oldToken = controller.beginGeneration()
    const oldSave = controller.persist(oldToken, pkg(PAID_A), ctx)
    await Promise.resolve()
    const newToken = controller.beginGeneration() // the user starts a new generation
    const changesBefore = states.length

    release(json(200, { id: 'pkg-old' }))
    await oldSave

    expect(controller.isCurrent(oldToken)).toBe(false)
    expect(controller.isCurrent(newToken)).toBe(true)
    expect(controller.getState()).toEqual(INITIAL_ARCHIVE_STATE) // not "saved", no old package id
    expect(states.length).toBe(changesBefore) // no state change was emitted by the stale save
    expect(readArchiveRef(session.getItem(ARCHIVE_REF_STORAGE_KEY), PAID_A)).toBe('pkg-old') // the fact that a row exists is not lost
  })

  it('a stale ERROR does not appear on the new generation either', async () => {
    let release: (r: Response) => void = () => {}
    const f = makeFetch({ post: () => new Promise<Response>(resolve => { release = resolve }) })
    const { controller } = makePage({ fetchSpy: f, ...fresh() })
    const oldSave = controller.persist(controller.beginGeneration(), pkg(PAID_A), ctx)
    await Promise.resolve()
    controller.beginGeneration()
    release(json(500, {}))
    await oldSave
    expect(controller.getState()).toEqual(INITIAL_ARCHIVE_STATE)
  })

  it('a late retry of the old result does not mark the NEW result as saved; the new result can still be saved normally', async () => {
    let releaseRetry: (r: Response) => void = () => {}
    const f = makeFetch({
      post: n => (n === 1 ? json(400, {}) : n === 2 ? new Promise<Response>(resolve => { releaseRetry = resolve }) : json(200, { id: 'pkg-new' })),
    })
    const { controller } = makePage({ fetchSpy: f, ...fresh() })
    await controller.persist(controller.beginGeneration(), pkg(PAID_A), ctx)
    const lateRetry = controller.retry(pkg(PAID_A), ctx)
    await Promise.resolve()

    const newToken = controller.beginGeneration()
    releaseRetry(json(200, { id: 'pkg-old' }))
    await lateRetry
    expect(controller.getState().saved).toBe(false)

    await controller.persist(newToken, pkg(PAID_B), ctx)
    expect(controller.getState()).toMatchObject({ saved: true, savedPackageId: 'pkg-new' })
  })

  it('a stale reconcile (verification answered after a new generation started) does not mark anything saved', async () => {
    const shared = fresh()
    await makePage({ fetchSpy: makeFetch({}), ...shared }).controller.persist(1, pkg(), ctx)
    let release: (r: Response) => void = () => {}
    const f = makeFetch({ get: () => new Promise<Response>(resolve => { release = resolve }) })
    const { controller } = makePage({ fetchSpy: f, ...shared })
    const check = controller.reconcileReopened(pkg())
    await Promise.resolve()
    await Promise.resolve()
    controller.beginGeneration()
    release(json(200, { package: { id: 'pkg-1' } }))
    await check
    expect(controller.getState().saved).toBe(false)
  })

  it('two references do not clobber each other: a late save of A does not erase the reference of B', async () => {
    const session = new MemStorage()
    const f = makeFetch({ post: n => json(200, { id: 'pkg-' + n }) })
    const { controller } = makePage({ fetchSpy: f, session, local: new MemStorage() })
    await controller.persist(controller.beginGeneration(), pkg(PAID_B), ctx)
    await controller.persist(controller.beginGeneration(), pkg(PAID_A), ctx)
    const raw = session.getItem(ARCHIVE_REF_STORAGE_KEY)
    expect(readArchiveRef(raw, PAID_A)).toBe('pkg-2')
    expect(readArchiveRef(raw, PAID_B)).toBe('pkg-1')
  })
})

describe('markArchived (the explicit ?id= load)', () => {
  it('marks the current state saved without any request', () => {
    const f = makeFetch({})
    const { controller } = makePage({ fetchSpy: f, ...fresh() })
    controller.markArchived('pkg-9')
    expect(controller.getState()).toMatchObject({ saved: true, savedPackageId: 'pkg-9', saveError: null })
    expect(f.fn).not.toHaveBeenCalled()
  })
})
