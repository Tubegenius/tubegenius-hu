// Videócsomag-mentés kliensoldali rétege (lib/paid-results/video-package-save-client.ts) + a
// 2026-10-22-i staging HTTP 400 pontos okának reprodukciója.
//
// A reprodukció NEM tartalmaz valódi tartalmat: a megfigyelt (valódi) kérés minden mezőjének
// JSON-bájtméretét (UTF-8) egy szintetikus, ékezetes (többbájtos) töltelék reprodukálja pontosan.
// A méretek a staging Preview-ban lévő tényleges eredményből származnak (csak darabszámok).
import { describe, expect, it, vi } from 'vitest'
import { isJsonWithinLimit } from '@/lib/api-input-validation'
import {
  MEMORY_ENDPOINT,
  MEMORY_LINK_TIMEOUT_MS,
  PRE_WRITE_HTTP_STATUSES,
  UNCERTAIN_IDS_STORAGE_KEY,
  UNCERTAIN_SAVE_MESSAGE,
  VIDEO_PACKAGES_ENDPOINT,
  buildLinkPackageToMemoryBody,
  buildSaveVideoPackageBody,
  createStorageUncertainStore,
  createVideoPackageSaver,
  isDefinitelyNotWritten,
  mapSaveVideoPackageError,
  mergeArchiveRef,
  readArchiveRef,
  verifyArchivedPackage,
} from '@/lib/paid-results/video-package-save-client'

const PAID_RESULT_ID = '3f2b8f0e-7c1a-4d5e-9b6a-1c2d3e4f5a6b'
const encoder = new TextEncoder()
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).length

// ---- a korábbi (hibás) automatikus mentés kérésének alakja és a megfigyelt mezőméretek ----
// kulcs -> [típus, JSON-bájtméret a megfigyelt kérésben]. A `verified_fact_block` a böngészőbeli
// factBlockRef.current string, aminek a mérete nem volt rekonstruálható: alsó korlátként `null`.
const LEGACY_BODY_FIELDS: Array<[string, 'string' | 'array' | 'object' | 'null' | 'false', number]> = [
  ['paid_result_id', 'string', 38], ['topic', 'string', 75], ['search_keyword', 'null', 4], ['platform', 'string', 14],
  ['video_length', 'string', 9], ['narration_style', 'string', 14], ['intensity', 'string', 4], ['goal', 'string', 4],
  ['sources', 'array', 360], ['verified_fact_block', 'null', 4], ['verified_fact_block_json', 'object', 2917],
  ['forbidden_claims', 'array', 2], ['sources_used', 'array', 360], ['quality_status', 'string', 10],
  ['content_type', 'string', 17], ['strict_fact_mode', 'false', 5], ['fact_strictness_level', 'string', 4],
  ['intensity_original', 'string', 9], ['intensity_final', 'string', 9], ['hook', 'string', 191],
  ['narration', 'string', 6112], ['scene_structure', 'array', 6196], ['broll_ideas', 'array', 499],
  ['timestamps', 'array', 437], ['title_variations', 'array', 315], ['thumbnail_texts', 'array', 91],
  ['caption', 'string', 184], ['description', 'string', 1576], ['hashtags', 'object', 121],
  ['upload_times', 'object', 160], ['cta', 'string', 203], ['estimated_word_count', 'string', 14], ['estimated_duration', 'string', 11],
]

// Pontosan `n` JSON-bájtos string-literál, többbájtos (á = 2 bájt) tartalommal.
function stringOfJsonBytes(n: number): string {
  const content = n - 2
  const pairs = Math.floor(content / 4)
  return 'á'.repeat(pairs) + 'a'.repeat(content - pairs * 2)
}

function valueOfJsonBytes(kind: 'string' | 'array' | 'object' | 'null' | 'false', n: number): unknown {
  if (kind === 'null') return null
  if (kind === 'false') return false
  if (kind === 'string') return stringOfJsonBytes(n)
  if (kind === 'array') return n === 2 ? [] : [stringOfJsonBytes(n - 2)]
  return { a: stringOfJsonBytes(n - 6) }
}

function legacyBody(): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  for (const [key, kind, n] of LEGACY_BODY_FIELDS) {
    const value = valueOfJsonBytes(kind, n)
    expect(bytes(value), `${key} must reproduce its observed ${n} JSON bytes`).toBe(n)
    body[key] = value
  }
  body.paid_result_id = PAID_RESULT_ID
  return body
}

describe('reproduction of the staging HTTP 400 on POST /api/video-packages (2026-10-22)', () => {
  it('the legacy autosave body is rebuilt with the observed per-field UTF-8 sizes', () => {
    const body = legacyBody()
    expect(Object.keys(body)).toHaveLength(33)
    expect(Object.keys(body)).toContain('narration')
    expect(Object.keys(body)).toContain('scene_structure')
  })

  it('even with the unknown factBlockRef string at its minimum (null) the body is over the route\'s 20 000-byte limit', () => {
    const body = legacyBody()
    const valuesOnly = LEGACY_BODY_FIELDS.reduce((sum, [, , n]) => sum + n, 0)
    const total = bytes(body)
    expect(valuesOnly).toBeLessThan(20_000) // the values alone are just under the limit ...
    expect(total).toBeGreaterThan(20_000) // ... the key names and separators push it over
    expect(total).toBeGreaterThan(20_400)
    expect(isJsonWithinLimit(body)).toBe(false) // the exact validator the route uses: default 20 000 bytes
  })

  it('the limit is measured in UTF-8 bytes, not characters (multi-byte Hungarian letters count double)', () => {
    const body = legacyBody()
    const text = JSON.stringify(body)
    expect(encoder.encode(text).length).toBeGreaterThan(text.length)
  })

  it('the factBlockRef string (present in the real request) can only add to this lower bound', () => {
    const withFactBlock = { ...legacyBody(), verified_fact_block: stringOfJsonBytes(2000) }
    expect(bytes(withFactBlock)).toBeGreaterThan(bytes(legacyBody()))
    expect(isJsonWithinLimit(withFactBlock)).toBe(false)
  })

  it('the new body is {paid_result_id} only and is tiny', () => {
    const body = buildSaveVideoPackageBody(PAID_RESULT_ID)
    expect(Object.keys(body)).toEqual(['paid_result_id'])
    expect(bytes(body)).toBeLessThan(100)
    expect(isJsonWithinLimit(body)).toBe(true)
  })
})

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
}

function urls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map(([url]) => String(url))
}

describe('createVideoPackageSaver', () => {
  const input = { paidResultId: PAID_RESULT_ID, topic: 'Egy téma', searchKeyword: 'kulcsszó' }

  it('success: ONE POST /api/video-packages with only paid_result_id, THEN the Memory link with the new package id', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { id: 'pkg-1' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }))
    const outcome = await createVideoPackageSaver(fetchMock as unknown as typeof fetch).save(input)

    expect(outcome).toEqual({ status: 'saved', id: 'pkg-1', alreadySaved: false, memoryLinked: true })
    expect(urls(fetchMock)).toEqual([VIDEO_PACKAGES_ENDPOINT, MEMORY_ENDPOINT])
    const [, firstInit] = fetchMock.mock.calls[0]
    expect(firstInit.method).toBe('POST')
    expect(JSON.parse(firstInit.body)).toEqual({ paid_result_id: PAID_RESULT_ID })
    const [, secondInit] = fetchMock.mock.calls[1]
    expect(JSON.parse(secondInit.body)).toEqual(buildLinkPackageToMemoryBody({ topic: 'Egy téma', searchKeyword: 'kulcsszó', videoPackageId: 'pkg-1' }))
    expect(JSON.parse(secondInit.body)).toEqual({ topic: 'Egy téma', search_keyword: 'kulcsszó', state: 'in_progress', video_package_id: 'pkg-1' })
  })

  it.each([400, 401, 404, 422])('HTTP %i (a pre-INSERT status): error outcome, retrySafe=true, saved is NOT reported, no Memory link, exactly one request', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(status, { error: 'RAW SERVER TEXT MUST NOT BE SHOWN' }))
    const outcome = await createVideoPackageSaver(fetchMock as unknown as typeof fetch).save(input)

    expect(outcome.status).toBe('error')
    if (outcome.status === 'error') {
      expect(outcome.httpStatus).toBe(status)
      expect(outcome.retrySafe).toBe(true) // the route returns these only BEFORE the video_packages insert
      expect(outcome.message).toBe(mapSaveVideoPackageError(status))
      expect(outcome.message).not.toContain('RAW SERVER TEXT')
    }
    expect(urls(fetchMock)).toEqual([VIDEO_PACKAGES_ENDPOINT])
  })

  // Review-lelet: az 500/503 (és minden más, nem pozitívan felsorolt) válasz az INSERT után is keletkezhet
  // (a route workflow-hibaágai az insert után 500-at adnak, a kompenzáló DELETE eredményét nem ellenőrzik).
  it.each([500, 502, 503, 504, 429, 409, 413, 418, 599])('HTTP %i (may be post-INSERT): error outcome, retrySafe=false, uncertain message, no Memory link, one request', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(status, { error: 'RAW SERVER TEXT MUST NOT BE SHOWN' }))
    const outcome = await createVideoPackageSaver(fetchMock as unknown as typeof fetch).save(input)

    expect(outcome.status).toBe('error')
    if (outcome.status === 'error') {
      expect(outcome.httpStatus).toBe(status)
      expect(outcome.retrySafe).toBe(false)
      expect(outcome.message).toBe(mapSaveVideoPackageError(status))
      expect(outcome.message).toContain('bizonytalan')
      expect(outcome.message).not.toContain('RAW SERVER TEXT')
    }
    expect(urls(fetchMock)).toEqual([VIDEO_PACKAGES_ENDPOINT])
  })

  it('the pre-write allow-list is closed and explicit: only 400 / 401 / 404 / 422', () => {
    expect([...PRE_WRITE_HTTP_STATUSES]).toEqual([400, 401, 404, 422])
    for (const status of [400, 401, 404, 422]) expect(isDefinitelyNotWritten(status)).toBe(true)
    for (const status of [200, 201, 204, 301, 403, 409, 413, 429, 500, 502, 503, 504, null]) expect(isDefinitelyNotWritten(status)).toBe(false)
  })

  it.each([500, 503])('after an uncertain HTTP %i the saver sends NO further request for that paid result, even on an explicit second save() call', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(status, { error: 'x' }))
    const saver = createVideoPackageSaver(fetchMock as unknown as typeof fetch)
    const first = await saver.save(input)
    const second = await saver.save(input)
    const third = await saver.save(input)
    expect(first).toMatchObject({ status: 'error', retrySafe: false, httpStatus: status })
    expect(second).toEqual(first)
    expect(third).toEqual(first)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('after an uncertain network failure the saver also sends no further request', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network down'))
    const saver = createVideoPackageSaver(fetchMock as unknown as typeof fetch)
    await saver.save(input)
    const again = await saver.save(input)
    expect(again).toMatchObject({ status: 'error', httpStatus: null, retrySafe: false })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('the uncertain block is per paid result: another paid result can still be saved', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(500, { error: 'x' }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'pkg-2' })).mockResolvedValueOnce(jsonResponse(200, {}))
    const saver = createVideoPackageSaver(fetchMock as unknown as typeof fetch)
    await saver.save(input)
    const other = await saver.save({ ...input, paidResultId: '7a1c2d3e-4b5f-4a6b-8c7d-9e0f1a2b3c4d' })
    expect(other).toMatchObject({ status: 'saved', id: 'pkg-2' })
  })

  it('network failure: error with retrySafe=false (the request may have reached the server), no Memory link, one request', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network down'))
    const outcome = await createVideoPackageSaver(fetchMock as unknown as typeof fetch).save(input)
    expect(outcome).toMatchObject({ status: 'error', httpStatus: null, retrySafe: false })
    expect(urls(fetchMock)).toEqual([VIDEO_PACKAGES_ENDPOINT])
  })

  it.each([
    ['not JSON', () => new Response('<html>', { status: 200 })],
    ['no id', () => jsonResponse(200, { ok: true })],
    ['empty id', () => jsonResponse(200, { id: '' })],
    ['non-string id', () => jsonResponse(200, { id: 7 })],
  ])('2xx but %s: uncertain outcome -> error, retrySafe=false, no Memory link', async (_name, make) => {
    const fetchMock = vi.fn().mockResolvedValue(make())
    const outcome = await createVideoPackageSaver(fetchMock as unknown as typeof fetch).save(input)
    expect(outcome).toMatchObject({ status: 'error', retrySafe: false })
    expect(urls(fetchMock)).toEqual([VIDEO_PACKAGES_ENDPOINT])
  })

  it('a failing Memory link does not undo the saved package: saved, memoryLinked=false', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { id: 'pkg-1' }))
      .mockResolvedValueOnce(jsonResponse(500, { error: 'x' }))
    const outcome = await createVideoPackageSaver(fetchMock as unknown as typeof fetch).save(input)
    expect(outcome).toEqual({ status: 'saved', id: 'pkg-1', alreadySaved: false, memoryLinked: false })
  })

  it('double-save guard: two parallel saves of the same paid result produce ONE package request (and one Memory link)', async () => {
    let release: (r: Response) => void = () => {}
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }))
    const saver = createVideoPackageSaver(fetchMock as unknown as typeof fetch)

    const first = saver.save(input)
    const second = saver.save(input) // e.g. a click while the automatic save is still running
    release(jsonResponse(200, { id: 'pkg-1' }))
    const [a, b] = await Promise.all([first, second])

    expect(a).toEqual(b)
    expect(a).toMatchObject({ status: 'saved', id: 'pkg-1' })
    expect(urls(fetchMock)).toEqual([VIDEO_PACKAGES_ENDPOINT, MEMORY_ENDPOINT])
  })

  it('double-save guard: an already saved paid result sends NO new request (alreadySaved=true)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { id: 'pkg-1' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }))
    const saver = createVideoPackageSaver(fetchMock as unknown as typeof fetch)
    await saver.save(input)
    const again = await saver.save(input)
    expect(again).toEqual({ status: 'saved', id: 'pkg-1', alreadySaved: true, memoryLinked: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('a different paid result is a different save (the guard is per paid_result_id)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { id: 'pkg-1' })).mockResolvedValueOnce(jsonResponse(200, {}))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'pkg-2' })).mockResolvedValueOnce(jsonResponse(200, {}))
    const saver = createVideoPackageSaver(fetchMock as unknown as typeof fetch)
    const a = await saver.save(input)
    const b = await saver.save({ ...input, paidResultId: '7a1c2d3e-4b5f-4a6b-8c7d-9e0f1a2b3c4d' })
    expect(a).toMatchObject({ id: 'pkg-1' })
    expect(b).toMatchObject({ id: 'pkg-2' })
  })

  it('NO blind retry: after a definite pre-write failure no further request is sent on its own; only an explicit new save() call makes one', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(400, { error: 'x' }))
      const saver = createVideoPackageSaver(fetchMock as unknown as typeof fetch)
      await saver.save(input)
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(fetchMock).toHaveBeenCalledTimes(1) // nothing was scheduled

      fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'pkg-1' })).mockResolvedValueOnce(jsonResponse(200, {}))
      const manual = await saver.save(input) // the explicit click
      expect(manual).toMatchObject({ status: 'saved', id: 'pkg-1', alreadySaved: false })
      expect(fetchMock).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('an empty paid_result_id is rejected locally: no request at all', async () => {
    const fetchMock = vi.fn()
    const outcome = await createVideoPackageSaver(fetchMock as unknown as typeof fetch).save({ ...input, paidResultId: '' })
    expect(outcome.status).toBe('error')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('it never touches the generation / credit endpoints: only /api/video-packages and /api/memory, in the success path and in every failure path', async () => {
    for (const make of [
      () => vi.fn().mockResolvedValueOnce(jsonResponse(200, { id: 'p' })).mockResolvedValueOnce(jsonResponse(200, {})),
      () => vi.fn().mockResolvedValue(jsonResponse(400, {})),
      () => vi.fn().mockRejectedValue(new Error('x')),
    ]) {
      const fetchMock = make()
      await createVideoPackageSaver(fetchMock as unknown as typeof fetch).save(input)
      for (const url of urls(fetchMock)) expect([VIDEO_PACKAGES_ENDPOINT, MEMORY_ENDPOINT]).toContain(url)
    }
  })
})

describe('mapSaveVideoPackageError', () => {
  it('is a closed message set, never the server text', () => {
    expect(mapSaveVideoPackageError(401)).toBe('A mentéshez be kell jelentkezned.')
    expect(mapSaveVideoPackageError(404)).toBe('A fizetett eredmény nem található.')
    expect(mapSaveVideoPackageError(400)).toBe('A csomag ebben a formában nem menthető.')
    expect(mapSaveVideoPackageError(500)).toBe(UNCERTAIN_SAVE_MESSAGE)
    expect(mapSaveVideoPackageError(500)).toContain('bizonytalan')
    expect(mapSaveVideoPackageError(500)).toContain('Ne mentsd újra')
    expect(mapSaveVideoPackageError(null)).toBe(mapSaveVideoPackageError(503))
  })

  it('the uncertain text never claims "not saved" and does not name the Tartalommemória as an archive check', () => {
    const text = mapSaveVideoPackageError(500)
    expect(text).not.toMatch(/nem sikerült|nem történt meg|nem jött létre/i)
    expect(text).not.toMatch(/memória|memory/i)
  })
})

describe('verified archive row (never inferred from a reopened paid result)', () => {
  const PKG = '9d8c7b6a-5e4f-4a3b-8c2d-1e0f9a8b7c6d'

  it('readArchiveRef: the stored reference is used only for the SAME paid result', () => {
    const raw = mergeArchiveRef(null, PAID_RESULT_ID, PKG)
    expect(readArchiveRef(raw, PAID_RESULT_ID)).toBe(PKG)
    expect(readArchiveRef(raw, '7a1c2d3e-4b5f-4a6b-8c7d-9e0f1a2b3c4d')).toBeNull()
    expect(readArchiveRef(raw, undefined)).toBeNull()
    expect(readArchiveRef(null, PAID_RESULT_ID)).toBeNull()
    expect(readArchiveRef('{not json', PAID_RESULT_ID)).toBeNull()
    expect(readArchiveRef(JSON.stringify({ refs: { [PAID_RESULT_ID]: 5 } }), PAID_RESULT_ID)).toBeNull()
    expect(readArchiveRef(JSON.stringify({ paidResultId: PAID_RESULT_ID, packageId: PKG }), PAID_RESULT_ID)).toBeNull() // the old single-entry shape is not trusted
  })

  it('mergeArchiveRef keeps several paid results side by side (a late save of an older result cannot clobber a newer one)', () => {
    const other = '7a1c2d3e-4b5f-4a6b-8c7d-9e0f1a2b3c4d'
    let raw = mergeArchiveRef(null, PAID_RESULT_ID, 'pkg-A')
    raw = mergeArchiveRef(raw, other, 'pkg-B')
    raw = mergeArchiveRef(raw, PAID_RESULT_ID, 'pkg-A2') // same paid result written again: replaced, not duplicated
    expect(readArchiveRef(raw, PAID_RESULT_ID)).toBe('pkg-A2')
    expect(readArchiveRef(raw, other)).toBe('pkg-B')
  })

  it('mergeArchiveRef is bounded: only the most recent 20 references are kept', () => {
    let raw: string | null = null
    for (let i = 0; i < 25; i++) raw = mergeArchiveRef(raw, 'paid-' + i, 'pkg-' + i)
    expect(readArchiveRef(raw, 'paid-0')).toBeNull()
    expect(readArchiveRef(raw, 'paid-4')).toBeNull()
    expect(readArchiveRef(raw, 'paid-5')).toBe('pkg-5')
    expect(readArchiveRef(raw, 'paid-24')).toBe('pkg-24')
  })

  it('verifyArchivedPackage: ONLY a 200 whose package id matches proves the row; it is one read-only GET', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { package: { id: PKG } }))
    expect(await verifyArchivedPackage(PKG, fetchMock as unknown as typeof fetch)).toBe('present')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe(`${VIDEO_PACKAGES_ENDPOINT}?id=${PKG}`)
    expect(init).toBeUndefined() // a plain GET: no body, no method override
  })

  it.each([
    ['404 -> absent', () => jsonResponse(404, { error: 'x' }), 'absent'],
    ['500 -> unknown', () => jsonResponse(500, { error: 'x' }), 'unknown'],
    ['200 with another id -> unknown', () => jsonResponse(200, { package: { id: 'other' } }), 'unknown'],
    ['200 without package -> unknown', () => jsonResponse(200, {}), 'unknown'],
    ['200 not JSON -> unknown', () => new Response('<html>', { status: 200 }), 'unknown'],
  ])('verifyArchivedPackage %s', async (_name, make, expected) => {
    const fetchMock = vi.fn().mockResolvedValue(make())
    expect(await verifyArchivedPackage(PKG, fetchMock as unknown as typeof fetch)).toBe(expected)
  })

  it('verifyArchivedPackage: a network failure is unknown, not present', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('offline'))
    expect(await verifyArchivedPackage(PKG, fetchMock as unknown as typeof fetch)).toBe('unknown')
  })
})

// ─── F1 / F4 (review): azonnali rögzítés, lógó Memory-hívás, tartós "bizonytalan" jelölés ───────────────────
class MemStorage {
  data = new Map<string, string>()
  getItem(key: string) { return this.data.has(key) ? this.data.get(key)! : null }
  setItem(key: string, value: string) { this.data.set(key, value) }
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))

function hangingMemoryFetch() {
  return vi.fn((url: string, init?: RequestInit) => {
    if (url === VIDEO_PACKAGES_ENDPOINT) return Promise.resolve(jsonResponse(200, { id: 'pkg-1' }))
    return new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))) })
  })
}

describe('createVideoPackageSaver — the archive id is reported immediately, independent of the Memory call', () => {
  const input = { paidResultId: PAID_RESULT_ID, topic: 'Egy téma', searchKeyword: null }

  it('onArchived fires with the package id BEFORE the Memory request is even sent', async () => {
    const order: string[] = []
    const fetchMock = vi.fn(async (url: string) => {
      order.push(String(url))
      return url === VIDEO_PACKAGES_ENDPOINT ? jsonResponse(200, { id: 'pkg-1' }) : jsonResponse(200, {})
    })
    const saver = createVideoPackageSaver(fetchMock as unknown as typeof fetch)
    await saver.save(input, { onArchived: id => order.push('archived:' + id) })
    expect(order).toEqual([VIDEO_PACKAGES_ENDPOINT, 'archived:pkg-1', MEMORY_ENDPOINT])
  })

  it('a HANGING Memory call does not delay the archived state; save() resolves after the timeout with memoryLinked=false', async () => {
    vi.useFakeTimers()
    try {
      const archived: string[] = []
      const saver = createVideoPackageSaver(hangingMemoryFetch() as unknown as typeof fetch)
      let settled = false
      const pending = saver.save(input, { onArchived: id => archived.push(id) }).then(outcome => { settled = true; return outcome })

      await vi.advanceTimersByTimeAsync(10) // the archive POST resolved, the Memory call is hanging
      expect(archived).toEqual(['pkg-1']) // recorded immediately
      expect(settled).toBe(false) // the full outcome waits for the Memory step ...
      await vi.advanceTimersByTimeAsync(MEMORY_LINK_TIMEOUT_MS) // ... but only up to the timeout
      expect(await pending).toEqual({ status: 'saved', id: 'pkg-1', alreadySaved: false, memoryLinked: false })
    } finally {
      vi.useRealTimers()
    }
  })

  it('while the Memory call is hanging a second save() shares the running attempt: no second archive POST', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = hangingMemoryFetch()
      const saver = createVideoPackageSaver(fetchMock as unknown as typeof fetch)
      const first = saver.save(input)
      await vi.advanceTimersByTimeAsync(10)
      const second = saver.save(input)
      await vi.advanceTimersByTimeAsync(MEMORY_LINK_TIMEOUT_MS)
      expect(await first).toEqual(await second)
      expect(fetchMock.mock.calls.filter(([url]) => url === VIDEO_PACKAGES_ENDPOINT)).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a throwing onArchived hook cannot break the save', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, { id: 'pkg-1' })).mockResolvedValueOnce(jsonResponse(200, {}))
    const saver = createVideoPackageSaver(fetchMock as unknown as typeof fetch)
    const outcome = await saver.save(input, { onArchived: () => { throw new Error('boom') } })
    expect(outcome).toMatchObject({ status: 'saved', id: 'pkg-1' })
  })
})

describe('createVideoPackageSaver — more uncertain outcomes also block a second save()', () => {
  const input = { paidResultId: PAID_RESULT_ID, topic: 'Egy téma', searchKeyword: null }

  it.each([
    ['unreadable 2xx body', () => new Response('<html>', { status: 200 })],
    ['2xx without id', () => jsonResponse(200, { ok: true })],
    ['408 request timeout', () => jsonResponse(408, {})],
    ['413 payload too large (e.g. from a proxy)', () => jsonResponse(413, {})],
    ['504 gateway timeout', () => jsonResponse(504, {})],
  ])('%s -> uncertain, and a second save() sends nothing', async (_name, make) => {
    const fetchMock = vi.fn().mockResolvedValue(make())
    const saver = createVideoPackageSaver(fetchMock as unknown as typeof fetch)
    const first = await saver.save(input)
    const second = await saver.save(input)
    expect(first).toMatchObject({ status: 'error', retrySafe: false })
    expect(second).toEqual(first)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('an aborted fetch (AbortError) is uncertain, not "not saved"', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError'))
    const saver = createVideoPackageSaver(fetchMock as unknown as typeof fetch)
    expect(await saver.save(input)).toMatchObject({ status: 'error', httpStatus: null, retrySafe: false })
  })

  it('a parallel second call during an uncertain first attempt shares its (uncertain) outcome without a second request', async () => {
    let release: (r: Response) => void = () => {}
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve }))
    const saver = createVideoPackageSaver(fetchMock as unknown as typeof fetch)
    const first = saver.save(input)
    const second = saver.save(input)
    release(jsonResponse(500, { error: 'x' }))
    expect(await first).toEqual(await second)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('persistent "uncertain" marker (localStorage-style): fail-closed after a page reload — client-side only', () => {
  const input = { paidResultId: PAID_RESULT_ID, topic: 'Egy téma', searchKeyword: null }
  const storeOver = (storage: MemStorage) => createStorageUncertainStore(() => storage)

  it('the id is marked BEFORE the request is sent (a request cut off by navigation stays marked)', async () => {
    const storage = new MemStorage()
    let markedWhileInFlight = false
    const fetchMock = vi.fn(() => {
      markedWhileInFlight = JSON.parse(storage.getItem(UNCERTAIN_IDS_STORAGE_KEY) || '[]').includes(PAID_RESULT_ID)
      return new Promise<Response>(() => {}) // never resolves: the page "goes away"
    })
    const saver = createVideoPackageSaver(fetchMock as unknown as typeof fetch, { uncertain: storeOver(storage) })
    void saver.save(input)
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(markedWhileInFlight).toBe(true)
    expect(JSON.parse(storage.getItem(UNCERTAIN_IDS_STORAGE_KEY)!)).toEqual([PAID_RESULT_ID])
  })

  it.each([
    ['HTTP 500', () => Promise.resolve(jsonResponse(500, {}))],
    ['a network failure', () => Promise.reject(new TypeError('offline'))],
    ['an unreadable 2xx', () => Promise.resolve(new Response('<html>', { status: 200 }))],
  ])('after %s a NEW saver instance on the same storage (= reload) sends no request for that paid result', async (_name, outcome) => {
    const storage = new MemStorage()
    const first = createVideoPackageSaver(vi.fn(outcome) as unknown as typeof fetch, { uncertain: storeOver(storage) })
    await first.save(input)

    const secondFetch = vi.fn()
    const second = createVideoPackageSaver(secondFetch as unknown as typeof fetch, { uncertain: storeOver(storage) })
    expect(second.isUncertain(PAID_RESULT_ID)).toBe(true)
    const result = await second.save(input)
    expect(result).toMatchObject({ status: 'error', httpStatus: null, retrySafe: false, message: UNCERTAIN_SAVE_MESSAGE })
    expect(secondFetch).not.toHaveBeenCalled()
  })

  it('a request that never answered (page closed mid-flight) also blocks the next instance', async () => {
    const storage = new MemStorage()
    const first = createVideoPackageSaver((() => new Promise<Response>(() => {})) as unknown as typeof fetch, { uncertain: storeOver(storage) })
    void first.save(input)
    await flush()
    const secondFetch = vi.fn()
    const second = createVideoPackageSaver(secondFetch as unknown as typeof fetch, { uncertain: storeOver(storage) })
    expect(await second.save(input)).toMatchObject({ status: 'error', retrySafe: false })
    expect(secondFetch).not.toHaveBeenCalled()
  })

  it('a definite pre-INSERT failure (400) clears the marker, so the explicit retry in the same page is possible', async () => {
    const storage = new MemStorage()
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(400, {})).mockResolvedValueOnce(jsonResponse(200, { id: 'pkg-1' })).mockResolvedValueOnce(jsonResponse(200, {}))
    const saver = createVideoPackageSaver(fetchMock as unknown as typeof fetch, { uncertain: storeOver(storage) })
    expect(await saver.save(input)).toMatchObject({ status: 'error', retrySafe: true })
    expect(saver.isUncertain(PAID_RESULT_ID)).toBe(false)
    expect(await saver.save(input)).toMatchObject({ status: 'saved', id: 'pkg-1' })
  })

  it('another paid result is not affected by the marker', async () => {
    const storage = new MemStorage()
    await createVideoPackageSaver(vi.fn().mockResolvedValue(jsonResponse(500, {})) as unknown as typeof fetch, { uncertain: storeOver(storage) }).save(input)
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, { id: 'pkg-2' })).mockResolvedValueOnce(jsonResponse(200, {}))
    const fresh = createVideoPackageSaver(fetchMock as unknown as typeof fetch, { uncertain: storeOver(storage) })
    expect(await fresh.save({ ...input, paidResultId: '7a1c2d3e-4b5f-4a6b-8c7d-9e0f1a2b3c4d' })).toMatchObject({ status: 'saved', id: 'pkg-2' })
  })

  it('an unavailable store (null / throwing storage) degrades to the in-page guard only and never throws', async () => {
    const throwing = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
    for (const getStorage of [() => null, () => throwing]) {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(500, {}))
      const saver = createVideoPackageSaver(fetchMock as unknown as typeof fetch, { uncertain: createStorageUncertainStore(getStorage) })
      expect(await saver.save(input)).toMatchObject({ status: 'error', retrySafe: false })
      expect(await saver.save(input)).toMatchObject({ status: 'error', retrySafe: false }) // the in-page guard still holds
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  })

  it('isUncertain is false for a confirmed save even though the persistent marker is kept', async () => {
    const storage = new MemStorage()
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, { id: 'pkg-1' })).mockResolvedValueOnce(jsonResponse(200, {}))
    const saver = createVideoPackageSaver(fetchMock as unknown as typeof fetch, { uncertain: storeOver(storage) })
    await saver.save(input)
    expect(saver.isUncertain(PAID_RESULT_ID)).toBe(false)
    expect(JSON.parse(storage.getItem(UNCERTAIN_IDS_STORAGE_KEY)!)).toContain(PAID_RESULT_ID)
  })
})
