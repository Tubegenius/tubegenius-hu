// A /api/video-package TÉNYLEGES POST kezelőjének műveleti sorrendje a kreditkapu szempontjából.
// DB-/szolgáltató-mentes: minden I/O határ (Supabase, kreditek, paid-results, request-lock, a két AI-hívás) mockolt;
// nincs valódi adatbázis, nincs Anthropic-hívás, nincs levonás. Mintája: tests/video-package-route-time-budget.test.ts.
//
// Bizonyítandó (a mockok által látható műveletsorrendben):
//   * a már kifizetett, azonos bemenetű eredmény (cache-találat) díjmentesen megnyílik akkor is, ha a kredit-ellenőrzés
//     elutasítaná (kevés egyenleg, napi lágy limit): a kredit-ellenőrzés meg sem hívódik;
//   * cache-hiány + kevés egyenleg: 402, a kredit-ellenőrzés UTÁN azonnal, AI-hívás, usage-napló, levonás és mentés nélkül;
//   * cache-olvasási hiba: 503, kredit-ellenőrzés / AI / levonás nélkül;
//   * a request-lock minden ágon felszabadul.
// NEM bizonyít: valódi DB-t, a levonás atomicitását (azt a 093-as tesztek fedik), élő AI-t, a lock tényleges tárolását.
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const order: string[] = []

const m = vi.hoisted(() => ({
  getUserId: vi.fn(),
  checkPaidFeatureAccess: vi.fn(),
  logUsage: vi.fn(),
  getPaidResultByHashStrict: vi.fn(),
  getPaidResultById: vi.fn(),
  openPaidResult: vi.fn(),
  chargeFeatureAndSavePaidResult: vi.fn(),
  acquireRequestLock: vi.fn(),
  releaseRequestLock: vi.fn(),
  generateCreativeCore: vi.fn(),
  generatePackaging: vi.fn(),
  dailySoftLimitError: vi.fn(),
}))

vi.mock('@/lib/credits', () => ({
  getUserId: m.getUserId,
  checkPaidFeatureAccess: m.checkPaidFeatureAccess,
  logUsage: m.logUsage,
  CREDIT_COSTS: { video_package_shorts: 2, video_package_long: 6 },
  estimateCost: vi.fn(() => 0),
}))
vi.mock('@/lib/daily-soft-limit', () => ({ dailySoftLimitError: m.dailySoftLimitError }))
vi.mock('@/lib/paid-results/paid-results-service', () => ({
  buildPaidResultHash: vi.fn(() => 'hash-fixed'),
  normalizePaidResultInput: vi.fn((x: unknown) => x),
  getPaidResultByHashStrict: m.getPaidResultByHashStrict,
  getPaidResultById: m.getPaidResultById,
  openPaidResult: m.openPaidResult,
  paidResultResponseMeta: vi.fn((record: { id: string }) => ({ from_paid_result: true, paid_result_id: record.id })),
}))
vi.mock('@/lib/paid-results/atomic-charge-save', () => ({ chargeFeatureAndSavePaidResult: m.chargeFeatureAndSavePaidResult }))
vi.mock('@/lib/hungarian-output-polish', () => ({ polishHungarianOutput: vi.fn((x: unknown) => x) }))
vi.mock('@/lib/request-lock', () => ({
  acquireRequestLock: m.acquireRequestLock,
  releaseRequestLock: m.releaseRequestLock,
  REQUEST_IN_PROGRESS_ERROR: 'Már folyamatban van egy generálásod egy másik lapon vagy eszközön.',
}))
vi.mock('@/lib/supabase-server', () => ({ createAdminClient: vi.fn(() => { throw new Error('the DB must not be touched in this scenario') }) }))
vi.mock('@/lib/opportunity-evidence/evidence-service', () => ({ getOpportunityEvidenceSnapshot: vi.fn(), verifyOwnVideoIdea: vi.fn() }))
vi.mock('@/lib/creator-profile-context', () => ({ resolveCreatorNicheContext: vi.fn() }))
vi.mock('@/lib/video-package', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/video-package')>()
  return { ...actual, generateCreativeCore: m.generateCreativeCore, generatePackaging: m.generatePackaging }
})

import { POST } from '@/app/api/video-package/route'
import { insufficientCreditsNoCachedResultMessage } from '@/lib/video-package-credit-gate'

function buildRequest(platform = 'youtube') {
  return new NextRequest('http://localhost/api/video-package', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      topic: 'Node.js Async/Await',
      platform,
      video_length: platform === 'youtube_shorts' ? '60sec' : '6-10min',
      narration_style: 'storytelling',
      intensity: 'classic',
      goal: 'views',
      channel_context: 'tech csatorna',
    }),
  })
}

const PAID_RECORD = { id: 'paid-1', user_id: 'user-1', tool_type: 'video_package', result_json: { topic: 'Node.js Async/Await', hook: 'h', narration: 'n' } }
const INSUFFICIENT = { allowed: false, reason: 'insufficient_credits' }

function expectNoPaidSideEffects() {
  expect(m.generateCreativeCore).not.toHaveBeenCalled()
  expect(m.generatePackaging).not.toHaveBeenCalled()
  expect(m.logUsage).not.toHaveBeenCalled()
  expect(m.chargeFeatureAndSavePaidResult).not.toHaveBeenCalled()
}

beforeEach(() => {
  order.length = 0
  vi.clearAllMocks()
  m.getUserId.mockResolvedValue('user-1')
  m.checkPaidFeatureAccess.mockImplementation(async () => { order.push('access'); return { allowed: true } })
  m.acquireRequestLock.mockImplementation(async () => { order.push('lock'); return { acquired: true, lockId: 'lock-1' } })
  m.releaseRequestLock.mockImplementation(async () => { order.push('release') })
  m.getPaidResultByHashStrict.mockImplementation(async () => { order.push('cache'); return null })
  m.openPaidResult.mockImplementation(async (record: unknown) => { order.push('open'); return record })
  m.generateCreativeCore.mockImplementation(async () => { order.push('ai'); throw new Error('stop: a test must never reach a real provider') })
  m.dailySoftLimitError.mockReturnValue({ error: 'napi lágy limit' })
})

describe('cache hit: the already paid, identical-input result opens for free, whatever the balance says', () => {
  it('insufficient balance: 200 with the stored result, the credit check is NOT even called, nothing paid happens', async () => {
    m.getPaidResultByHashStrict.mockImplementation(async () => { order.push('cache'); return PAID_RECORD })
    m.checkPaidFeatureAccess.mockImplementation(async () => { order.push('access'); return INSUFFICIENT }) // would refuse — must never be asked
    const res = await POST(buildRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ topic: 'Node.js Async/Await', from_paid_result: true, paid_result_id: 'paid-1' })
    expect(m.checkPaidFeatureAccess).not.toHaveBeenCalled()
    expectNoPaidSideEffects()
    expect(order).toEqual(['lock', 'cache', 'open', 'release'])
  })

  it('daily soft limit exceeded: still a free 200 (no credit / soft-limit evaluation on a cache hit)', async () => {
    m.getPaidResultByHashStrict.mockImplementation(async () => { order.push('cache'); return PAID_RECORD })
    m.checkPaidFeatureAccess.mockResolvedValue({ allowed: false, reason: 'daily_soft_limit', dailyLimit: { limit: 1 } })
    const res = await POST(buildRequest())
    expect(res.status).toBe(200)
    expect(m.checkPaidFeatureAccess).not.toHaveBeenCalled()
    expectNoPaidSideEffects()
  })

  it('documented side effect: a cache hit touches paid_results.last_opened_at through openPaidResult (and takes / releases the request lock) — nothing else is written', async () => {
    m.getPaidResultByHashStrict.mockImplementation(async () => { order.push('cache'); return PAID_RECORD })
    await POST(buildRequest())
    expect(m.openPaidResult).toHaveBeenCalledTimes(1)
    expect(m.acquireRequestLock).toHaveBeenCalledTimes(1)
    expect(m.releaseRequestLock).toHaveBeenCalledTimes(1)
    expectNoPaidSideEffects()
  })
})

describe('cache miss + insufficient credits: refused BEFORE any AI call, usage log, charge or save', () => {
  it('402 with the server-controlled text, right after the credit check; the result is not opened, the lock is released', async () => {
    m.checkPaidFeatureAccess.mockImplementation(async () => { order.push('access'); return INSUFFICIENT })
    const res = await POST(buildRequest())
    expect(res.status).toBe(402)
    const body = await res.json()
    expect(body.error).toBe(insufficientCreditsNoCachedResultMessage(6))
    expect(body.error).toContain('6 kredit szükséges')
    expect(body.error).toContain('még nincs kifizetett eredményed')
    expect(m.openPaidResult).not.toHaveBeenCalled()
    expectNoPaidSideEffects()
    expect(order).toEqual(['lock', 'cache', 'access', 'release'])
  })

  it('shorts: the refusal names the shorts price (2 credits)', async () => {
    m.checkPaidFeatureAccess.mockImplementation(async () => { order.push('access'); return INSUFFICIENT })
    const res = await POST(buildRequest('youtube_shorts'))
    expect(res.status).toBe(402)
    expect((await res.json()).error).toBe(insufficientCreditsNoCachedResultMessage(2))
  })

  it('cache miss + daily soft limit: 429 before any AI call or charge', async () => {
    m.checkPaidFeatureAccess.mockResolvedValue({ allowed: false, reason: 'daily_soft_limit', dailyLimit: { limit: 1 } })
    const res = await POST(buildRequest())
    expect(res.status).toBe(429)
    expectNoPaidSideEffects()
  })

  it('cache READ failure: 503 — no credit check, no AI, no charge (a failed read is never treated as "no cached result")', async () => {
    m.getPaidResultByHashStrict.mockImplementation(async () => { order.push('cache'); throw new Error('db read failed') })
    const res = await POST(buildRequest())
    expect(res.status).toBe(503)
    expect(m.checkPaidFeatureAccess).not.toHaveBeenCalled()
    expectNoPaidSideEffects()
    expect(order).toEqual(['lock', 'cache', 'release'])
  })
})

describe('positive control: with enough credit and no cached result the handler really does reach the AI step (so the "not called" assertions above can fail)', () => {
  it('cache miss + allowed -> credit check first, then the (mocked) AI call; still no charge in this stubbed run', async () => {
    const res = await POST(buildRequest())
    expect(res.status).toBeGreaterThanOrEqual(400) // the stubbed AI call throws on purpose
    expect(m.generateCreativeCore).toHaveBeenCalledTimes(1)
    expect(m.chargeFeatureAndSavePaidResult).not.toHaveBeenCalled()
    expect(order.slice(0, 4)).toEqual(['lock', 'cache', 'access', 'ai'])
  })
})

describe('static guard of the invariant in the route source', () => {
  const src = readFileSync(path.resolve(__dirname, '..', 'app', 'api', 'video-package', 'route.ts'), 'utf8').replace(/\r\n/g, '\n')
  const post = src.slice(src.indexOf('export async function POST'), src.indexOf('export async function GET'))

  it('lock -> cache lookup -> cache-hit return -> credit check -> AI -> charge, in this order', () => {
    const at = (needle: string) => { const i = post.indexOf(needle); expect(i, needle).toBeGreaterThan(0); return i }
    expect(at('await acquireRequestLock(')).toBeLessThan(at('await getPaidResultByHashStrict('))
    expect(at('await getPaidResultByHashStrict(')).toBeLessThan(at('if (paid) {'))
    expect(at('if (paid) {')).toBeLessThan(at('await checkPaidFeatureAccess('))
    expect(at('await checkPaidFeatureAccess(')).toBeLessThan(at('await generateCreativeCore('))
    expect(at('await generateCreativeCore(')).toBeLessThan(at('await chargeFeatureAndSavePaidResult('))
  })

  it('the 402 text comes from the shared gate module, not a hand-written string', () => {
    expect(src).toContain("from '@/lib/video-package-credit-gate'")
    expect(post).toContain('insufficientCreditsNoCachedResultMessage(CREDIT_COSTS[feature])')
    expect(post).not.toContain('Nincs elég kredited. Ehhez')
  })
})
