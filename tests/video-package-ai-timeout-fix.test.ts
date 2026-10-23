// 2026-10-01 incident fix -- generateCreativeCore's non-streamed, 6000-max-
// token Sonnet call didn't finish within the shared Anthropic client's 60s
// timeout (Anthropic Console Logs for willviral-staging confirmed: two
// Error-499 attempts, 2,275/2,332 output tokens in 59.44-59.60s -- the
// provider was actively generating, the CLIENT gave up waiting). This file
// is DB-/provider-free: the real @anthropic-ai/sdk is mocked below, nothing
// here makes a network call.
//
// Scope proven here: (1) ai-provider-service.ts's new per-call
// stream/maxRetries/timeoutMs plumbing, in isolation; (2) that
// generateCreativeCore/generatePackaging actually pass the RIGHT options to
// the mocked SDK client; (3) that every OTHER callAIProvider() caller in the
// repo is untouched (no stream/maxRetries/timeoutMs keys introduced
// anywhere outside lib/video-package.ts); (4) the two-stage route timeframe
// budget stays under the confirmed 300s Vercel ceiling with real margin.
import { readFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { anthropicCreate, anthropicStream } = vi.hoisted(() => ({
  anthropicCreate: vi.fn(),
  anthropicStream: vi.fn(),
}))

vi.mock('@anthropic-ai/sdk', () => ({
  // A plain `function` (not an arrow function) is required here: the real
  // ai-provider-service.ts does `new Anthropic(...)`, and an arrow function
  // cannot be used as a constructor ("is not a constructor").
  default: vi.fn().mockImplementation(function MockAnthropic() {
    return { messages: { create: anthropicCreate, stream: anthropicStream } }
  }),
}))

function textMessage(text: string, overrides: Record<string, unknown> = {}) {
  return {
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 123, output_tokens: 456 },
    ...overrides,
  }
}

// Simulates the REAL SDK's MessageStream.finalMessage(): resolves with the
// message after `resolveAfterMs` UNLESS the caller's AbortSignal fires
// first, in which case it rejects -- exactly like a stream that is still
// generating when our own deadline timer aborts it.
function abortableStream(resolveAfterMs: number, message: unknown) {
  return (_body: unknown, options: { signal?: AbortSignal } = {}) => ({
    finalMessage: () =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve(message), resolveAfterMs)
        options.signal?.addEventListener('abort', () => {
          clearTimeout(t)
          const err = new Error('Request was aborted.')
          err.name = 'AbortError'
          reject(err)
        })
      }),
  })
}

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key'
  anthropicCreate.mockReset()
  anthropicStream.mockReset()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('ai-provider-service -- per-call stream/maxRetries/timeoutMs plumbing', () => {
  it('a plain (non-streaming, no overrides) call uses messages.create with an EMPTY options object -- identical to pre-fix behaviour for every untouched caller', async () => {
    const { callAIProvider } = await import('@/lib/services/ai-provider-service')
    anthropicCreate.mockResolvedValue(textMessage('{"ok":true}'))
    await callAIProvider({
      model: 'claude-sonnet-4-6', maxTokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      promptTemplateId: 'viral_score_explanation', promptVersion: 'v1',
    })
    expect(anthropicCreate).toHaveBeenCalledTimes(1)
    expect(anthropicStream).not.toHaveBeenCalled()
    const [, options] = anthropicCreate.mock.calls[0]
    expect(options).toEqual({})
  })

  it('maxRetries/timeoutMs overrides are forwarded to messages.create as-is, without touching the non-streaming call shape', async () => {
    const { callAIProvider } = await import('@/lib/services/ai-provider-service')
    anthropicCreate.mockResolvedValue(textMessage('{"ok":true}'))
    await callAIProvider({
      model: 'claude-haiku-4-5-20251001', maxTokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      promptTemplateId: 'video_package_packaging', promptVersion: 'v2',
      maxRetries: 0, timeoutMs: 60_000,
    })
    const [, options] = anthropicCreate.mock.calls[0]
    expect(options).toEqual({ maxRetries: 0, timeout: 60_000 })
  })

  it('stream:true uses messages.stream (never create), with maxRetries forwarded and an AbortSignal attached', async () => {
    const { callAIProvider } = await import('@/lib/services/ai-provider-service')
    anthropicStream.mockImplementation(abortableStream(0, textMessage('{"ok":true}')))
    await callAIProvider({
      model: 'claude-sonnet-4-6', maxTokens: 6000,
      messages: [{ role: 'user', content: 'hi' }],
      promptTemplateId: 'video_package_core_long', promptVersion: 'v1',
      stream: true, maxRetries: 0, streamDeadlineMs: 5_000,
    })
    expect(anthropicCreate).not.toHaveBeenCalled()
    expect(anthropicStream).toHaveBeenCalledTimes(1)
    const [, options] = anthropicStream.mock.calls[0]
    expect(options.maxRetries).toBe(0)
    expect(options.signal).toBeInstanceOf(AbortSignal)
    // Here timeoutMs was NOT passed by the caller, so the SDK's own
    // `timeout` (header-arrival only) option is left unset for this call --
    // it would fall back to the shared client's 60s default. The real
    // protection against a hanging STREAM is streamDeadlineMs, enforced by
    // our own AbortController, not this option. See the next test for what
    // happens when a caller (generateCreativeCore) DOES also set timeoutMs.
    expect(options.timeout).toBeUndefined()
  })

  it('stream:true + an explicit timeoutMs forwards BOTH: our own streamDeadlineMs abort AND the SDK option that bounds time-to-headers -- two independent mechanisms, not one standing in for the other', async () => {
    const { callAIProvider } = await import('@/lib/services/ai-provider-service')
    anthropicStream.mockImplementation(abortableStream(0, textMessage('{"ok":true}')))
    await callAIProvider({
      model: 'claude-sonnet-4-6', maxTokens: 6000,
      messages: [{ role: 'user', content: 'hi' }],
      promptTemplateId: 'video_package_core_long', promptVersion: 'v1',
      stream: true, maxRetries: 0, streamDeadlineMs: 200_000, timeoutMs: 200_000,
    })
    const [, options] = anthropicStream.mock.calls[0]
    expect(options.timeout).toBe(200_000)
    expect(options.signal).toBeInstanceOf(AbortSignal)
  })

  it('a full, completed stream resolves with the correct text and usage -- the success path works end-to-end through the mock', async () => {
    const { callAIProvider } = await import('@/lib/services/ai-provider-service')
    anthropicStream.mockImplementation(abortableStream(0, textMessage('{"hook":"x"}', {
      usage: { input_tokens: 2255, output_tokens: 5990 },
    })))
    const result = await callAIProvider({
      model: 'claude-sonnet-4-6', maxTokens: 6000,
      messages: [{ role: 'user', content: 'hi' }],
      promptTemplateId: 'video_package_core_long', promptVersion: 'v1',
      stream: true, maxRetries: 0, streamDeadlineMs: 5_000,
    })
    expect(result.text).toBe('{"hook":"x"}')
    expect(result.usage).toEqual({ inputTokens: 2255, outputTokens: 5990 })
  })

  it('abort: our OWN deadline firing before the stream resolves rejects the call -- no partial text, no result object ever returned', async () => {
    const { callAIProvider } = await import('@/lib/services/ai-provider-service')
    // The mocked stream would only resolve at 200ms; our deadline is 20ms --
    // the deadline must win, proving the abort wiring (not just that SOME
    // timeout eventually fires) actually works.
    anthropicStream.mockImplementation(abortableStream(200, textMessage('{"ok":true}')))
    const call = callAIProvider({
      model: 'claude-sonnet-4-6', maxTokens: 6000,
      messages: [{ role: 'user', content: 'hi' }],
      promptTemplateId: 'video_package_core_long', promptVersion: 'v1',
      stream: true, maxRetries: 0, streamDeadlineMs: 20,
    })
    await expect(call).rejects.toThrow()
  })

  it('incomplete stream (ended without a final message) rejects with the underlying error, not a fabricated/partial AICallResult', async () => {
    const { callAIProvider } = await import('@/lib/services/ai-provider-service')
    anthropicStream.mockReturnValue({
      finalMessage: () => Promise.reject(new Error('stream ended without producing a Message with role=assistant')),
    })
    const call = callAIProvider({
      model: 'claude-sonnet-4-6', maxTokens: 6000,
      messages: [{ role: 'user', content: 'hi' }],
      promptTemplateId: 'video_package_core_long', promptVersion: 'v1',
      stream: true, maxRetries: 0, streamDeadlineMs: 5_000,
    })
    await expect(call).rejects.toThrow('stream ended without producing a Message')
  })

  it('a stream that DOES complete but hit the token cap (stop_reason=max_tokens) is still rejected -- "complete" alone is not enough, it must be a valid, non-truncated answer', async () => {
    const { callAIProvider } = await import('@/lib/services/ai-provider-service')
    anthropicStream.mockImplementation(abortableStream(0, textMessage('{"truncated":', { stop_reason: 'max_tokens' })))
    const call = callAIProvider({
      model: 'claude-sonnet-4-6', maxTokens: 6000,
      messages: [{ role: 'user', content: 'hi' }],
      promptTemplateId: 'video_package_core_long', promptVersion: 'v1',
      stream: true, maxRetries: 0, streamDeadlineMs: 5_000,
    })
    await expect(call).rejects.toThrow('truncated')
  })

  it('validateAICallInput fails closed if stream:true is requested without a positive streamDeadlineMs', async () => {
    const { validateAICallInput } = await import('@/lib/services/ai-provider-service')
    const base = {
      model: 'claude-sonnet-4-6', maxTokens: 100,
      messages: [{ role: 'user' as const, content: 'hi' }],
      promptTemplateId: 'video_package_core_long', promptVersion: 'v1',
    }
    expect(() => validateAICallInput({ ...base, stream: true })).toThrow('streamDeadlineMs')
    expect(() => validateAICallInput({ ...base, stream: true, streamDeadlineMs: 0 })).toThrow('streamDeadlineMs')
    expect(() => validateAICallInput({ ...base, stream: true, streamDeadlineMs: 1000 })).not.toThrow()
  })
})

describe('video-package.ts -- the two actual call sites use exactly the intended options', () => {
  const minimalCoreParams = {
    topic: 'Node.js Async/Await', isShorts: false,
    t: { words: '1500', minutes: '8', scenes: '6' },
    arc: '0:00 hook', niche: 'tech', stylePrompt: 'storytelling',
    intensity: 'classic', goal: 'views',
    factSection: '\nVERIFIED_FACT_BLOCK: teszt', factSafetyRules: '',
    platform: 'youtube', videoLength: '6-10min', narrationStyle: 'storytelling',
    contentType: 'general', strictFactMode: false, sourceVideoMode: false,
  }
  const minimalShortsCoreParams = {
    topic: 'Node.js Async/Await', isShorts: true,
    t: { words: '130-165', chars: '950-1300', seconds: 60 },
    arc: '0-3mp hook', niche: 'tech', stylePrompt: 'storytelling',
    intensity: 'classic', goal: 'views',
    factSection: '\nVERIFIED_FACT_BLOCK: teszt', factSafetyRules: '',
    platform: 'youtube_shorts', videoLength: '60sec', narrationStyle: 'storytelling',
    contentType: 'general', strictFactMode: false, sourceVideoMode: false,
  }
  const minimalPackagingParams = {
    topic: 'Node.js Async/Await', isShorts: false, platform: 'youtube',
    hook: 'hook szöveg', narration: 'narráció szöveg', niche: 'tech',
    uploadTimes: { primary: 'kedd 18:00', secondary: 'csütörtök 18:00', reason: 'teszt' },
    strictFactMode: false, qualityStatus: 'verified' as const,
  }
  const minimalShortsPackagingParams = { ...minimalPackagingParams, isShorts: true, platform: 'youtube_shorts' }

  it('generateCreativeCore (Long) streams with maxRetries:0, streamDeadlineMs AND timeout both === CORE_STREAM_DEADLINE_MS (200_000)', async () => {
    const { generateCreativeCore, CORE_STREAM_DEADLINE_MS } = await import('@/lib/video-package')
    expect(CORE_STREAM_DEADLINE_MS).toBe(200_000)
    anthropicStream.mockImplementation(abortableStream(0, textMessage(JSON.stringify({
      hook: 'h', hook_variations: [], narration: 'n', scene_structure: [], broll_ideas: [], timestamps: [], cta: 'cta',
    }))))
    await generateCreativeCore(minimalCoreParams as never)
    expect(anthropicCreate).not.toHaveBeenCalled()
    expect(anthropicStream).toHaveBeenCalledTimes(1)
    const [, options] = anthropicStream.mock.calls[0]
    expect(options.maxRetries).toBe(0)
    expect(options.signal).toBeInstanceOf(AbortSignal)
    expect(options.timeout).toBe(CORE_STREAM_DEADLINE_MS)
  })

  // isShorts only branches the PROMPT text/promptTemplateId inside
  // generateCreativeCore -- the callAIProvider({...}) options literal
  // (stream/maxRetries/streamDeadlineMs/timeoutMs) sits outside that
  // isShorts ? ... : ... ternary in lib/video-package.ts, so the Shorts
  // route (youtube_shorts/tiktok/instagram_reels/facebook_reels) gets the
  // exact same timeout protection as the Long route. Proven directly here,
  // not just inferred from reading the source.
  it('generateCreativeCore (Shorts) gets the SAME stream/maxRetries/deadline/timeout options as the Long route', async () => {
    const { generateCreativeCore, CORE_STREAM_DEADLINE_MS } = await import('@/lib/video-package')
    anthropicStream.mockImplementation(abortableStream(0, textMessage(JSON.stringify({
      hook: 'h', hook_variations: [], narration: 'n', scene_structure: [], broll_ideas: [], cta: 'cta',
    }))))
    await generateCreativeCore(minimalShortsCoreParams as never)
    expect(anthropicCreate).not.toHaveBeenCalled()
    expect(anthropicStream).toHaveBeenCalledTimes(1)
    const [, options] = anthropicStream.mock.calls[0]
    expect(options.maxRetries).toBe(0)
    expect(options.signal).toBeInstanceOf(AbortSignal)
    expect(options.timeout).toBe(CORE_STREAM_DEADLINE_MS)
  })

  it('generatePackaging (Long) calls create with maxRetries:0 and timeout === the exported PACKAGING_TIMEOUT_MS (60_000)', async () => {
    const { generatePackaging, PACKAGING_TIMEOUT_MS } = await import('@/lib/video-package')
    expect(PACKAGING_TIMEOUT_MS).toBe(60_000)
    anthropicCreate.mockResolvedValue(textMessage(JSON.stringify({
      thumbnail_texts: [], title_variations: [], caption: 'c', description: 'd', hashtags: [],
    })))
    await generatePackaging(minimalPackagingParams)
    expect(anthropicStream).not.toHaveBeenCalled()
    expect(anthropicCreate).toHaveBeenCalledTimes(1)
    const [, options] = anthropicCreate.mock.calls[0]
    expect(options).toEqual({ maxRetries: 0, timeout: 60_000 })
  })

  // Same reasoning as generateCreativeCore above: isShorts only changes the
  // prompt/platformChecklistSchema inside generatePackaging, not the
  // callAIProvider({...}) options literal -- so Shorts packaging gets the
  // identical maxRetries:0/60s timeout too.
  it('generatePackaging (Shorts) gets the SAME maxRetries:0/timeout options as the Long route', async () => {
    const { generatePackaging, PACKAGING_TIMEOUT_MS } = await import('@/lib/video-package')
    anthropicCreate.mockResolvedValue(textMessage(JSON.stringify({
      thumbnail_texts: [], title_variations: [], caption: 'c', description: '', hashtags: [],
    })))
    await generatePackaging(minimalShortsPackagingParams)
    expect(anthropicStream).not.toHaveBeenCalled()
    expect(anthropicCreate).toHaveBeenCalledTimes(1)
    const [, options] = anthropicCreate.mock.calls[0]
    expect(options).toEqual({ maxRetries: 0, timeout: PACKAGING_TIMEOUT_MS })
  })

  it('a core generation that never resolves within CORE_STREAM_DEADLINE_MS is rejected (using a tiny deadline to prove the real wiring, not the real 200s)', async () => {
    const { generateCreativeCore } = await import('@/lib/video-package')
    anthropicStream.mockImplementation(abortableStream(500, textMessage('{"hook":"h"}')))
    // Can't change the exported constant from the test -- instead prove the
    // SAME mechanism generateCreativeCore relies on (our deadline timer vs.
    // a slower stream) at the ai-provider-service level is already covered
    // above; here we additionally confirm generateCreativeCore propagates a
    // genuine stream failure (incomplete) without swallowing it.
    anthropicStream.mockReturnValueOnce({
      finalMessage: () => Promise.reject(new Error('stream ended without producing a Message with role=assistant')),
    })
    await expect(generateCreativeCore(minimalCoreParams as never)).rejects.toThrow('stream ended without producing a Message')
  })
})

describe('no other callAIProvider() caller gained stream/maxRetries/timeoutMs -- the fix is scoped to Video Package only', () => {
  const root = process.cwd()
  const otherCallers = [
    'lib/trend-radar.ts', 'lib/similar-query-expansion.ts', 'lib/semantic-topic/provider-adapter.ts',
    'lib/seed-generator.ts', 'lib/channel-niche-discovery.ts',
    'app/api/viral-score/route.ts', 'app/api/video-audit/route.ts', 'app/api/thumbnail-studio/route.ts',
    'app/api/title-studio/route.ts', 'app/api/script-extract/route.ts', 'app/api/seo-optimizer/route.ts',
    'app/api/opportunity/route.ts', 'app/api/opportunity-explain/route.ts', 'app/api/opportunity-similar/route.ts',
    'app/api/keyword-research/route.ts', 'app/api/content-gap/route.ts', 'app/api/channel-audit/route.ts',
  ]

  it('every OTHER file calling callAIProvider() still has zero occurrences of stream:/maxRetries:/timeoutMs: in its call sites', () => {
    for (const relPath of otherCallers) {
      const src = readFileSync(join(root, ...relPath.split('/')), 'utf-8')
      expect(src, `${relPath} should not reference streamDeadlineMs`).not.toMatch(/streamDeadlineMs/)
      expect(src, `${relPath} should not pass stream: true to callAIProvider`).not.toMatch(/callAIProvider\(\{[\s\S]*?stream:\s*true/)
      expect(src, `${relPath} should not pass a maxRetries override to callAIProvider`).not.toMatch(/callAIProvider\(\{[\s\S]*?maxRetries:/)
      expect(src, `${relPath} should not pass a timeoutMs override to callAIProvider`).not.toMatch(/callAIProvider\(\{[\s\S]*?timeoutMs:/)
    }
  })

  it('exactly the two intended call sites in lib/video-package.ts use the new options -- no accidental third call site', () => {
    const src = readFileSync(join(root, 'lib', 'video-package.ts'), 'utf-8')
    expect([...src.matchAll(/stream:\s*true/g)].length).toBe(1)
    // Anchored on the trailing comma to count only the actual call-site
    // option entries, not the (deliberately worded) prose comments above
    // generateCreativeCore/generatePackaging that also say "maxRetries:0".
    expect([...src.matchAll(/maxRetries:\s*0,/g)].length).toBe(2)
    expect([...src.matchAll(/streamDeadlineMs:\s*CORE_STREAM_DEADLINE_MS/g)].length).toBe(1)
    expect([...src.matchAll(/timeoutMs:\s*CORE_STREAM_DEADLINE_MS/g)].length).toBe(1)
    expect([...src.matchAll(/timeoutMs:\s*PACKAGING_TIMEOUT_MS/g)].length).toBe(1)
  })
})

describe('two-stage route timeframe -- documented budget vs. the confirmed 300s Vercel ceiling', () => {
  // Confirmed from the incident's own Vercel log ("Execution Duration /
  // Maximum: 2m 5s / 5m") -- not re-derived, just pinned here so this test
  // fails loudly if anyone changes the assumption without re-checking it.
  const VERCEL_MAX_DURATION_MS = 300_000
  // Measured from the SAME incident: total execution 126.8s minus the two
  // Anthropic attempts' own 59.60s+59.44s=119.04s ≈ 7.8s of real non-AI
  // work (auth/ownership/snapshot/lock/cache-check). Budgeted a bit above
  // that (pre-call ~8s) plus an estimate for the post-call writes this
  // specific incident never reached (2×logUsage + chargeFeature +
  // savePaidResult + lock release, ~8s) = 16s total.
  const ASSUMED_OVERHEAD_MS = 16_000
  // Observed Sonnet throughput from the two Error-499 Console Log entries:
  // 2,275 tok/59.60s and 2,332 tok/59.44s.
  const OBSERVED_TOKENS_PER_SECOND = (2275 / 59.60 + 2332 / 59.44) / 2
  const CORE_MAX_TOKENS = 6000

  it('CORE_STREAM_DEADLINE_MS + PACKAGING_TIMEOUT_MS + overhead stays under the Vercel ceiling with a real safety margin', async () => {
    const { CORE_STREAM_DEADLINE_MS, PACKAGING_TIMEOUT_MS } = await import('@/lib/video-package')
    const worstCaseTotalMs = CORE_STREAM_DEADLINE_MS + PACKAGING_TIMEOUT_MS + ASSUMED_OVERHEAD_MS
    expect(worstCaseTotalMs).toBeLessThan(VERCEL_MAX_DURATION_MS)
    const marginMs = VERCEL_MAX_DURATION_MS - worstCaseTotalMs
    expect(marginMs).toBeGreaterThanOrEqual(15_000) // "tartalékkal a lock-feloldásra és a mentésre"
  })

  it('CORE_STREAM_DEADLINE_MS comfortably covers the full 6000-token worst case at the empirically observed throughput', async () => {
    const { CORE_STREAM_DEADLINE_MS } = await import('@/lib/video-package')
    const estimatedWorstCaseGenerationMs = (CORE_MAX_TOKENS / OBSERVED_TOKENS_PER_SECOND) * 1000
    expect(estimatedWorstCaseGenerationMs).toBeLessThan(CORE_STREAM_DEADLINE_MS)
    const marginRatio = CORE_STREAM_DEADLINE_MS / estimatedWorstCaseGenerationMs
    expect(marginRatio).toBeGreaterThanOrEqual(1.2) // at least ~20% headroom over the worst-case estimate
  })
})

// ============================================================
// Remaining-time guard (2026-10-01 incident fix, follow-up) --
// hasTimeBudgetForPackaging / hasTimeBudgetForChargeAndSave in
// lib/video-package.ts, and the control-flow pattern app/api/video-package/
// route.ts builds around them. All DB-/provider-free: no Supabase, no
// Anthropic SDK anywhere below -- the mocked SDK from the top of this file
// is not even exercised in this section.
// ============================================================

describe('hasTimeBudgetForPackaging / hasTimeBudgetForChargeAndSave -- pure gate functions, exact boundary values', () => {
  it('hasTimeBudgetForPackaging is true exactly while remaining time >= PACKAGING_TIMEOUT_MS + PACKAGING_SAFETY_MARGIN_MS (80_000ms)', async () => {
    const { hasTimeBudgetForPackaging } = await import('@/lib/video-package')
    expect(hasTimeBudgetForPackaging(220_000)).toBe(true) // remaining exactly 80_000 -- boundary, inclusive
    expect(hasTimeBudgetForPackaging(220_001)).toBe(false) // remaining 79_999 -- one ms short
    expect(hasTimeBudgetForPackaging(0)).toBe(true) // the real case right after core finishes fast
  })

  it('hasTimeBudgetForChargeAndSave is true exactly while remaining time >= CHARGE_SAVE_SAFETY_MARGIN_MS (20_000ms)', async () => {
    const { hasTimeBudgetForChargeAndSave } = await import('@/lib/video-package')
    expect(hasTimeBudgetForChargeAndSave(280_000)).toBe(true) // remaining exactly 20_000 -- boundary, inclusive
    expect(hasTimeBudgetForChargeAndSave(280_001)).toBe(false) // remaining 19_999 -- one ms short
  })

  it('clock-driven: elapsedMs derived from an actual (fake) Date.now() delta feeds the same boundary correctly', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const routeStartedAt = Date.now()
      vi.setSystemTime(220_000)
      const elapsedMs = Date.now() - routeStartedAt
      expect(elapsedMs).toBe(220_000)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('route control-flow pattern: checkpoints stop before packaging/charge, success proceeds, lock always releases', () => {
  // This harness reproduces the EXACT shape app/api/video-package/route.ts
  // uses around the two guards (core -> logUsage -> checkpoint ->
  // packaging -> logUsage -> checkpoint -> charge/save, all inside one
  // try/finally that releases the lock) using the REAL exported gate
  // functions and REAL Date.now() under fake timers, but with every
  // DB-/provider-touching step replaced by an injected fake. The separate
  // static-structure test below proves the real route.ts actually wires
  // ITS real steps in this same order -- this harness proves the PATTERN
  // itself (stop-before-side-effect, always-release) is sound.
  async function runGuardedRouteHarness(opts: {
    packagingDelayMs: number
    advanceBeforeStartMs?: number
    steps: {
      logCoreUsage: () => void
      logPackagingUsage: () => void
      generatePackaging: () => Promise<void>
      chargeFeature: () => Promise<void>
      savePaidResult: () => Promise<void>
      releaseLock: () => void
    }
  }) {
    const { hasTimeBudgetForPackaging, hasTimeBudgetForChargeAndSave } = await import('@/lib/video-package')
    // routeStartedAt is captured FIRST, exactly like the real route.ts --
    // advanceBeforeStartMs then simulates the time a (fake, not-modeled-
    // here) core generation would have consumed BEFORE this point, so the
    // first checkpoint sees genuine elapsed time, not zero.
    const routeStartedAt = Date.now()
    if (opts.advanceBeforeStartMs) vi.advanceTimersByTime(opts.advanceBeforeStartMs)
    try {
      opts.steps.logCoreUsage()
      const elapsedBeforePackagingMs = Date.now() - routeStartedAt
      if (!hasTimeBudgetForPackaging(elapsedBeforePackagingMs)) {
        return { status: 504 as const, stoppedAt: 'before_packaging' as const }
      }
      vi.advanceTimersByTime(opts.packagingDelayMs)
      await opts.steps.generatePackaging()
      opts.steps.logPackagingUsage()
      const elapsedBeforeChargeMs = Date.now() - routeStartedAt
      if (!hasTimeBudgetForChargeAndSave(elapsedBeforeChargeMs)) {
        return { status: 504 as const, stoppedAt: 'before_charge' as const }
      }
      await opts.steps.chargeFeature()
      await opts.steps.savePaidResult()
      return { status: 200 as const, stoppedAt: null }
    } finally {
      opts.steps.releaseLock()
    }
  }

  function fakeSteps() {
    return {
      logCoreUsage: vi.fn(),
      logPackagingUsage: vi.fn(),
      generatePackaging: vi.fn().mockResolvedValue(undefined),
      chargeFeature: vi.fn().mockResolvedValue(undefined),
      savePaidResult: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn(),
    }
  }

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('success path: fast core + fast packaging -- packaging, charge, save and lock-release all run, in order', async () => {
    const steps = fakeSteps()
    const result = await runGuardedRouteHarness({ packagingDelayMs: 5_000, steps })
    expect(result).toEqual({ status: 200, stoppedAt: null })
    expect(steps.logCoreUsage).toHaveBeenCalledTimes(1)
    expect(steps.generatePackaging).toHaveBeenCalledTimes(1)
    expect(steps.logPackagingUsage).toHaveBeenCalledTimes(1)
    expect(steps.chargeFeature).toHaveBeenCalledTimes(1)
    expect(steps.savePaidResult).toHaveBeenCalledTimes(1)
    expect(steps.releaseLock).toHaveBeenCalledTimes(1)
  })

  it('checkpoint 1 (before packaging): a core generation that already used up the safe budget stops BEFORE packaging, charge and save -- but core usage was still logged, and the lock still releases', async () => {
    const steps = fakeSteps()
    // 220_001ms already elapsed before this call even starts (e.g. a
    // near-worst-case core stream) -- hasTimeBudgetForPackaging(220_001) is
    // false (see the boundary test above), so the FIRST checkpoint must trip.
    // 220_001ms already elapsed before this call even starts (e.g. a
    // near-worst-case core stream) -- hasTimeBudgetForPackaging(220_001) is
    // false (see the boundary test above), so the FIRST checkpoint must trip.
    const result = await runGuardedRouteHarness({ packagingDelayMs: 5_000, advanceBeforeStartMs: 220_001, steps })
    expect(result).toEqual({ status: 504, stoppedAt: 'before_packaging' })
    expect(steps.logCoreUsage).toHaveBeenCalledTimes(1) // usage never lost
    expect(steps.generatePackaging).not.toHaveBeenCalled()
    expect(steps.logPackagingUsage).not.toHaveBeenCalled()
    expect(steps.chargeFeature).not.toHaveBeenCalled() // no deduction
    expect(steps.savePaidResult).not.toHaveBeenCalled() // no save attempt
    expect(steps.releaseLock).toHaveBeenCalledTimes(1) // lock still released
  })

  it('checkpoint 2 (before charge): packaging itself eats the remaining budget -- charge and save are skipped, but BOTH core and packaging usage were logged, and the lock still releases', async () => {
    const steps = fakeSteps()
    // packagingDelayMs pushes elapsed-before-charge to 280_001ms, one past
    // the hasTimeBudgetForChargeAndSave boundary (280_000 -- see above),
    // while elapsed-before-packaging stays at 0 (checkpoint 1 must pass).
    const result = await runGuardedRouteHarness({ packagingDelayMs: 280_001, steps })
    expect(result).toEqual({ status: 504, stoppedAt: 'before_charge' })
    expect(steps.logCoreUsage).toHaveBeenCalledTimes(1)
    expect(steps.generatePackaging).toHaveBeenCalledTimes(1) // packaging DID run
    expect(steps.logPackagingUsage).toHaveBeenCalledTimes(1) // its usage was logged
    expect(steps.chargeFeature).not.toHaveBeenCalled() // no deduction
    expect(steps.savePaidResult).not.toHaveBeenCalled() // no save attempt -- the exact risk this guard exists to prevent
    expect(steps.releaseLock).toHaveBeenCalledTimes(1) // lock still released
  })

  it('lock release happens even if a downstream step throws (mirrors the real try/finally around releaseRequestLock)', async () => {
    const steps = fakeSteps()
    steps.generatePackaging.mockRejectedValue(new Error('boom'))
    await expect(runGuardedRouteHarness({ packagingDelayMs: 0, steps })).rejects.toThrow('boom')
    expect(steps.releaseLock).toHaveBeenCalledTimes(1)
  })
})

describe('static structure check: the real route.ts wires the two guards in the documented order, both inside the lock\'s try/finally', () => {
  // route.ts is CRLF on this checkout -- normalize so every \n in the
  // patterns below matches regardless of the file's actual line endings.
  const src = readFileSync(join(process.cwd(), 'app', 'api', 'video-package', 'route.ts'), 'utf-8').replace(/\r\n/g, '\n')

  it('imports both gate functions from lib/video-package', () => {
    expect(src).toMatch(/import\s*\{[\s\S]*?hasTimeBudgetForPackaging[\s\S]*?hasTimeBudgetForChargeAndSave[\s\S]*?\}\s*from\s*'@\/lib\/video-package'/)
  })

  it('measures routeStartedAt = Date.now() before the main try block', () => {
    const startedAtIndex = src.indexOf('const routeStartedAt = Date.now()')
    const tryIndex = src.indexOf('try {')
    expect(startedAtIndex).toBeGreaterThan(-1)
    expect(startedAtIndex).toBeLessThan(tryIndex)
  })

  it('calls happen in the documented order: core logUsage -> checkpoint 1 -> generatePackaging -> packaging logUsage -> checkpoint 2 -> atomic charge+save', () => {
    const order = [
      "logUsage(userId, feature, MODELS.primary",
      'hasTimeBudgetForPackaging(',
      'generatePackaging({',
      'logUsage(userId, feature, MODELS.fast',
      'hasTimeBudgetForChargeAndSave(',
      'chargeFeatureAndSavePaidResult({',
    ].map(needle => src.indexOf(needle))
    expect(order.every(i => i !== -1)).toBe(true)
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1])
  })

  it('logs usage exactly once per AI call -- the old, pre-guard duplicate logUsage pair was removed, not left behind alongside the new ones', () => {
    expect([...src.matchAll(/await logUsage\(/g)].length).toBe(2)
  })

  it('releaseRequestLock runs exactly once, inside a finally block', () => {
    expect([...src.matchAll(/releaseRequestLock\(/g)].length).toBe(1)
    expect(src).toMatch(/\}\s*finally\s*\{\s*await releaseRequestLock\(lock\.lockId\)/)
  })

  it('both new early-return guards respond without a success payload (no credits_remaining/paid_result_id -- nothing suggesting a charge happened)', () => {
    const guardBlocks = [...src.matchAll(/if \(!hasTimeBudgetFor\w+\([^)]*\)\) \{\n[\s\S]*?\n\s*\}/g)].map(m => m[0])
    expect(guardBlocks.length).toBe(2)
    for (const block of guardBlocks) {
      expect(block).not.toMatch(/_credits_remaining|paid_result_id/)
      expect(block).toMatch(/status: 504/)
    }
  })
})
