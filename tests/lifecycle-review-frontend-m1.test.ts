import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LifecycleReviewListItem } from '@/lib/semantic-topic/lifecycle-review-types'
import {
  LIFECYCLE_LIST_PAGE_SIZE,
  LIFECYCLE_STATUS_FILTER_OPTIONS,
  LIFECYCLE_STATUS_PRESENTATION,
  buildLifecycleReviewListUrl,
  deriveLifecycleCursor,
  filterLifecycleTransitions,
  formatLifecycleStaleReason,
  lifecycleListError,
  mergeLifecyclePages,
  parseLifecycleReviewListResponse,
} from '@/lib/lifecycle-review-presentation'
import { creatorOSSectionForPath } from '@/lib/creator-os-navigation'

function request(overrides: Partial<LifecycleReviewListItem> = {}): LifecycleReviewListItem {
  return {
    reviewRequestId: '7dcddc8d-ab57-42b2-99ce-ec996858520d',
    generation: 3,
    semanticTopicId: 'a388f707-8991-403a-b5df-33385d81282c',
    topicCanonicalLabel: 'Short-form storytelling systems',
    fromStatus: 'corroborating',
    targetStatus: 'coherent',
    requestStatus: 'requested',
    requestedAt: '2026-09-14T08:30:00.000Z',
    expiresAt: '2026-09-16T08:30:00.000Z',
    decidedAt: null,
    staleReasonCode: null,
    ...overrides,
  }
}

describe('Lifecycle Reviewer frontend Milestone 1 presentation contract', () => {
  it('covers every closed request status and every list filter', () => {
    expect(Object.keys(LIFECYCLE_STATUS_PRESENTATION).sort()).toEqual([
      'approved', 'cancelled', 'executed', 'expired', 'rejected', 'requested', 'stale',
    ])
    expect(LIFECYCLE_STATUS_FILTER_OPTIONS.map(option => option.value).sort()).toEqual([
      'actionable', 'approved', 'cancelled', 'executed', 'expired', 'history', 'rejected', 'requested', 'stale',
    ])
  })

  it('builds the list URL with the complete keyset cursor pair', () => {
    const url = buildLifecycleReviewListUrl('history', 20, {
      afterRequestedAt: '2026-09-14T08:30:00.000Z',
      afterId: '7dcddc8d-ab57-42b2-99ce-ec996858520d',
    })
    const parsed = new URL(url, 'https://willviral.test')
    expect(parsed.pathname).toBe('/api/admin/semantic-topic-lifecycle-reviews')
    expect(parsed.searchParams.get('status')).toBe('history')
    expect(parsed.searchParams.get('limit')).toBe('20')
    expect(parsed.searchParams.get('after_requested_at')).toBe('2026-09-14T08:30:00.000Z')
    expect(parsed.searchParams.get('after_id')).toBe('7dcddc8d-ab57-42b2-99ce-ec996858520d')
  })

  it('only derives a cursor for a full page and uses the final row', () => {
    expect(deriveLifecycleCursor([request()], LIFECYCLE_LIST_PAGE_SIZE)).toBeNull()
    const fullPage = Array.from({ length: LIFECYCLE_LIST_PAGE_SIZE }, (_, index) => request({
      reviewRequestId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      requestedAt: `2026-09-14T08:${String(index).padStart(2, '0')}:00.000Z`,
    }))
    expect(deriveLifecycleCursor(fullPage, LIFECYCLE_LIST_PAGE_SIZE)).toEqual({
      afterRequestedAt: '2026-09-14T08:19:00.000Z',
      afterId: '00000000-0000-4000-8000-000000000019',
    })
  })

  it('deduplicates appended pages and filters loaded transitions', () => {
    const first = request()
    const second = request({
      reviewRequestId: '87c30edf-f5bb-4ee1-9144-c27b700b3d17',
      fromStatus: 'ambiguous',
      targetStatus: 'corroborating',
    })
    const merged = mergeLifecyclePages([first], [first, second])
    expect(merged).toHaveLength(2)
    expect(filterLifecycleTransitions(merged, 'ambiguous', 'corroborating')).toEqual([second])
    expect(filterLifecycleTransitions(merged, 'all', 'coherent')).toEqual([first])
  })

  it('accepts empty and valid API lists but rejects malformed closed values', () => {
    expect(parseLifecycleReviewListResponse({ requests: [] })).toEqual([])
    expect(parseLifecycleReviewListResponse({ requests: [request()] })).toHaveLength(1)
    expect(parseLifecycleReviewListResponse({ requests: [request({ requestStatus: 'requested' }), { ...request(), requestStatus: 'unknown' }] })).toBeNull()
    expect(parseLifecycleReviewListResponse({ data: [] })).toBeNull()
  })

  it('maps unauthenticated, forbidden, invalid and server list states', () => {
    expect(lifecycleListError(401).kind).toBe('unauthenticated')
    expect(lifecycleListError(403).kind).toBe('forbidden')
    expect(lifecycleListError(404).kind).toBe('not_found')
    expect(lifecycleListError(422, 'sk_live_sensitive filter')).toEqual({ kind: 'invalid', message: 'A lista szűrői nem érvényesek.' })
    expect(lifecycleListError(500).kind).toBe('server')
  })

  it('presents stale reasons in human language while preserving the closed code', () => {
    expect(formatLifecycleStaleReason('EVIDENCE_VECTOR_CHANGED')).toBe('A bizonyítéki összkép megváltozott')
    expect(formatLifecycleStaleReason('SOURCE_IDENTITY_UNKNOWN')).toBe('Ismeretlen forrásazonosság található')
  })

  it('keeps the capability-gated reviewer route outside the five creator destinations', () => {
    expect(creatorOSSectionForPath('/dashboard/semantic-topic-lifecycle-reviews')).toBeNull()
  })
})

describe('Lifecycle Reviewer frontend Milestone 1 security boundary', () => {
  const queueSource = readFileSync(
    join(process.cwd(), 'components', 'semantic-topic-lifecycle-reviews', 'LifecycleReviewQueue.tsx'),
    'utf8',
  )
  const clientSource = readFileSync(join(process.cwd(), 'lib', 'lifecycle-review-client.ts'), 'utf8')

  it('uses only the lifecycle list GET surface and contains no write request', () => {
    expect(queueSource).toContain("method: 'GET'")
    expect(queueSource).not.toMatch(/method:\s*['"]POST['"]/)
    expect(queueSource).not.toMatch(/\/decision|\/cancel/)
    expect(queueSource).not.toContain('dangerouslySetInnerHTML')
  })

  it('uses same-origin session fetch without manually setting Origin', () => {
    expect(queueSource).toContain('requestLifecycleJson')
    expect(clientSource).toContain("credentials: 'same-origin'")
    expect(`${queueSource}\n${clientSource}`).not.toMatch(/['"]Origin['"]\s*:/)
  })

  it('keeps native keyboard controls and declares reduced-motion styling', () => {
    expect(queueSource).toContain('aria-pressed=')
    expect(queueSource).toContain('<select')
    const css = readFileSync(join(process.cwd(), 'app', 'dashboard', 'creator-os.css'), 'utf8')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain('.wv-lifecycle-card,')
  })

  it('does not expose internal milestone or English working labels in the product UI', () => {
    expect(queueSource).not.toMatch(/Milestone 1|Reviewer surface|Queue control|Decision queue|transition-szűrő/)
    expect(queueSource).toContain('Olvasási mód · nincs automatikus művelet')
    expect(queueSource).toContain('További kérelemstátuszok')
  })
})
