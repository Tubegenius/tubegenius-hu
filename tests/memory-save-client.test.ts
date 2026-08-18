// PFM Creator Lane Architecture v0 — "Mentés a memóriába" biztonságos UI-
// útvonal. A lib/creator-lane/memory-save-client.ts az Opportunities oldal
// TopicCard.handleSave()-jének (app/dashboard/opportunities/page.tsx)
// kiszervezett, tisztán tesztelhető POST-rétege — a lib/dashboard/
// manual-refresh-credit.ts már bevált mintáját követve (injektálható
// fetchImpl, valódi Response objektumok, hívásszám/URL-bizonyítás).
//
// A komponens saját re-entrancy őre és a mount-effektből való hívás hiánya
// statikus forrás-ellenőrzéssel bizonyított a tests/opportunity-client-
// static-checks.test.ts fájlban lévő mintát követve — ld. a lenti
// "TopicCard.handleSave() wiring" describe blokkot ugyanebben a fájlban.
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  buildSaveTopicToMemoryBody,
  mapSaveTopicToMemoryError,
  saveTopicToMemory,
  fetchSavedStatusForTopics,
} from '@/lib/creator-lane/memory-save-client'
import { SAVED_LOOKUP_MAX_TOPICS, SAVED_LOOKUP_MAX_TOPIC_LENGTH } from '@/lib/creator-lane/topic-identity'

function nonMemoryCallCount(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter(([url]) => !String(url).includes('/api/memory')).length
}

// Csak a tényleges kódsorokat adja vissza — a dokumentáló megjegyzések
// szándékosan említhetik a függvényneveket, ez nem szabad, hogy egy naiv
// hívásszám-ellenőrzést tévesen elbuktasson (ld. tests/opportunity-client-
// static-checks.test.ts azonos mintája).
function stripComments(block: string): string {
  return block.split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
}

describe('buildSaveTopicToMemoryBody', () => {
  it('never includes a content_lane key — the current S2/067-expand contract only ever targets the pending/NULL lane on this surface', () => {
    const body = buildSaveTopicToMemoryBody({ topic: 'x', searchKeyword: 'y', opportunityScore: 80, platform: 'youtube' })
    expect(Object.keys(body)).not.toContain('content_lane')
  })

  it('produces exactly the fields the POST /api/memory contract (app/api/memory/route.ts) reads', () => {
    const body = buildSaveTopicToMemoryBody({ topic: 'Egy valódi téma', searchKeyword: 'kulcsszó', opportunityScore: 72, platform: 'youtube_shorts' })
    expect(body).toEqual({
      topic: 'Egy valódi téma',
      search_keyword: 'kulcsszó',
      state: 'saved',
      opportunity_score: 72,
      platform: 'youtube_shorts',
    })
  })

  it('omits optional fields cleanly (undefined, not null) when not provided — matches the unknown-lane / no-extra-metadata case', () => {
    const body = buildSaveTopicToMemoryBody({ topic: 'Csak cím' })
    expect(body.topic).toBe('Csak cím')
    expect(body.state).toBe('saved')
    expect(body.search_keyword).toBeUndefined()
    expect(body.opportunity_score).toBeUndefined()
    expect(body.platform).toBeUndefined()
  })

  it('normalizes (trims) the topic using the SAME shared identity function as the client-side saved-state comparisons', () => {
    const body = buildSaveTopicToMemoryBody({ topic: '  Egy téma  ' })
    expect(body.topic).toBe('Egy téma')
  })
})

describe('mapSaveTopicToMemoryError', () => {
  it('401 -> login-specific Hungarian message', () => {
    expect(mapSaveTopicToMemoryError(401)).toBe('A mentéshez be kell jelentkezned.')
  })

  it('400 -> validation-specific Hungarian message', () => {
    expect(mapSaveTopicToMemoryError(400)).toBe('Ez a téma nem menthető el ebben a formában.')
  })

  it('500 -> generic retry message', () => {
    expect(mapSaveTopicToMemoryError(500)).toBe('A mentés sikertelen. Próbáld újra.')
  })

  it('409 (hypothetical lane_conflict_pending_contract) -> falls back to the generic message, never echoes the raw error code or a constraint name', () => {
    const msg = mapSaveTopicToMemoryError(409)
    expect(msg).toBe('A mentés sikertelen. Próbáld újra.')
    expect(msg.toLowerCase()).not.toContain('lane_conflict')
    expect(msg.toLowerCase()).not.toContain('constraint')
    expect(msg.toLowerCase()).not.toContain('23505')
    expect(msg.toLowerCase()).not.toContain('42p10')
  })

  it('every mapped message is a fixed, closed set — never derived from server-supplied text', () => {
    const allowed = new Set([
      'A mentéshez be kell jelentkezned.',
      'Ez a téma nem menthető el ebben a formában.',
      'A mentés sikertelen. Próbáld újra.',
    ])
    for (const status of [400, 401, 403, 404, 409, 422, 429, 500, 502, 503]) {
      expect(allowed.has(mapSaveTopicToMemoryError(status))).toBe(true)
    }
  })
})

describe('saveTopicToMemory', () => {
  const input = { topic: 'Valódi mentendő téma', searchKeyword: 'kw', opportunityScore: 65, platform: 'youtube' }

  it('success: exactly one POST /api/memory call, correct URL/method, returns status:"saved" with the server row', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ item: { id: 'mem-1', topic: input.topic } }), { status: 200 }))
    const result = await saveTopicToMemory(input, fetchMock as unknown as typeof fetch)

    expect(result).toEqual({ status: 'saved', row: { id: 'mem-1', topic: input.topic } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/memory')
    expect(options.method).toBe('POST')
    expect(JSON.parse(options.body as string)).toEqual({
      topic: input.topic, search_keyword: 'kw', state: 'saved', opportunity_score: 65, platform: 'youtube',
    })
    expect(nonMemoryCallCount(fetchMock)).toBe(0)
  })

  it('junk-topic server skip ({skipped:true}, 200): returns status:"skipped", not an error and not "saved"', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ skipped: true }), { status: 200 }))
    const result = await saveTopicToMemory(input, fetchMock as unknown as typeof fetch)
    expect(result).toEqual({ status: 'skipped' })
  })

  it('malformed 200 body (no item, no skipped): treated as an error, not silently reported as saved', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
    const result = await saveTopicToMemory(input, fetchMock as unknown as typeof fetch)
    expect(result.status).toBe('error')
  })

  it('non-ok response (500, generic server message): returns the fixed generic message, never the raw server text', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'A mentés sikertelen. Próbáld újra.' }), { status: 500 }))
    const result = await saveTopicToMemory(input, fetchMock as unknown as typeof fetch)
    expect(result).toEqual({ status: 'error', message: 'A mentés sikertelen. Próbáld újra.' })
  })

  it('non-ok response (409, hypothetical raw lane_conflict_pending_contract body): the raw error string never reaches the returned message', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'lane_conflict_pending_contract' }), { status: 409 }))
    const result = await saveTopicToMemory(input, fetchMock as unknown as typeof fetch)
    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(result.message).not.toContain('lane_conflict_pending_contract')
    }
  })

  it('non-ok response (401): login-specific message', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'Nem vagy bejelentkezve' }), { status: 401 }))
    const result = await saveTopicToMemory(input, fetchMock as unknown as typeof fetch)
    expect(result).toEqual({ status: 'error', message: 'A mentéshez be kell jelentkezned.' })
  })

  it('network error (fetch throws): returns a connection-error message, still exactly one call attempt', async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    const result = await saveTopicToMemory(input, fetchMock as unknown as typeof fetch)
    expect(result).toEqual({ status: 'error', message: 'Kapcsolati hiba — próbáld újra.' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('JSON parse failure on an ok response: returns an error result instead of throwing', async () => {
    const fetchMock = vi.fn(async () => new Response('not json', { status: 200 }))
    const result = await saveTopicToMemory(input, fetchMock as unknown as typeof fetch)
    expect(result.status).toBe('error')
  })

  it('never calls any endpoint other than /api/memory — no /api/opportunity, /api/credit-check, /api/video-audit, or provider route', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ item: { id: 'mem-2' } }), { status: 200 }))
    await saveTopicToMemory(input, fetchMock as unknown as typeof fetch)
    expect(nonMemoryCallCount(fetchMock)).toBe(0)
  })

  it('the request body never contains force_refresh or a content_lane value', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ item: { id: 'mem-3' } }), { status: 200 }))
    await saveTopicToMemory(input, fetchMock as unknown as typeof fetch)
    const bodyStr = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string
    expect(bodyStr).not.toContain('force_refresh')
    expect(bodyStr).not.toContain('content_lane')
  })
})

describe('fetchSavedStatusForTopics — bounded, visible-topic-scoped batch lookup', () => {
  it('success: exactly one POST to /api/memory/saved-lookup, deduped+trimmed topics in the body, returns the saved-topic Set', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ topics: ['A'] }), { status: 200 }))
    const result = await fetchSavedStatusForTopics(['  A  ', 'A', 'B'], fetchMock as unknown as typeof fetch)

    expect(result).toEqual({ ok: true, topics: new Set(['A']) })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/memory/saved-lookup')
    expect(options.method).toBe('POST')
    expect(JSON.parse(options.body as string)).toEqual({ topics: ['A', 'B'] })
    expect(nonMemoryCallCount(fetchMock)).toBe(0)
  })

  it('empty input list: returns ok:true with an empty Set WITHOUT making any fetch call', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ topics: [] }), { status: 200 }))
    const result = await fetchSavedStatusForTopics([], fetchMock as unknown as typeof fetch)
    expect(result).toEqual({ ok: true, topics: new Set() })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('all-whitespace-only input list: returns ok:true with an empty Set, no fetch call', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ topics: [] }), { status: 200 }))
    const result = await fetchSavedStatusForTopics(['   ', '\t'], fetchMock as unknown as typeof fetch)
    expect(result).toEqual({ ok: true, topics: new Set() })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it(`FAIL-CLOSED (not a silent partial lookup): more than SAVED_LOOKUP_MAX_TOPICS (${SAVED_LOOKUP_MAX_TOPICS}) distinct visible topics -> ok:false, ZERO fetch calls, never a truncated first-${SAVED_LOOKUP_MAX_TOPICS} answer`, async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ topics: [] }), { status: 200 }))
    const tooMany = Array.from({ length: SAVED_LOOKUP_MAX_TOPICS + 1 }, (_, i) => `topic-${i}`)
    const result = await fetchSavedStatusForTopics(tooMany, fetchMock as unknown as typeof fetch)

    expect(result).toEqual({ ok: false, topics: new Set() })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('exactly SAVED_LOOKUP_MAX_TOPICS distinct topics (the boundary) still succeeds normally — only count STRICTLY GREATER than the cap fails closed', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ topics: [] }), { status: 200 }))
    const exactlyMax = Array.from({ length: SAVED_LOOKUP_MAX_TOPICS }, (_, i) => `topic-${i}`)
    const result = await fetchSavedStatusForTopics(exactlyMax, fetchMock as unknown as typeof fetch)

    expect(result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('duplicate topics that dedupe down to <= the cap still succeed, even if the RAW input list is larger than the cap', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ topics: [] }), { status: 200 }))
    const rawWithDupes = Array.from({ length: SAVED_LOOKUP_MAX_TOPICS + 40 }, () => 'Ugyanaz a téma')
    const result = await fetchSavedStatusForTopics(rawWithDupes, fetchMock as unknown as typeof fetch)

    expect(result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const sentBody = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(sentBody.topics).toEqual(['Ugyanaz a téma'])
  })

  it(`drops any single topic longer than SAVED_LOOKUP_MAX_TOPIC_LENGTH (${SAVED_LOOKUP_MAX_TOPIC_LENGTH}) before sending`, async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ topics: [] }), { status: 200 }))
    const tooLong = 'x'.repeat(SAVED_LOOKUP_MAX_TOPIC_LENGTH + 1)
    await fetchSavedStatusForTopics([tooLong, 'A short one'], fetchMock as unknown as typeof fetch)
    const sentBody = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(sentBody.topics).toEqual(['A short one'])
  })

  it('never falls back to a "give me your recent N saved topics" GET — scoping is always by the exact visible-topic list, correct at 200+ total saved records', async () => {
    // Simulates: the user has 300 total saved records; the ONE topic we ask
    // about happens to be the very oldest (would NOT appear in a
    // recency-limited "last 200" query). Because this function always sends
    // the exact topic and the server matches by IN(...), it must still work.
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ topics: ['Legrégebbi mentett téma'] }), { status: 200 }))
    const result = await fetchSavedStatusForTopics(['Legrégebbi mentett téma'], fetchMock as unknown as typeof fetch)
    expect(result.topics.has('Legrégebbi mentett téma')).toBe(true)
  })

  it('never sends a GET — this is always a POST, and never touches /api/memory (the enrichment/write route) directly', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ topics: [] }), { status: 200 }))
    await fetchSavedStatusForTopics(['A'], fetchMock as unknown as typeof fetch)
    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(options.method).toBe('POST')
    expect(url).not.toBe('/api/memory')
  })

  it('non-string returned topic values are dropped defensively, never crash', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ topics: ['A', null, 42, {}] }), { status: 200 }))
    const result = await fetchSavedStatusForTopics(['A'], fetchMock as unknown as typeof fetch)
    expect(result.ok).toBe(true)
    expect(result.topics).toEqual(new Set(['A']))
  })

  it('DEFENSE-IN-DEPTH: response topic strings are re-normalized (trimmed) client-side too, even though the server already normalizes — never trusts the server\'s output shape blindly', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ topics: ['  Téma A  ', '', '   '] }), { status: 200 }))
    const result = await fetchSavedStatusForTopics(['Téma A'], fetchMock as unknown as typeof fetch)
    expect(result.ok).toBe(true)
    // whitespace-only/empty-after-trim entries are dropped; the real one is trimmed
    expect(result.topics).toEqual(new Set(['Téma A']))
  })

  it('non-ok response: fail-closed to ok:false with an empty Set, never throws, never shows a false "already saved"', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'A mentett állapot ellenőrzése sikertelen. Próbáld újra.' }), { status: 500 }))
    const result = await fetchSavedStatusForTopics(['A'], fetchMock as unknown as typeof fetch)
    expect(result).toEqual({ ok: false, topics: new Set() })
  })

  it('malformed body (no topics array): fail-closed to ok:false, empty Set', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
    const result = await fetchSavedStatusForTopics(['A'], fetchMock as unknown as typeof fetch)
    expect(result).toEqual({ ok: false, topics: new Set() })
  })

  it('network error (fetch throws): fail-closed to ok:false, empty Set, no exception escapes', async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    const result = await fetchSavedStatusForTopics(['A'], fetchMock as unknown as typeof fetch)
    expect(result).toEqual({ ok: false, topics: new Set() })
  })

  it('JSON parse failure: fail-closed to ok:false, empty Set', async () => {
    const fetchMock = vi.fn(async () => new Response('not json', { status: 200 }))
    const result = await fetchSavedStatusForTopics(['A'], fetchMock as unknown as typeof fetch)
    expect(result).toEqual({ ok: false, topics: new Set() })
  })
})

// ------------------------------------------------------------------
// TopicCard.handleSave() wiring — statikus forrás-ellenőrzés, ugyanazzal a
// (jsdom/RTL nélküli) korláttal és indoklással, mint a
// tests/opportunity-client-static-checks.test.ts fájl összes describe blokkja:
// ez a repo Vitest-konfigurációja (vitest.config.ts) environment:'node' és
// csak tests/**/*.test.ts fájlokat futtat, package.json/package-lock.json
// módosítása pedig ebben a körben kifejezetten tilos — ezért valódi
// React-render helyett forrásszöveg-alapú, szerkezeti bizonyítékot adunk a
// re-entrancy védelemre és arra, hogy a mentés kizárólag explicit
// kattintásból érhető el.
// ------------------------------------------------------------------
describe('opportunities/page.tsx — TopicCard "Mentés a memóriába" wiring', () => {
  const src = readFileSync(join(process.cwd(), 'app', 'dashboard', 'opportunities', 'page.tsx'), 'utf-8').replace(/\r\n/g, '\n')

  it('imports the tested saveTopicToMemory + fetchSavedStatusForTopics helpers, and normalizeTopicKey, instead of inline fetch calls or ad-hoc identity handling', () => {
    expect(src).toMatch(/import\s*\{\s*saveTopicToMemory,\s*fetchSavedStatusForTopics\s*\}\s*from\s*'@\/lib\/creator-lane\/memory-save-client'/)
    expect(src).toMatch(/import\s*\{\s*normalizeTopicKey\s*\}\s*from\s*'@\/lib\/creator-lane\/topic-identity'/)
  })

  function handleSaveBody(): string {
    const idx = src.indexOf('async function handleSave()')
    expect(idx).toBeGreaterThan(-1)
    const endIdx = src.indexOf('\n\n  async function submitReject', idx)
    expect(endIdx).toBeGreaterThan(idx)
    return src.slice(idx, endIdx)
  }

  it('handleSave() captures the topic identity via normalizeTopicKey(displayTitle) as its very first statement, before any guard or await', () => {
    const body = handleSaveBody()
    const captureIdx = body.indexOf('const topicKey = normalizeTopicKey(displayTitle)')
    const guardIdx = body.indexOf('saveInFlightKeysRef.current.has(topicKey)')
    expect(captureIdx).toBeGreaterThan(-1)
    expect(guardIdx).toBeGreaterThan(captureIdx)
  })

  it('handleSave() refuses to run while the parent save-gate is not ready (loading/error) — never POSTs during an unresolved or failed already-saved lookup', () => {
    const body = handleSaveBody()
    expect(body).toMatch(/if\s*\(!saveGateReady\s*\|\|/)
  })

  it('handleSave() guards re-entrancy PER TOPIC IDENTITY (Set.has(topicKey)), not a single card-wide boolean — a title change must not block saving the new topic', () => {
    const body = handleSaveBody()
    expect(body).toMatch(/saveInFlightKeysRef\.current\.has\(topicKey\)\s*\|\|\s*alreadySavedTopics\.has\(topicKey\)/)
  })

  it('handleSave() adds topicKey to the in-flight Set synchronously before the first await', () => {
    const body = handleSaveBody()
    const guardIdx = body.indexOf('saveInFlightKeysRef.current.has(topicKey)')
    const addIdx = body.indexOf('saveInFlightKeysRef.current.add(topicKey)')
    const firstAwaitIdx = body.indexOf('await ')
    expect(addIdx).toBeGreaterThan(guardIdx)
    expect(addIdx).toBeLessThan(firstAwaitIdx)
  })

  it('handleSave() always removes topicKey from the in-flight Set in a finally block (never stays locked after success, skip, or error)', () => {
    const body = handleSaveBody()
    expect(body).toMatch(/finally\s*\{[^}]*saveInFlightKeysRef\.current\.delete\(topicKey\)/)
  })

  it('handleSave() calls saveTopicToMemory exactly once, with the captured (normalized) topicKey — not the possibly-since-changed raw displayTitle', () => {
    const body = handleSaveBody()
    expect(body.match(/saveTopicToMemory\(/g)?.length).toBe(1)
    const callIdx = body.indexOf('saveTopicToMemory({')
    const block = body.slice(callIdx, callIdx + 150)
    expect(block).toContain('topic: topicKey')
  })

  it('handleSave() never references /api/opportunity, force_refresh, or /api/credit-check', () => {
    const body = handleSaveBody()
    expect(body).not.toContain('/api/opportunity')
    expect(body).not.toContain('force_refresh')
    expect(body).not.toContain('/api/credit-check')
  })

  it('the error branch sets a topicKey-scoped error and returns without calling onTopicSaved', () => {
    const body = handleSaveBody()
    const errIdx = body.indexOf("result.status === 'error'")
    expect(errIdx).toBeGreaterThan(-1)
    const block = body.slice(errIdx, errIdx + 150)
    expect(block).toContain('setSaveError({ topicKey, message: result.message })')
    expect(block).toContain('return')
    expect(block).not.toContain('onTopicSaved')
  })

  it('the skipped branch sets a fixed, topicKey-scoped message, returns without calling onTopicSaved, and never echoes server text', () => {
    const body = handleSaveBody()
    const skipIdx = body.indexOf("result.status === 'skipped'")
    expect(skipIdx).toBeGreaterThan(-1)
    const nextBranchIdx = body.indexOf('onTopicSaved(topicKey)', skipIdx)
    expect(nextBranchIdx).toBeGreaterThan(skipIdx)
    const block = body.slice(skipIdx, nextBranchIdx)
    expect(block).toContain("setSaveError({ topicKey, message: 'Ez a téma nem menthető el ebben a formában.' })")
    expect(block).toContain('return')
  })

  it('onTopicSaved(topicKey) — the ONLY thing that marks a topic saved — is called exactly once and only after both the error and skipped branches have already returned', () => {
    const body = handleSaveBody()
    expect(body.match(/onTopicSaved\(/g)?.length).toBe(1)
    const errIdx = body.indexOf("result.status === 'error'")
    const skipIdx = body.indexOf("result.status === 'skipped'")
    const onSavedIdx = body.indexOf('onTopicSaved(topicKey)')
    expect(onSavedIdx).toBeGreaterThan(errIdx)
    expect(onSavedIdx).toBeGreaterThan(skipIdx)
  })

  it('the /api/feedback POST is issued strictly AFTER onTopicSaved(topicKey) — never on the skipped or error path', () => {
    const body = handleSaveBody()
    const onSavedIdx = body.indexOf('onTopicSaved(topicKey)')
    const feedbackIdx = body.indexOf("fetch('/api/feedback'", onSavedIdx)
    expect(onSavedIdx).toBeGreaterThan(-1)
    expect(feedbackIdx).toBeGreaterThan(onSavedIdx)
    // and there is only ONE /api/feedback call site in the whole function body
    expect(body.match(/'\/api\/feedback'/g)?.length).toBe(1)
  })

  it('handleSave is only ever invoked from the button onClick — never from the mount useEffect body', () => {
    const effectIdx = src.indexOf('useEffect(() => {\n    if (initRanRef.current) return')
    expect(effectIdx).toBeGreaterThan(-1)
    const effectEndIdx = src.indexOf('\n  }, [])', effectIdx)
    const effectBody = src.slice(effectIdx, effectEndIdx)
    expect(effectBody).not.toMatch(/handleSave\(/)
  })

  it('the Save button has type="button" (never submits an enclosing form), wires onClick={handleSave}, is disabled while saving/already-saved/gate-not-ready, and exposes an accessible label', () => {
    const btnIdx = src.indexOf('type="button" onClick={handleSave}')
    expect(btnIdx).toBeGreaterThan(-1)
    const block = src.slice(btnIdx, btnIdx + 400)
    expect(block).toContain('disabled={isSaved || isSavingCurrent || !saveGateReady}')
    expect(block).toContain("aria-label={isSaved ? 'Elmentve a memóriába' : 'Mentés a memóriába'}")
  })

  it('isSaved/isSavingCurrent/currentSaveError are all derived from normalizeTopicKey(displayTitle) (the CURRENT, normalized identity), not the raw title or a static per-card boolean', () => {
    expect(src).toContain('const currentTopicKey = normalizeTopicKey(displayTitle)')
    expect(src).toContain('const isSaved = alreadySavedTopics.has(currentTopicKey)')
    expect(src).toContain('const isSavingCurrent = savingTopicKey === currentTopicKey')
    expect(src).toMatch(/const currentSaveError = saveError && saveError\.topicKey === currentTopicKey \? saveError\.message : null/)
  })

  it('a saveError message renders near the Save button when set (scoped to the current topic)', () => {
    expect(src).toMatch(/\{currentSaveError\s*&&\s*\(/)
  })
})

describe('opportunities/page.tsx — bounded, visible-topic saved-lookup with loading/ready/error gate', () => {
  const src = readFileSync(join(process.cwd(), 'app', 'dashboard', 'opportunities', 'page.tsx'), 'utf-8').replace(/\r\n/g, '\n')

  it('imports fetchSavedStatusForTopics (not the old, removed identity_only GET helper)', () => {
    expect(src).toMatch(/import\s*\{\s*saveTopicToMemory,\s*fetchSavedStatusForTopics\s*\}\s*from\s*'@\/lib\/creator-lane\/memory-save-client'/)
    expect(src).not.toContain('fetchAlreadySavedTopics')
    expect(src).not.toContain('identity_only')
  })

  it('runSavedLookup scopes the query to VISIBLE, non-discovery-lane topics only — never the user\'s whole Memory history', () => {
    const fnIdx = src.indexOf('async function runSavedLookup(currentTopics: ExtendedTopic[])')
    expect(fnIdx).toBeGreaterThan(-1)
    const fnEndIdx = src.indexOf('\n\n  useEffect(() => {\n    runSavedLookup(topics)', fnIdx)
    expect(fnEndIdx).toBeGreaterThan(fnIdx)
    const fnBody = src.slice(fnIdx, fnEndIdx)
    expect(fnBody).toContain('.filter(t => !isDiscoveryLane(t))')
    expect(fnBody).toContain('normalizeTopicKey(t.title)')
  })

  it('the lookup re-runs whenever the visible `topics` list changes (effect dependency is [topics], not [])', () => {
    expect(src).toContain('useEffect(() => {\n    runSavedLookup(topics)')
    const idx = src.indexOf('useEffect(() => {\n    runSavedLookup(topics)')
    const block = src.slice(idx, idx + 200)
    expect(block).toMatch(/\}, \[topics\]\)/)
  })

  it('the race-safe request-ID coordination is delegated to the tested, React-free runSavedLookupCoordinated() — not reimplemented inline', () => {
    expect(src).toMatch(/import\s*\{\s*runSavedLookupCoordinated\s*\}\s*from\s*'@\/lib\/creator-lane\/saved-lookup-coordinator'/)
    const fnIdx = src.indexOf('async function runSavedLookup(currentTopics: ExtendedTopic[])')
    const fnEndIdx = src.indexOf('\n\n  useEffect(() => {\n    runSavedLookup(topics)', fnIdx)
    const fnBody = src.slice(fnIdx, fnEndIdx)
    expect(fnBody).toContain('runSavedLookupCoordinated(visibleKeys, savedLookupRequestIdRef, {')
    // the ref itself is passed directly as the tracker -- the component
    // never manually increments/compares a request-id inline anymore (that
    // logic, including the empty-list branch's invalidation, is proven by
    // tests/saved-lookup-coordinator.test.ts's deterministic deferred-
    // Promise race tests)
    expect(fnBody).not.toMatch(/\+\+savedLookupRequestIdRef\.current/)
  })

  it('the state machine is exactly loading/ready/error, defaults to loading, and the coordinator callbacks map 1:1 onto it (onError -> \'error\', never a silent empty-Set)', () => {
    expect(src).toContain("const [savedLookupState, setSavedLookupState] = useState<'loading' | 'ready' | 'error'>('loading')")
    const fnIdx = src.indexOf('async function runSavedLookup(currentTopics: ExtendedTopic[])')
    const fnEndIdx = src.indexOf('\n\n  useEffect(() => {\n    runSavedLookup(topics)', fnIdx)
    const fnBody = src.slice(fnIdx, fnEndIdx)
    expect(fnBody).toContain("onLoading: () => setSavedLookupState('loading')")
    expect(fnBody).toContain("onError: () => setSavedLookupState('error')")
    expect(fnBody).toMatch(/onReady:\s*newlySavedTopics\s*=>\s*\{\s*\n\s*setAlreadySavedTopics\(prev => new Set\(\[\.\.\.prev, \.\.\.newlySavedTopics\]\)\)\s*\n\s*setSavedLookupState\('ready'\)/)
  })

  it('retrySavedLookup re-invokes ONLY runSavedLookup (the read-only lookup) with the current topics — nothing else', () => {
    const fnIdx = src.indexOf('function retrySavedLookup()')
    expect(fnIdx).toBeGreaterThan(-1)
    const fnEndIdx = src.indexOf('\n  }', fnIdx)
    const fnBody = src.slice(fnIdx, fnEndIdx)
    expect(fnBody).toContain('runSavedLookup(topics)')
    expect(fnBody).not.toMatch(/saveTopicToMemory\(|fetch\(/)
  })

  it('TopicCard receives saveGateReady={savedLookupState === \'ready\'} alongside the shared alreadySavedTopics Set and markTopicSaved callback', () => {
    const renderIdx = src.indexOf('<TopicCard key={topic.id}')
    expect(renderIdx).toBeGreaterThan(-1)
    const block = src.slice(renderIdx, renderIdx + 500)
    expect(block).toContain('alreadySavedTopics={alreadySavedTopics}')
    expect(block).toContain('onTopicSaved={markTopicSaved}')
    expect(block).toContain("saveGateReady={savedLookupState === 'ready'}")
  })

  it('an error banner with a friendly message and a "Újrapróbálás" retry button renders when savedLookupState is \'error\'', () => {
    const idx = src.indexOf("{savedLookupState === 'error' && (")
    expect(idx).toBeGreaterThan(-1)
    const block = src.slice(idx, idx + 900)
    expect(block).toContain('onClick={retrySavedLookup}')
    expect(block).toContain('Újrapróbálás')
    expect(block).toContain('type="button"')
  })

  it('the lookup effect and retry never send force_refresh, never call /api/opportunity or /api/credit-check', () => {
    const fnIdx = src.indexOf('async function runSavedLookup(currentTopics: ExtendedTopic[])')
    const fnEndIdx = src.indexOf('\n\n  function retrySavedLookup()', fnIdx)
    const retryEndIdx = src.indexOf('\n  }', src.indexOf('function retrySavedLookup()'))
    const block = src.slice(fnIdx, retryEndIdx > fnEndIdx ? retryEndIdx : fnEndIdx)
    expect(block).not.toContain('force_refresh')
    expect(block).not.toContain('/api/opportunity')
    expect(block).not.toContain('/api/credit-check')
  })

  it('markTopicSaved only ever gets called from TopicCard.onTopicSaved, and is a writer of alreadySavedTopics alongside the lookup-result merge', () => {
    expect(src).toContain('function markTopicSaved(topicKey: string)')
    expect(stripComments(src).match(/setAlreadySavedTopics\(/g)?.length).toBe(2) // 1) lookup-result merge, 2) markTopicSaved
  })
})
