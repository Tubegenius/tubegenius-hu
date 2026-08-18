// PFM Creator Lane Architecture v0 — POST /api/memory/saved-lookup, the
// bounded, visible-topic-scoped replacement for the earlier identity_only
// GET mode (which inherited GET /api/memory's limit=200 and could silently
// misreport an already-saved topic as "not saved" once a user passed 200
// total saved records). Unit-level (mocked lane-service + mocked auth),
// independent of any local Docker Supabase, runs everywhere this repo's
// Vitest suite runs.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { SAVED_LOOKUP_MAX_TOPICS, SAVED_LOOKUP_MAX_TOPIC_LENGTH } from '@/lib/creator-lane/topic-identity'

vi.mock('@/lib/supabase-server', async () => {
  const actual = await vi.importActual<typeof import('@/lib/supabase-server')>('@/lib/supabase-server')
  return { ...actual, createServerSupabaseClient: vi.fn(), createAdminClient: vi.fn(() => ({})) }
})

vi.mock('@/lib/creator-lane/lane-service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/creator-lane/lane-service')>('@/lib/creator-lane/lane-service')
  return { ...actual, getCreatorMemoryByLaneFilter: vi.fn() }
})

import { createServerSupabaseClient } from '@/lib/supabase-server'
import { getCreatorMemoryByLaneFilter } from '@/lib/creator-lane/lane-service'

const USER = 'saved-lookup-user'

beforeEach(() => {
  vi.clearAllMocks()
})

function mockAuthAs(userId: string) {
  vi.mocked(createServerSupabaseClient).mockReturnValue({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: userId } } })) },
  } as any)
}

function postRequest(body: unknown): any {
  return { json: async () => body } as any
}

describe('POST /api/memory/saved-lookup', () => {
  it('returns only the topics that ARE already saved (pending/NULL lane, state=saved), scoped to the given list', async () => {
    mockAuthAs(USER)
    vi.mocked(getCreatorMemoryByLaneFilter).mockResolvedValue([{ topic: 'Téma A' }] as any)
    const { POST } = await import('@/app/api/memory/saved-lookup/route')
    const res = await POST(postRequest({ topics: ['Téma A', 'Téma B'] }))
    const payload = await res.json()

    expect(res.status).toBe(200)
    expect(payload.topics).toEqual(['Téma A'])
    expect(getCreatorMemoryByLaneFilter).toHaveBeenCalledTimes(1)
    expect(getCreatorMemoryByLaneFilter).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: USER, contentLane: null, state: 'saved', select: 'topic', topics: ['Téma A', 'Téma B'], limit: 2,
      }),
    )
  })

  it('deduplicates the input topic list before querying (case: same topic listed twice)', async () => {
    mockAuthAs(USER)
    vi.mocked(getCreatorMemoryByLaneFilter).mockResolvedValue([] as any)
    const { POST } = await import('@/app/api/memory/saved-lookup/route')
    await POST(postRequest({ topics: ['Téma A', 'Téma A', 'Téma A'] }))
    expect(getCreatorMemoryByLaneFilter).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ topics: ['Téma A'], limit: 1 }),
    )
  })

  it('trims each topic to the same identity the server stores (btrim-equivalent) before querying', async () => {
    mockAuthAs(USER)
    vi.mocked(getCreatorMemoryByLaneFilter).mockResolvedValue([] as any)
    const { POST } = await import('@/app/api/memory/saved-lookup/route')
    await POST(postRequest({ topics: ['  Téma A  '] }))
    expect(getCreatorMemoryByLaneFilter).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ topics: ['Téma A'] }),
    )
  })

  it('never falls back to an unscoped/limit-based query — the query is always exactly topics-shaped, regardless of how many total saved records the user might have (200+ simulation)', async () => {
    mockAuthAs(USER)
    // Simulate a user with 250+ total saved records by having the mock
    // return a match for a topic that would NOT be among the "most recent
    // 200" under the old identity_only GET's ordering -- since this route
    // queries by exact topic IN(...) list, not by recency/limit, it must
    // still find it.
    vi.mocked(getCreatorMemoryByLaneFilter).mockResolvedValue([{ topic: 'Régi, 250. legrégebbi mentett téma' }] as any)
    const { POST } = await import('@/app/api/memory/saved-lookup/route')
    const res = await POST(postRequest({ topics: ['Régi, 250. legrégebbi mentett téma'] }))
    const payload = await res.json()
    expect(payload.topics).toEqual(['Régi, 250. legrégebbi mentett téma'])
    // the call never carries a plain "give me the most recent N" shape without
    // a topics filter -- topics is always present and non-empty
    const callArgs = vi.mocked(getCreatorMemoryByLaneFilter).mock.calls[0][1] as any
    expect(callArgs.topics).toEqual(['Régi, 250. legrégebbi mentett téma'])
    expect(callArgs.limit).toBe(1)
  })

  it(`rejects more than ${SAVED_LOOKUP_MAX_TOPICS} topics with 400, never queries the DB`, async () => {
    mockAuthAs(USER)
    const { POST } = await import('@/app/api/memory/saved-lookup/route')
    const tooMany = Array.from({ length: SAVED_LOOKUP_MAX_TOPICS + 1 }, (_, i) => `topic-${i}`)
    const res = await POST(postRequest({ topics: tooMany }))
    expect(res.status).toBe(400)
    expect(getCreatorMemoryByLaneFilter).not.toHaveBeenCalled()
  })

  it(`rejects a topic longer than ${SAVED_LOOKUP_MAX_TOPIC_LENGTH} characters with 400, never queries the DB`, async () => {
    mockAuthAs(USER)
    const { POST } = await import('@/app/api/memory/saved-lookup/route')
    const res = await POST(postRequest({ topics: ['x'.repeat(SAVED_LOOKUP_MAX_TOPIC_LENGTH + 1)] }))
    expect(res.status).toBe(400)
    expect(getCreatorMemoryByLaneFilter).not.toHaveBeenCalled()
  })

  it('rejects a non-array or non-string-array body with 400', async () => {
    mockAuthAs(USER)
    const { POST } = await import('@/app/api/memory/saved-lookup/route')
    for (const badBody of [{ topics: 'not-an-array' }, { topics: [1, 2, 3] }, {}, { topics: [] }]) {
      const res = await POST(postRequest(badBody))
      expect(res.status).toBe(400)
    }
    expect(getCreatorMemoryByLaneFilter).not.toHaveBeenCalled()
  })

  it('all-whitespace topics collapse to nothing queryable -> returns {topics: []} without ever calling the DB', async () => {
    mockAuthAs(USER)
    const { POST } = await import('@/app/api/memory/saved-lookup/route')
    const res = await POST(postRequest({ topics: ['   ', '\t'] }))
    const payload = await res.json()
    expect(res.status).toBe(200)
    expect(payload.topics).toEqual([])
    expect(getCreatorMemoryByLaneFilter).not.toHaveBeenCalled()
  })

  it('unauthenticated requests get 401, never reach the DB', async () => {
    vi.mocked(createServerSupabaseClient).mockReturnValue({
      auth: { getUser: vi.fn(async () => ({ data: { user: null } })) },
    } as any)
    const { POST } = await import('@/app/api/memory/saved-lookup/route')
    const res = await POST(postRequest({ topics: ['A'] }))
    expect(res.status).toBe(401)
    expect(getCreatorMemoryByLaneFilter).not.toHaveBeenCalled()
  })

  it('DB error surfaces as a generic 500 message, never a raw error/constraint string', async () => {
    mockAuthAs(USER)
    vi.mocked(getCreatorMemoryByLaneFilter).mockRejectedValue(new Error('duplicate key value violates unique constraint "some_constraint"'))
    const { POST } = await import('@/app/api/memory/saved-lookup/route')
    const res = await POST(postRequest({ topics: ['A'] }))
    const payload = await res.json()
    expect(res.status).toBe(500)
    expect(payload.error).not.toContain('constraint')
    expect(payload.error).not.toContain('duplicate key')
  })
})

// ------------------------------------------------------------------
// Static source checks (same jsdom-less-repo convention) — the route must
// never perform a write and must always scope by the fail-closed pending
// lane + 'saved' state.
// ------------------------------------------------------------------
describe('app/api/memory/saved-lookup/route.ts — read-only, lane-scoped guarantees', () => {
  const src = readFileSync(join(process.cwd(), 'app', 'api', 'memory', 'saved-lookup', 'route.ts'), 'utf-8').replace(/\r\n/g, '\n')

  it('exports only POST — no GET/PATCH/DELETE on this route', () => {
    expect(src).toMatch(/export async function POST\(/)
    expect(src).not.toMatch(/export async function (GET|PATCH|DELETE|PUT)\(/)
  })

  it('never calls .insert(/.update(/.delete(/.upsert( — purely read-only', () => {
    expect(src).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(/)
  })

  it('always passes contentLane: null and state: \'saved\' to getCreatorMemoryByLaneFilter', () => {
    expect(src).toContain('contentLane: null')
    expect(src).toContain("state: 'saved'")
  })
})
