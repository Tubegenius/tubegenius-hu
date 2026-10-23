// @vitest-environment jsdom
//
// 2026-09-29 QA fix regression coverage -- REAL rendered OpportunitiesPage
// (app/dashboard/opportunities/page.tsx), not just TopicCard in isolation.
// The bug this file exists to catch (and did NOT exist to catch before
// today) is specifically in the WIRING between the mount-time historical
// (paidResultId-driven) reopen and the "Készíts csomagot" click -- the
// existing tests/opportunity-evidence-snapshot-component-interaction.test.tsx
// suite renders TopicCard/DiscoveryLaneCard with a HAND-PASSED paidResultId
// prop, which can never catch a bug in how page.tsx itself derives that
// prop from tryCacheOnlyLookup()'s response. This file renders the real
// page, drives it through the real ?niche=&paidResultId= mount path with a
// mocked fetch (no network, no DB, no provider call), and clicks the real
// rendered button.
//
// No Docker/DB/provider access anywhere in this file -- every fetch is
// intercepted by installFetchRouter below; anything unmatched gets a
// harmless empty 200 response, never a real network call.
import React from 'react'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CreditBalanceProvider } from '@/components/credits/CreditBalanceContext'

let mockSearchParams = new URLSearchParams()

vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
}))

vi.mock('@/lib/supabase', () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'user-1' } } }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: {
              user_id: 'user-1', niche: 'régi niche (session előtti)', platform: 'youtube',
              region: 'HU', language: 'hu', creator_level: 'growing',
            },
          }),
        }),
      }),
    }),
  }),
}))

// Imported AFTER the mocks above so the module picks them up.
const OpportunitiesPage = (await import('@/app/dashboard/opportunities/page')).default

function makeApiTopic(overrides: Record<string, unknown> = {}) {
  return {
    id: 'topic-reopen-1',
    title: 'Node.js Async/Await - Miért nem blokkolja meg tényleg az alkalmazásod?',
    description: 'Miért nem blokkolja meg tényleg az alkalmazásod.',
    opportunity_score: 43,
    score_breakdown: { trend_momentum: 35, niche_match: 65, content_gap: 30, competition: 75, freshness: 67, total: 43 },
    region: 'HU', platform: 'youtube', niche: 'tech',
    generated_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    evidence_videos: [], web_sources: [],
    confidence: 'közepes', keyword: 'node async',
    ready_to_produce_status: 'watch', ready_to_produce_label: 'Korai lehetőség',
    risk_flags: [],
    ...overrides,
  }
}

function installFetchRouter(handler: (url: string, init?: RequestInit) => Promise<Response | undefined> | Response | undefined) {
  const original = global.fetch
  const calls: Array<{ url: string; body: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    let body: unknown = null
    try { body = init?.body ? JSON.parse(String(init.body)) : null } catch { body = init?.body ?? null }
    calls.push({ url, body })
    if (url.includes('/api/credits')) {
      return new Response(JSON.stringify({ balance: 0, total_available_credits: 0 }), { status: 200 })
    }
    if (url.includes('/api/memory/saved-lookup')) {
      return new Response(JSON.stringify({ topics: [] }), { status: 200 })
    }
    const handled = await handler(url, init)
    if (handled) return handled
    return new Response(JSON.stringify({}), { status: 200 })
  }))
  return { restore: () => vi.stubGlobal('fetch', original), calls }
}

function withCreditProvider(children: React.ReactNode) {
  return React.createElement(CreditBalanceProvider, null, children)
}

describe('OpportunitiesPage -- real historical (paidResultId) reopen through to a real "Készíts csomagot" click', () => {
  beforeEach(() => {
    sessionStorage.clear()
    // @ts-expect-error -- deliberate test-only reassignment, matches the
    // established pattern in opportunity-evidence-snapshot-component-
    // interaction.test.tsx (jsdom does not implement real navigation).
    delete window.location
    // @ts-expect-error
    window.location = { href: '' }
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('cache_only reopen response carries paid_result_id -> click sends the SAME id to /api/opportunity/evidence-snapshot -> navigates with its video_idea_id', async () => {
    mockSearchParams = new URLSearchParams({ niche: 'Node.js alapok kezdőknek magyarul', paidResultId: 'paid-result-reopen-77' })
    const topic = makeApiTopic()

    const { calls, restore } = installFetchRouter((url) => {
      if (url.includes('/api/opportunity') && !url.includes('evidence-snapshot')) {
        // This is the exact tryCacheOnlyLookup() request shape -- a real
        // historical reopen, cache_only:true, explicit paidResultId.
        return new Response(JSON.stringify({
          cached: true, from_paid_result: true, cache_status: 'fresh',
          paid_result_id: 'paid-result-reopen-77',
          topics: [topic], pool_topics: [],
        }), { status: 200 })
      }
      if (url.includes('/api/opportunity/evidence-snapshot')) {
        return new Response(JSON.stringify({ video_idea_id: 'idea-from-reopen', snapshot_id: 'snap-from-reopen' }), { status: 200 })
      }
    })

    render(withCreditProvider(React.createElement(OpportunitiesPage)))

    // Proves the reopen actually rendered the real, server-stored topic
    // (not a fabricated/empty state) before we ever touch the button.
    await screen.findByText(topic.title)

    const button = await screen.findByRole('link', { name: /Videócsomag/i })
    fireEvent.click(button)

    await waitFor(() => expect(window.location.href).toContain('video_idea_id=idea-from-reopen'))

    // The actual regression assertion: the evidence-snapshot POST must have
    // carried the id the page reopened WITH, not a missing/wrong one.
    const snapshotCall = calls.find(c => c.url.includes('/api/opportunity/evidence-snapshot'))
    expect(snapshotCall).toBeDefined()
    expect(snapshotCall!.body).toMatchObject({ paid_result_id: 'paid-result-reopen-77', topic_id: topic.id })

    restore()
  })

  it('cache_only reopen response has NO paid_result_id (e.g. a stale/live-candidate cache hit) -> click does NOT silently navigate or call the server -- only the explicit "Folytatás bizonyíték nélkül" choice does', async () => {
    mockSearchParams = new URLSearchParams({ niche: 'Node.js alapok kezdőknek magyarul', paidResultId: 'paid-result-that-will-not-resolve' })
    const topic = makeApiTopic({ id: 'topic-reopen-2' })

    const { calls, restore } = installFetchRouter((url) => {
      if (url.includes('/api/opportunity') && !url.includes('evidence-snapshot')) {
        // A real response shape the route can produce: cached content, but
        // NO paid_result_id (e.g. the opportunity_cache fallback branch,
        // not the explicit-paidResultId branch) -- lastPaidResultId must
        // stay null, never fabricate/reuse the requested id.
        return new Response(JSON.stringify({
          cached: true, from_paid_result: false, cache_status: 'fresh',
          topics: [topic], pool_topics: [],
        }), { status: 200 })
      }
    })

    render(withCreditProvider(React.createElement(OpportunitiesPage)))
    await screen.findByText(topic.title)

    const button = await screen.findByRole('link', { name: /Videócsomag/i })
    fireEvent.click(button)

    const bypass = await screen.findByText('Folytatás bizonyíték nélkül')
    expect(window.location.href).toBe('')
    expect(calls.some(c => c.url.includes('/api/opportunity/evidence-snapshot'))).toBe(false)

    fireEvent.click(bypass)
    await waitFor(() => expect(window.location.href).toContain('/dashboard/video-package'))
    expect(calls.some(c => c.url.includes('/api/opportunity/evidence-snapshot'))).toBe(false)

    restore()
  })
})
