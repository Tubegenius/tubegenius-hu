// @vitest-environment jsdom
//
// REAL rendered component-interaction tests for TopicCard and
// DiscoveryLaneCard (app/dashboard/opportunities/topic-cards.tsx, extracted
// out of page.tsx so it can be exported at all -- see that file's header
// comment) -- actual DOM
// rendering via React Testing Library, actual fireEvent clicks, actual
// assertions on the rendered DOM after each interaction. This is
// deliberately a SEPARATE environment override (this file only) from the
// rest of the suite, which runs `environment: 'node'` (see vitest.config.ts)
// -- @testing-library/react + jsdom were added as new devDependencies
// specifically to make this possible; no other test file's environment
// changes.
//
// This is NOT the same claim as "new browser context" (that is proven at
// the server round-trip level in tests/opportunity-evidence-snapshot-
// behavioral.test.ts, which is explicit about that distinction) -- this
// file proves the CLIENT-SIDE click -> fetch -> DOM-update behavior for
// real, in a real DOM, which route-level tests cannot.
import React from 'react'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TopicCard, DiscoveryLaneCard } from '@/app/dashboard/opportunities/topic-cards'
import { CreditBalanceProvider } from '@/components/credits/CreditBalanceContext'
import type { OpportunityTopic } from '@/types'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function makeTopic(overrides: Partial<OpportunityTopic> = {}): OpportunityTopic & Record<string, unknown> {
  return {
    id: 'topic-1',
    title: 'Node.js Async/Await',
    description: 'Miért nem blokkolja meg tényleg az alkalmazásod.',
    opportunity_score: 43,
    score_breakdown: { trend_momentum: 35, niche_match: 65, content_gap: 30, competition: 75, freshness: 67, total: 43 },
    region: 'HU',
    platform: 'youtube',
    niche: 'tech',
    generated_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    evidence_videos: [],
    web_sources: [],
    confidence: 'közepes',
    keyword: 'node async',
    ready_to_produce_status: 'watch',
    ready_to_produce_label: 'Korai lehetőség',
    risk_flags: [],
    ...overrides,
  } as OpportunityTopic & Record<string, unknown>
}

// Minimal fetch router: /api/credits (the CreditBalanceProvider mounts and
// fetches this immediately) gets a harmless, always-resolving stub;
// everything else is driven per-test via the injected handler.
function installFetchRouter(handler: (url: string, init?: RequestInit) => Promise<Response | undefined> | Response | undefined) {
  const original = global.fetch
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/credits')) {
      // Shaped to satisfy parseCreditBalanceResponse (lib/credit-balance-
      // client.ts) so the provider settles into 'ready', not 'error' --
      // irrelevant to what this suite asserts, but avoids masking a real
      // failure behind an unrelated, expected-shaped rejection.
      return new Response(JSON.stringify({ balance: 0, total_available_credits: 0 }), { status: 200 })
    }
    const handled = await handler(url, init)
    if (handled) return handled
    return new Response(JSON.stringify({}), { status: 200 })
  }))
  return () => vi.stubGlobal('fetch', original)
}

function withCreditProvider(children: React.ReactNode) {
  return React.createElement(CreditBalanceProvider, null, children)
}

describe('TopicCard -- real rendered click → save → navigation', () => {
  beforeEach(() => {
    // jsdom does not implement real navigation -- give window.location an
    // assignable, inspectable stand-in so the test can observe what the
    // click handler tried to navigate to, without jsdom's "Not implemented"
    // noise.
    // @ts-expect-error -- deliberate test-only reassignment
    delete window.location
    // @ts-expect-error
    window.location = { href: '' }
  })

  it('click → POST /api/opportunity/evidence-snapshot → success → real navigation to the video_idea_id URL', async () => {
    const restore = installFetchRouter((url) => {
      if (url.includes('/api/opportunity/evidence-snapshot')) {
        return new Response(JSON.stringify({ video_idea_id: 'idea-42', snapshot_id: 'snap-1' }), { status: 200 })
      }
    })
    const topic = makeTopic()
    render(withCreditProvider(
      React.createElement(TopicCard, {
        topic, index: 0, onReplace: () => {}, hasPool: false, onSimilarResult: () => {},
        replacing: false, alreadySavedTopics: new Set<string>(), onTopicSaved: () => {}, saveGateReady: true,
        paidResultId: 'paid-result-1',
      }),
    ))

    const button = screen.getByRole('link', { name: /Videócsomag/i })
    fireEvent.click(button)

    await waitFor(() => expect(window.location.href).toContain('video_idea_id=idea-42'))
    expect(window.location.href).toContain('topic=');
    restore()
  })

  it('click → 401 → error banner shown, NO navigation happens', async () => {
    const restore = installFetchRouter((url) => {
      if (url.includes('/api/opportunity/evidence-snapshot')) return new Response(JSON.stringify({ error: 'unauth' }), { status: 401 })
    })
    const topic = makeTopic()
    render(withCreditProvider(
      React.createElement(TopicCard, {
        topic, index: 0, onReplace: () => {}, hasPool: false, onSimilarResult: () => {},
        replacing: false, alreadySavedTopics: new Set<string>(), onTopicSaved: () => {}, saveGateReady: true,
        paidResultId: 'paid-result-1',
      }),
    ))

    const button = screen.getByRole('link', { name: /Videócsomag/i })
    fireEvent.click(button)

    await screen.findByRole('alert')
    expect(screen.getByRole('alert').textContent).toMatch(/bejelentkezés vagy jogosultság/)
    expect(window.location.href).toBe('')
    // Blocked kind never offers the bypass control.
    expect(screen.queryByText('Folytatás bizonyíték nélkül')).toBeNull()
    restore()
  })

  it('click → 404 (degradable) → error banner + explicit "Folytatás bizonyíték nélkül" → clicking IT (and only it) navigates', async () => {
    const restore = installFetchRouter((url) => {
      if (url.includes('/api/opportunity/evidence-snapshot')) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 })
    })
    const topic = makeTopic()
    render(withCreditProvider(
      React.createElement(TopicCard, {
        topic, index: 0, onReplace: () => {}, hasPool: false, onSimilarResult: () => {},
        replacing: false, alreadySavedTopics: new Set<string>(), onTopicSaved: () => {}, saveGateReady: true,
        paidResultId: 'paid-result-1',
      }),
    ))

    const button = screen.getByRole('link', { name: /Videócsomag/i })
    fireEvent.click(button)

    const bypass = await screen.findByText('Folytatás bizonyíték nélkül')
    // Navigation must NOT have happened automatically from the failure alone.
    expect(window.location.href).toBe('')

    fireEvent.click(bypass)
    await waitFor(() => expect(window.location.href).toContain('/dashboard/video-package'))
    // Built via URLSearchParams (buildOpportunityPackageUrl), which encodes
    // spaces as '+', not '%20' like encodeURIComponent -- assert against the
    // actual encoding the app produces, not a hand-rolled equivalent.
    expect(window.location.href).toContain(`topic=${new URLSearchParams({ topic: topic.title }).toString().slice('topic='.length)}`)
    restore()
  })

  it('no paidResultId at all: NO silent navigation, no fetch attempted — only the explicit "Folytatás bizonyíték nélkül" click navigates (2026-09-29 QA fix: this used to silently navigate)', async () => {
    const fetchSpy = vi.fn()
    const restore = installFetchRouter(async (url) => { fetchSpy(url); return undefined })
    const topic = makeTopic()
    render(withCreditProvider(
      React.createElement(TopicCard, {
        topic, index: 0, onReplace: () => {}, hasPool: false, onSimilarResult: () => {},
        replacing: false, alreadySavedTopics: new Set<string>(), onTopicSaved: () => {}, saveGateReady: true,
        paidResultId: null,
      }),
    ))

    const button = screen.getByRole('link', { name: /Videócsomag/i })
    fireEvent.click(button)

    const bypass = await screen.findByText('Folytatás bizonyíték nélkül')
    // The missing-id click alone must NOT navigate or call the server.
    expect(window.location.href).toBe('')
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('/api/opportunity/evidence-snapshot'))).toBe(false)

    fireEvent.click(bypass)
    await waitFor(() => expect(window.location.href).toContain('/dashboard/video-package'))
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('/api/opportunity/evidence-snapshot'))).toBe(false)
    restore()
  })
})

describe('DiscoveryLaneCard -- real rendered click → save → navigation (identical contract to TopicCard)', () => {
  beforeEach(() => {
    // @ts-expect-error
    delete window.location
    // @ts-expect-error
    window.location = { href: '' }
  })

  it('click → success → real navigation', async () => {
    const restore = installFetchRouter((url) => {
      if (url.includes('/api/opportunity/evidence-snapshot')) {
        return new Response(JSON.stringify({ video_idea_id: 'idea-99' }), { status: 200 })
      }
    })
    const topic = makeTopic({ id: 'discovery-topic-1' })
    render(withCreditProvider(
      React.createElement(DiscoveryLaneCard, { topic, onSearch: () => {}, paidResultId: 'paid-result-2' }),
    ))

    const button = screen.getByRole('link', { name: /Videócsomag/i })
    fireEvent.click(button)

    await waitFor(() => expect(window.location.href).toContain('video_idea_id=idea-99'))
    restore()
  })

  it('click → 401 → blocked, no navigation, no bypass offered', async () => {
    const restore = installFetchRouter((url) => {
      if (url.includes('/api/opportunity/evidence-snapshot')) return new Response(JSON.stringify({}), { status: 403 })
    })
    const topic = makeTopic({ id: 'discovery-topic-2' })
    render(withCreditProvider(
      React.createElement(DiscoveryLaneCard, { topic, onSearch: () => {}, paidResultId: 'paid-result-2' }),
    ))

    const button = screen.getByRole('link', { name: /Videócsomag/i })
    fireEvent.click(button)

    await screen.findByRole('alert')
    expect(window.location.href).toBe('')
    expect(screen.queryByText('Folytatás bizonyíték nélkül')).toBeNull()
    restore()
  })

  it('click → 500 (degradable) → explicit continue control → click navigates', async () => {
    const restore = installFetchRouter((url) => {
      if (url.includes('/api/opportunity/evidence-snapshot')) return new Response(JSON.stringify({}), { status: 500 })
    })
    const topic = makeTopic({ id: 'discovery-topic-3' })
    render(withCreditProvider(
      React.createElement(DiscoveryLaneCard, { topic, onSearch: () => {}, paidResultId: 'paid-result-2' }),
    ))

    const button = screen.getByRole('link', { name: /Videócsomag/i })
    fireEvent.click(button)

    const bypass = await screen.findByText('Folytatás bizonyíték nélkül')
    expect(window.location.href).toBe('')
    fireEvent.click(bypass)
    await waitFor(() => expect(window.location.href).toContain('/dashboard/video-package'))
    restore()
  })

  it('no paidResultId at all: identical contract to TopicCard — no silent navigation, explicit bypass required', async () => {
    const fetchSpy = vi.fn()
    const restore = installFetchRouter(async (url) => { fetchSpy(url); return undefined })
    const topic = makeTopic({ id: 'discovery-topic-4' })
    render(withCreditProvider(
      React.createElement(DiscoveryLaneCard, { topic, onSearch: () => {}, paidResultId: null }),
    ))

    const button = screen.getByRole('link', { name: /Videócsomag/i })
    fireEvent.click(button)

    const bypass = await screen.findByText('Folytatás bizonyíték nélkül')
    expect(window.location.href).toBe('')
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('/api/opportunity/evidence-snapshot'))).toBe(false)

    fireEvent.click(bypass)
    await waitFor(() => expect(window.location.href).toContain('/dashboard/video-package'))
    restore()
  })
})
