import { describe, expect, it, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// ── 1) Statikus import-audit — a capture modul forrasa maga nem
//    hivatkozhat semmilyen kulso-hivo modulra. Ez a forrasszoveget
//    olvassa, nem futtatja — tehat akkor is jelez, ha egy jovobeli
//    modositas csak KOZVETVE (pl. egy uj helper-fajlon keresztul) vezetne
//    be egy ilyen fuggoseget, feltéve hogy azt is capture.ts importalja.
describe('emerging-signal capture — static import audit (no external-call modules imported)', () => {
  // A bare-szo alapu jelolteket (nem `from '...'` import-sor) CSAK a
  // kommenteket kiszurve, TENYLEGES HIVAS-ALAKBAN (pl. `fetchExternal(`)
  // keressuk — igy a dokumentacios kommentek (amik EPP azt magyarazzak,
  // mi NINCS a modulban) nem adnak hamis pozitivot.
  const forbiddenImports = [
    "from '@/lib/external-fetch'",
    "from '@/lib/youtube-service'",
    "from '@/lib/services/ai-provider-service'",
    "from '@/lib/credits'",
  ]
  const forbiddenCalls = [/\bfetchExternal\s*\(/, /\bchargeProtectedFeature\s*\(/, /\bspend_credits\s*\(/, /\bcallAIProvider\s*\(/]

  function stripComments(src: string): string {
    return src
      .split('\n')
      .filter(line => !line.trim().startsWith('//'))
      .join('\n')
  }

  for (const file of ['types.ts', 'normalize.ts', 'fingerprint.ts', 'capture.ts']) {
    it(`lib/emerging-signal/${file} contains no forbidden external-call import or call`, () => {
      const rawSrc = readFileSync(join(process.cwd(), 'lib', 'emerging-signal', file), 'utf-8')
      const codeOnly = stripComments(rawSrc)

      for (const token of forbiddenImports) {
        expect(codeOnly).not.toContain(token)
      }
      for (const pattern of forbiddenCalls) {
        expect(pattern.test(codeOnly)).toBe(false)
      }

      // Az egyetlen megengedett trend-radar hivatkozas egy `import type` sor.
      const trendRadarLines = codeOnly.split('\n').filter(l => l.includes("from '@/lib/trend-radar'"))
      for (const line of trendRadarLines) {
        expect(line.trim().startsWith('import type')).toBe(true)
      }
    })
  }

  it('capture.ts does not import the global fetch/Request/Response primitives directly', () => {
    const src = readFileSync(join(process.cwd(), 'lib', 'emerging-signal', 'capture.ts'), 'utf-8')
    expect(src).not.toMatch(/\bfetch\s*\(/)
  })
})

// ── 2) Mockolt, futtatott bizonyitek — a teljes captureOpportunitySignals
//    lefutasa alatt a fetchExternal mock hivasszama NULLA marad.
vi.mock('@/lib/external-fetch', () => ({ fetchExternal: vi.fn() }))
vi.mock('@/lib/supabase-server', () => ({
  createAdminClient: vi.fn(),
}))

import { fetchExternal } from '@/lib/external-fetch'
import { createAdminClient } from '@/lib/supabase-server'

const mockedFetchExternal = vi.mocked(fetchExternal)
const mockedCreateAdminClient = vi.mocked(createAdminClient)

function buildStubAdminClient() {
  const chain: any = {
    insert: vi.fn(() => chain),
    upsert: vi.fn(() => chain),
    select: vi.fn(() => chain),
    update: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    neq: vi.fn(() => chain),
    in: vi.fn(() => Promise.resolve({ data: [], error: null })),
    // Az uj atomi run-claim (ensureRun) elso lepese egy plain INSERT ...
    // .select('id, started_at').single() — ennek is started_at-tal
    // rendelkezo sort kell visszaadnia, kulonben a bucketStart szamitasa
    // Invalid Date-be futna.
    single: vi.fn(() => Promise.resolve({ data: { id: 'stub-id-' + Math.random().toString(36).slice(2), started_at: new Date().toISOString() }, error: null })),
    maybeSingle: vi.fn(() => Promise.resolve({ data: { id: 'stub-run-id', status: 'started', started_at: new Date().toISOString() }, error: null })),
    then: (resolve: any) => resolve({ data: [], error: null }),
  }
  return { from: vi.fn(() => chain) }
}

describe('emerging-signal capture — zero external calls during a full run (mocked DB)', () => {
  beforeEach(() => {
    mockedFetchExternal.mockReset()
    mockedCreateAdminClient.mockReset()
    mockedCreateAdminClient.mockReturnValue(buildStubAdminClient() as any)
  })

  it('a full capture run over multiple candidates makes zero fetchExternal calls', async () => {
    const { captureOpportunitySignals } = await import('@/lib/emerging-signal/capture')
    await captureOpportunitySignals({
      requestId: 'req-zero-call-test',
      candidates: [
        {
          id: 'c1',
          candidate_topic: 'Topic A',
          candidate_topic_en: 'Topic A EN',
          category: 'tech_ai',
          region: 'HU',
          trend_source_type: 'serper_youtube',
          confidence: 'high',
          opportunity_type: 'strong_trend',
          serper_evidence_count: 1,
          youtube_relevant_videos_count: 1,
          unique_creator_count: 1,
          freshness_score: 80,
          pollution_score: 0,
          relevance_average: 80,
          source_videos: [{
            videoId: 'vid00000001', title: 'Video 1', channelTitle: 'Chan', channelId: 'UC1',
            publishedAt: '2026-08-01T00:00:00.000Z', viewCount: 10, likeCount: 1, commentCount: 0,
            thumbnailUrl: '', relevance_score: 80, region_relevance: 90, is_region_relevant: true,
            relevance_signals: [], market_label: 'hungarian_market',
          }],
          web_sources: [{ title: 'Article', link: 'https://example.test/a', snippet: 's' }],
          seed_keyword: 'seed a',
          market_type: 'hungarian_market',
        },
      ] as any,
    })

    expect(mockedFetchExternal).not.toHaveBeenCalled()
  })

  it('zero fetchExternal calls even when EVERY DB operation errors out (the writer never falls back to a network call on failure)', async () => {
    const alwaysErrorChain: any = {
      insert: vi.fn(() => alwaysErrorChain),
      upsert: vi.fn(() => alwaysErrorChain),
      update: vi.fn(() => alwaysErrorChain),
      select: vi.fn(() => alwaysErrorChain),
      eq: vi.fn(() => alwaysErrorChain),
      neq: vi.fn(() => alwaysErrorChain),
      in: vi.fn(() => Promise.resolve({ data: null, error: { code: 'XXERR', message: 'always fails' } })),
      single: vi.fn(() => Promise.resolve({ data: null, error: { code: 'XXERR', message: 'always fails' } })),
      maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: { code: 'XXERR', message: 'always fails' } })),
      then: (resolve: any) => resolve({ data: null, error: { code: 'XXERR', message: 'always fails' } }),
    }
    mockedCreateAdminClient.mockReturnValue({ from: vi.fn(() => alwaysErrorChain) } as any)

    const { captureOpportunitySignals } = await import('@/lib/emerging-signal/capture')
    const result = await captureOpportunitySignals({
      requestId: 'req-zero-call-all-fail',
      candidates: [{
        id: 'c1', candidate_topic: 'Topic A', candidate_topic_en: 'Topic A EN', category: 'tech_ai',
        region: 'HU', trend_source_type: 'serper_youtube', confidence: 'high', opportunity_type: 'strong_trend',
        serper_evidence_count: 1, youtube_relevant_videos_count: 1, unique_creator_count: 1,
        freshness_score: 80, pollution_score: 0, relevance_average: 80,
        source_videos: [{
          videoId: 'vid00000001', title: 'Video 1', channelTitle: 'Chan', channelId: 'UC1',
          publishedAt: '2026-08-01T00:00:00.000Z', viewCount: 10, likeCount: 1, commentCount: 0,
          thumbnailUrl: '', relevance_score: 80, region_relevance: 90, is_region_relevant: true,
          relevance_signals: [], market_label: 'hungarian_market',
        }],
        web_sources: [{ title: 'Article', link: 'https://example.test/a', snippet: 's' }],
        seed_keyword: 'seed a',
        market_type: 'hungarian_market',
      }] as any,
    })

    expect(result.outcome).toBe('failed')
    expect(mockedFetchExternal).not.toHaveBeenCalled()
  })
})
