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
  PRE_WRITE_HTTP_STATUSES,
  VIDEO_PACKAGES_ENDPOINT,
  buildLinkPackageToMemoryBody,
  buildSaveVideoPackageBody,
  createVideoPackageSaver,
  isDefinitelyNotWritten,
  mapSaveVideoPackageError,
  readArchiveRef,
  serializeArchiveRef,
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
    expect(mapSaveVideoPackageError(500)).toContain('bizonytalan')
    expect(mapSaveVideoPackageError(500)).toContain('Ne mentsd újra')
    expect(mapSaveVideoPackageError(null)).toBe(mapSaveVideoPackageError(503))
  })
})

describe('verified archive row (never inferred from a reopened paid result)', () => {
  const PKG = '9d8c7b6a-5e4f-4a3b-8c2d-1e0f9a8b7c6d'

  it('readArchiveRef: the stored reference is used only for the SAME paid result', () => {
    const raw = serializeArchiveRef(PAID_RESULT_ID, PKG)
    expect(readArchiveRef(raw, PAID_RESULT_ID)).toBe(PKG)
    expect(readArchiveRef(raw, '7a1c2d3e-4b5f-4a6b-8c7d-9e0f1a2b3c4d')).toBeNull()
    expect(readArchiveRef(raw, undefined)).toBeNull()
    expect(readArchiveRef(null, PAID_RESULT_ID)).toBeNull()
    expect(readArchiveRef('{not json', PAID_RESULT_ID)).toBeNull()
    expect(readArchiveRef(JSON.stringify({ paidResultId: PAID_RESULT_ID }), PAID_RESULT_ID)).toBeNull()
    expect(readArchiveRef(JSON.stringify({ paidResultId: PAID_RESULT_ID, packageId: 5 }), PAID_RESULT_ID)).toBeNull()
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
