// POST /api/video-packages -- a mentési szerződés regressziós tesztje.
//
// Bizonyítandó (app/api/video-packages/route.ts):
//   * a szerver a kérés törzséből KIZÁRÓLAG a paid_result_id-t használja; a csomag teljes tartalmát
//     a paid_results.result_json-ból olvassa (owner-szűrt getPaidResultById) -- ezért a kliensnek
//     elég ennyit küldenie, és a 20 000 bájtos törzskorlát nem kerül emelésre;
//   * a hosszú (28 KB-os) fizetett eredmény mentése egy minimális törzzsel működik;
//   * a régi, teljes eredményt küldő törzs (a megfigyelt staging 400) továbbra is 400;
//   * jogosultság: bejelentkezés nélkül 401, idegen/ismeretlen/nem video_package eredmény 404;
//   * a mentés SOSE generál újra, nem von le kreditet, nem érint kredit-/naplótáblát.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const PAID_RESULT_ID = '3f2b8f0e-7c1a-4d5e-9b6a-1c2d3e4f5a6b'

const state = vi.hoisted(() => ({
  user: null as { id: string } | null,
  paidResult: null as any,
  insertResult: { data: { id: 'pkg-1' }, error: null } as { data: { id: string } | null; error: unknown },
  ideaResult: { success: true, idea: { id: 'idea-1' } } as any,
  linkResult: { success: true } as any,
  readyResult: { success: true } as any,
  tables: [] as string[],
  inserts: [] as Array<{ table: string; payload: any }>,
  deletes: [] as string[],
  // a kompenzáló DELETE eredménye: alapból sikeres; a negatív kontrollok hibára / kivételre állítják
  deleteOutcome: (() => ({ error: null as unknown })) as () => { error: unknown },
  rpc: vi.fn(),
}))

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }),
  createAdminClient: () => ({
    rpc: state.rpc,
    from: (table: string) => {
      state.tables.push(table)
      return {
        insert: (payload: any) => {
          state.inserts.push({ table, payload })
          return { select: () => ({ single: async () => state.insertResult }) }
        },
        delete: () => {
          state.deletes.push(table)
          return { eq: () => ({ eq: async () => state.deleteOutcome() }) }
        },
      }
    },
  }),
}))
vi.mock('@/lib/paid-results/paid-results-service', () => ({
  getPaidResultById: vi.fn(async () => state.paidResult),
}))
vi.mock('@/lib/video-ideas/video-idea-service', () => ({
  ensureVideoIdea: vi.fn(async () => state.ideaResult),
  linkVideoIdeaToLegacyRecord: vi.fn(async () => state.linkResult),
  markVideoIdeaReadyToProduce: vi.fn(async () => state.readyResult),
  logVideoIdeaEvent: vi.fn(async () => ({ success: true })),
}))
vi.mock('@/lib/trend-tracking', () => ({ promoteToTrackedCandidate: vi.fn(async () => undefined) }))

import { getPaidResultById } from '@/lib/paid-results/paid-results-service'
import { ensureVideoIdea } from '@/lib/video-ideas/video-idea-service'

function longResultJson(): Record<string, unknown> {
  const filler = (n: number) => 'á'.repeat(Math.floor(n / 4)) + 'a'.repeat(n - 2 * Math.floor(n / 4))
  return {
    topic: 'Szerver oldali téma', platform: 'youtube_long', video_length: '6-10min', narration_style: 'storytelling', intensity: 'classic', goal: 'views',
    hook: 'Szerver oldali hook', narration: filler(6000), cta: 'Szerver oldali CTA',
    scene_structure: [filler(6000)], broll_ideas: [filler(500)], timestamps: [filler(400)], title_variations: [filler(300)], description: filler(1500),
    thumbnail_texts: [], hashtags: { viral: [], niche: [], general: [] }, upload_times: {}, verified_fact_block: { a: filler(2800) },
    sources_used: [], forbidden_claims: [], platform_checklist: { a: filler(3000) },
    opportunity_context: { id: 'idea-1', title: 'Cím', web_sources: [], evidence_videos: [] },
  }
}

function paidResultRow(overrides: Record<string, unknown> = {}) {
  return { id: PAID_RESULT_ID, user_id: 'user-1', tool_type: 'video_package', status: 'completed', result_json: longResultJson(), ...overrides }
}

async function post(body: unknown) {
  const { POST } = await import('@/app/api/video-packages/route')
  return POST({ json: async () => body } as any)
}

const FORBIDDEN_TABLES = ['user_credits', 'credit_ledger', 'paid_results', 'paid_operations', 'ai_usage_logs', 'usage_logs', 'in_flight_requests']

beforeEach(() => {
  state.user = { id: 'user-1' }
  state.paidResult = paidResultRow()
  state.insertResult = { data: { id: 'pkg-1' }, error: null }
  state.ideaResult = { success: true, idea: { id: 'idea-1' } }
  state.linkResult = { success: true }
  state.readyResult = { success: true }
  state.tables.length = 0
  state.inserts.length = 0
  state.deletes.length = 0
  state.deleteOutcome = () => ({ error: null })
  state.rpc.mockReset()
  vi.mocked(getPaidResultById).mockClear()
  vi.mocked(ensureVideoIdea).mockClear()
})

describe('POST /api/video-packages -- the minimal body is enough, the content comes from paid_results', () => {
  it('a long paid result (~28 KB result_json) is saved from {paid_result_id} alone: 200 + id', async () => {
    expect(new TextEncoder().encode(JSON.stringify(state.paidResult.result_json)).length).toBeGreaterThan(20_000)
    const res = await post({ paid_result_id: PAID_RESULT_ID })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 'pkg-1' })
    expect(state.inserts).toHaveLength(1)
    expect(state.inserts[0].table).toBe('video_packages')
  })

  it('every saved field comes from the server-side paid result: client-supplied content in the body is ignored', async () => {
    const res = await post({ paid_result_id: PAID_RESULT_ID, topic: 'CLIENT TOPIC', narration: 'CLIENT NARRATION', hook: 'CLIENT HOOK', cta: 'CLIENT CTA', platform: 'CLIENT' })
    expect(res.status).toBe(200)
    const row = state.inserts[0].payload
    expect(row.topic).toBe('Szerver oldali téma')
    expect(row.hook).toBe('Szerver oldali hook')
    expect(row.cta).toBe('Szerver oldali CTA')
    expect(row.narration).toBe(state.paidResult.result_json.narration)
    expect(row.platform).toBe('youtube_long')
    expect(row.user_id).toBe('user-1')
  })

  it('the paid result is looked up owner-scoped: getPaidResultById(session user, paid_result_id)', async () => {
    await post({ paid_result_id: PAID_RESULT_ID })
    expect(getPaidResultById).toHaveBeenCalledTimes(1)
    expect(getPaidResultById).toHaveBeenCalledWith('user-1', PAID_RESULT_ID)
  })
})

describe('POST /api/video-packages -- the 20 000-byte body limit is unchanged and still rejects the legacy full-result body', () => {
  it('a legacy-shaped body over 20 000 bytes is rejected with 400 before any lookup or write', async () => {
    const filler = (n: number) => 'á'.repeat(Math.floor(n / 4)) + 'a'.repeat(n - 2 * Math.floor(n / 4))
    const legacy = { paid_result_id: PAID_RESULT_ID, topic: 'x', narration: filler(6112), scene_structure: [filler(6194)], verified_fact_block_json: { a: filler(2911) }, description: filler(1976), broll_ideas: [filler(497)], timestamps: [filler(435)], hook: filler(191), cta: filler(203), title_variations: [filler(313)], sources: [filler(358)], sources_used: [filler(358)], hashtags: { a: filler(115) }, upload_times: { a: filler(154) }, caption: filler(184) }
    expect(new TextEncoder().encode(JSON.stringify(legacy)).length).toBeGreaterThan(20_000)
    const res = await post(legacy)
    expect(res.status).toBe(400)
    expect(getPaidResultById).not.toHaveBeenCalled()
    expect(state.inserts).toHaveLength(0)
  })

  it('the route source still uses the DEFAULT limit (no raised maxBytes argument)', () => {
    const src = readFileSync(path.resolve(__dirname, '..', 'app', 'api', 'video-packages', 'route.ts'), 'utf8').replace(/\r\n/g, '\n')
    const postBlock = src.slice(src.indexOf('export async function POST'), src.indexOf('export async function DELETE'))
    expect(postBlock).toContain('isJsonWithinLimit(requestBody)')
    expect(postBlock).not.toMatch(/isJsonWithinLimit\(requestBody\s*,/)
    const validation = readFileSync(path.resolve(__dirname, '..', 'lib', 'api-input-validation.ts'), 'utf8')
    expect(validation).toMatch(/isJsonWithinLimit\(value: unknown, maxBytes = 20_000\)/)
  })
})

describe('POST /api/video-packages -- validation and authorization', () => {
  it.each([
    ['no paid_result_id', {}],
    ['paid_result_id not a string', { paid_result_id: 42 }],
    ['paid_result_id not a UUID', { paid_result_id: 'not-a-uuid' }],
    ['array body', [PAID_RESULT_ID]],
    ['null body', null],
  ])('400 for %s: no lookup, no write', async (_name, body) => {
    const res = await post(body)
    expect(res.status).toBe(400)
    expect(getPaidResultById).not.toHaveBeenCalled()
    expect(state.inserts).toHaveLength(0)
  })

  it('401 when not logged in: no lookup, no write', async () => {
    state.user = null
    const res = await post({ paid_result_id: PAID_RESULT_ID })
    expect(res.status).toBe(401)
    expect(getPaidResultById).not.toHaveBeenCalled()
    expect(state.inserts).toHaveLength(0)
  })

  it('404 when the paid result is not the caller\'s / does not exist (getPaidResultById -> null): no write', async () => {
    state.paidResult = null
    const res = await post({ paid_result_id: PAID_RESULT_ID })
    expect(res.status).toBe(404)
    expect(state.inserts).toHaveLength(0)
  })

  it('404 for a paid result of another tool (not video_package): no write', async () => {
    state.paidResult = paidResultRow({ tool_type: 'title_studio' })
    const res = await post({ paid_result_id: PAID_RESULT_ID })
    expect(res.status).toBe(404)
    expect(state.inserts).toHaveLength(0)
  })

  it('422 when the stored result lacks topic / hook / narration: no write', async () => {
    state.paidResult = paidResultRow({ result_json: { topic: 'x' } })
    const res = await post({ paid_result_id: PAID_RESULT_ID })
    expect(res.status).toBe(422)
    expect(state.inserts).toHaveLength(0)
  })
})

describe('POST /api/video-packages -- saving never regenerates and never charges', () => {
  it('success path: no rpc call at all, and no credit / ledger / paid_results / usage table is touched; only video_packages is written', async () => {
    const res = await post({ paid_result_id: PAID_RESULT_ID })
    expect(res.status).toBe(200)
    expect(state.rpc).not.toHaveBeenCalled()
    for (const table of FORBIDDEN_TABLES) expect(state.tables).not.toContain(table)
    expect(state.inserts.map(i => i.table)).toEqual(['video_packages'])
  })

  it('failure paths (400 / 404 / 500) also never call rpc or touch credit tables', async () => {
    await post({})
    state.paidResult = null
    await post({ paid_result_id: PAID_RESULT_ID })
    state.paidResult = paidResultRow()
    state.insertResult = { data: null, error: { message: 'db down' } }
    const res = await post({ paid_result_id: PAID_RESULT_ID })
    expect(res.status).toBe(500)
    expect(state.rpc).not.toHaveBeenCalled()
    for (const table of FORBIDDEN_TABLES) expect(state.tables).not.toContain(table)
  })

  it('the route source imports no AI provider, credit or generation module', () => {
    const src = readFileSync(path.resolve(__dirname, '..', 'app', 'api', 'video-packages', 'route.ts'), 'utf8')
    const imports = src.split('\n').filter(l => l.startsWith('import '))
    for (const line of imports) {
      expect(line).not.toMatch(/credits|ai-provider|callAIProvider|video-package'|generateCreativeCore|generatePackaging|atomic-charge-save/)
    }
  })

  it('workflow-link failure after the insert compensates by deleting the saved row and returns 500 (existing behaviour, pinned)', async () => {
    state.ideaResult = { success: false, error: 'x' }
    const res = await post({ paid_result_id: PAID_RESULT_ID })
    expect(res.status).toBe(500)
    expect(state.deletes).toEqual(['video_packages'])
    expect(state.rpc).not.toHaveBeenCalled()
  })
})

// Review-lelet (negatív kontroll): az INSERT UTÁNI 500-as ág. A route a workflow-lépések (ensureVideoIdea / link /
// markReady) hibája esetén az insert után 500-at ad, és a kompenzáló DELETE eredményét NEM ellenőrzi -- tehát az 500
// mögött a video_packages sor megmaradhat. A kliens ezért nem tekintheti az 500-at "nem történt mentés"-nek.
import { PRE_WRITE_HTTP_STATUSES, isDefinitelyNotWritten } from '@/lib/paid-results/video-package-save-client'

describe('POST /api/video-packages -- NEGATIVE CONTROL: a 500 after the insert can leave a saved row, so it is never retry-safe', () => {
  const failures: Array<[string, () => void]> = [
    ['ensureVideoIdea fails', () => { state.ideaResult = { success: false, error: 'x' } }],
    ['linkVideoIdeaToLegacyRecord fails', () => { state.linkResult = { success: false, error: 'x' } }],
    ['markVideoIdeaReadyToProduce fails', () => { state.readyResult = { success: false, error: 'x' } }],
  ]

  it.each(failures)('%s + the compensating DELETE returns an error: 500, the insert happened, the row is NOT removed', async (_name, arrange) => {
    arrange()
    state.deleteOutcome = () => ({ error: { message: 'delete failed' } })
    const res = await post({ paid_result_id: PAID_RESULT_ID })

    expect(res.status).toBe(500)
    expect(state.inserts.map(i => i.table)).toEqual(['video_packages']) // a row WAS written ...
    expect(state.deletes).toEqual(['video_packages']) // ... the compensation was attempted ...
    // ... and the route neither inspects the delete result nor reports it: the response is the same plain 500
    expect(await res.json()).toEqual({ error: 'A videócsomag workflow-kapcsolata nem menthető.' })
    // therefore the client must treat this exact status as "possibly saved"
    expect(isDefinitelyNotWritten(res.status)).toBe(false)
  })

  it.each(failures)('%s + the compensating DELETE throws: the route rejects (platform 500), after the insert already happened', async (_name, arrange) => {
    arrange()
    state.deleteOutcome = () => { throw new Error('connection reset') }
    await expect(post({ paid_result_id: PAID_RESULT_ID })).rejects.toThrow('connection reset')
    expect(state.inserts.map(i => i.table)).toEqual(['video_packages'])
  })

  it('the insert itself failing is also a 500 (no row), yet the client cannot tell it apart from the cases above -> not retry-safe either', async () => {
    state.insertResult = { data: null, error: { message: 'db down' } }
    const res = await post({ paid_result_id: PAID_RESULT_ID })
    expect(res.status).toBe(500)
    expect(isDefinitelyNotWritten(res.status)).toBe(false)
  })

  it('CONTRACT: every status the route returns AFTER a video_packages insert is outside the pre-write allow-list; every pre-insert status is inside it', async () => {
    const afterInsert: number[] = []
    const beforeInsert: number[] = []
    const scenarios: Array<() => void> = [
      () => { state.ideaResult = { success: false, error: 'x' } },
      () => { state.linkResult = { success: false, error: 'x' } },
      () => { state.readyResult = { success: false, error: 'x' } },
      () => { state.ideaResult = { success: false, error: 'x' }; state.deleteOutcome = () => ({ error: { message: 'delete failed' } }) },
    ]
    for (const arrange of scenarios) {
      state.inserts.length = 0
      state.ideaResult = { success: true, idea: { id: 'idea-1' } }; state.linkResult = { success: true }; state.readyResult = { success: true }
      state.deleteOutcome = () => ({ error: null })
      arrange()
      const res = await post({ paid_result_id: PAID_RESULT_ID })
      if (state.inserts.length > 0 && res.status !== 200) afterInsert.push(res.status)
    }
    for (const arrange of [() => { state.user = null }, () => { state.paidResult = null }, () => { state.paidResult = paidResultRow({ result_json: { topic: 'x' } }) }]) {
      state.user = { id: 'user-1' }; state.paidResult = paidResultRow(); state.inserts.length = 0
      arrange()
      const res = await post({ paid_result_id: PAID_RESULT_ID })
      expect(state.inserts).toHaveLength(0)
      beforeInsert.push(res.status)
    }
    beforeInsert.push((await post({})).status)

    expect(afterInsert.length).toBe(scenarios.length)
    for (const status of afterInsert) expect(PRE_WRITE_HTTP_STATUSES).not.toContain(status)
    expect([...new Set(beforeInsert)].sort()).toEqual([400, 401, 404, 422])
    for (const status of beforeInsert) expect(PRE_WRITE_HTTP_STATUSES).toContain(status)
  })
})
