import { beforeAll, describe, expect, it, vi } from 'vitest'

// lib/trend-radar.ts az ANTHROPIC_API_KEY-t modul-betoltodeskor, egyszer
// olvassa be egy const-ba — ezert a kornyezeti valtozot MAR az import elott
// be kell allitani, dinamikus import()-tal, nem statikus import-mal (ami
// hoisting miatt megelozne a process.env beallitasat).
vi.mock('@/lib/services/ai-provider-service', () => ({
  callAIProvider: vi.fn(),
  extractJson: vi.fn(),
}))

let rewriteTopicWithHaiku: typeof import('@/lib/trend-radar')['rewriteTopicWithHaiku']
let HAIKU_REWRITE_BUDGET: number
let createRequestBudgetContext: typeof import('@/lib/youtube-service')['createRequestBudgetContext']
let callAIProviderMock: ReturnType<typeof vi.fn>
let extractJsonMock: ReturnType<typeof vi.fn>

beforeAll(async () => {
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key'
  const trendRadar = await import('@/lib/trend-radar')
  const youtubeService = await import('@/lib/youtube-service')
  const aiProvider = await import('@/lib/services/ai-provider-service')
  rewriteTopicWithHaiku = trendRadar.rewriteTopicWithHaiku
  HAIKU_REWRITE_BUDGET = trendRadar.HAIKU_REWRITE_BUDGET
  createRequestBudgetContext = youtubeService.createRequestBudgetContext
  callAIProviderMock = aiProvider.callAIProvider as ReturnType<typeof vi.fn>
  extractJsonMock = aiProvider.extractJson as ReturnType<typeof vi.fn>
})

describe('Haiku rewrite budget — shared RequestBudgetContext across broad-discovery packs', () => {
  it('the budget is exactly 8 (unchanged threshold)', () => {
    expect(HAIKU_REWRITE_BUDGET).toBe(8)
  })

  it('five packs sharing one context together make at most 8 Haiku rewrite calls total, even under a fully concurrent burst', async () => {
    callAIProviderMock.mockReset()
    extractJsonMock.mockReset()
    callAIProviderMock.mockImplementation(async () => ({
      text: '{}',
      provider: 'anthropic',
      model: 'claude',
      usage: { inputTokens: 1, outputTokens: 1 },
      estimatedCost: 0,
      promptTemplateId: 'trend_radar_topic_rewrite',
      promptVersion: 'v1',
    }))
    extractJsonMock.mockImplementation(() => ({
      display_topic: 'Display',
      searchable_topic: 'search topic',
      youtube_validation_queries: ['search topic'],
    }))

    const shared = createRequestBudgetContext()
    // 5 "pack", pack-enkent 3 kulonbozo (cache-t elkerulo) cimmel — 15
    // kiserlet osszesen egyetlen kozos contexten, lapos Promise.all-lal.
    const allTitles = Array.from({ length: 5 }, (_, p) => [
      `Pack ${p} original headline one`,
      `Pack ${p} original headline two`,
      `Pack ${p} original headline three`,
    ]).flat()

    await Promise.all(allTitles.map(title =>
      rewriteTopicWithHaiku(title, 'snippet', 'category', 'focus', 'HU', 'hu', shared)
    ))

    expect(shared.haikuRewriteCount).toBe(8)
    expect(callAIProviderMock.mock.calls.length).toBe(8)
  })

  it('a fresh context (new user request) is not affected by another request having exhausted its own Haiku budget', async () => {
    callAIProviderMock.mockClear()
    extractJsonMock.mockImplementation(() => ({
      display_topic: 'Display',
      searchable_topic: 'other search topic',
      youtube_validation_queries: ['other search topic'],
    }))

    const exhausted = createRequestBudgetContext()
    exhausted.haikuRewriteCount = HAIKU_REWRITE_BUDGET

    const fresh = createRequestBudgetContext()
    const resultOnExhausted = await rewriteTopicWithHaiku('Unrelated headline A', '', '', '', 'HU', 'hu', exhausted)
    const resultOnFresh = await rewriteTopicWithHaiku('Unrelated headline B', '', '', '', 'HU', 'hu', fresh)

    expect(resultOnExhausted).toBeNull()
    expect(resultOnFresh).not.toBeNull()
    expect(fresh.haikuRewriteCount).toBe(1)
  })
})
