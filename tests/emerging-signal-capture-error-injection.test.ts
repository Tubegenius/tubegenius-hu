// Emerging Signal capture — full error-injection matrix (PFM-2C, 6. pont).
//
// Minden DB-iras/olvasas lepesnel KULON injektalunk hibat, es minden
// esetben igazoljuk: captureOpportunitySignals() SOHA nem dob (mindig egy
// eredmeny-objektumot ad vissza), completed KIZAROLAG teljes siker eseten,
// nincs sem "csendes" reszleges siker, es az eredmeny-objektum SOHA nem
// tartalmaz nyers hibauzenetet/stack trace-t/API-kulcsot (a tipus maga is
// csak fix enumokat + szamokat/UUID-kat enged, de ezt futasidoben is
// ellenorizzuk).
//
// A "nincs extra kredit / nincs extra kulso API-hivas" invarianst NEM ezen
// a fajlon belul bizonyitjuk ujra — az mar strukturalisan garantalt es
// bizonyitott (ld. tests/emerging-signal-zero-external-calls.test.ts
// statikus import-audit + a route try/catch bekotese, ld.
// tests/opportunity-route-emerging-signal-regression.test.ts "response
// payload/status identikus siker/hiba eseten" teszt). Ez a fajl kizarolag
// a capture modul SAJAT hibakezeleset teszteli, izolaltan, mockolt DB-vel.
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase-server', () => ({ createAdminClient: vi.fn() }))

import { createAdminClient } from '@/lib/supabase-server'

const mockedCreateAdminClient = vi.mocked(createAdminClient)

type FailPoint =
  | 'run_insert'
  | 'run_claim'
  | 'run_final_update'
  | 'source'
  | 'cluster'
  | 'evidence_upsert'
  | 'evidence_select'
  | 'cluster_evidence'
  | 'observation'
  | 'run_cluster'
  | null

const INJECTED_ERROR = { code: 'XXTEST', message: 'injected test failure', details: null, hint: null }

// Egy "boldog ut" mock-kliens, amely PONTOSAN a capture.ts altal hasznalt
// hivasi sorrendet koveti (ld. lib/emerging-signal/capture.ts), es a
// megadott `failPoint`-nel dob egy Supabase-stilusu { data: null, error }
// valaszt — mindenhol mashol sikeres, realisztikus alaku valaszt ad.
function makeAdmin(failPoint: FailPoint) {
  function terminal(role: FailPoint | 'run_select_existing' | 'run_fail_write', okData: unknown) {
    if (role === failPoint) return Promise.resolve({ data: null, error: INJECTED_ERROR })
    return Promise.resolve({ data: okData, error: null })
  }

  const from = vi.fn((table: string) => {
    if (table === 'signal_runs') {
      // Minden `.from('signal_runs')` hivas SAJAT, fuggetlen `role`
      // valtozot kap (a capture.ts a signal_runs tablat harom KULON,
      // egymast koveto `.from(...)` hivassal eri el: insert, esetleges
      // select-existing, esetleges claim-update — sosem ugyanazon a
      // chain-en). A `role` null-rol indul, es a chain ELSO erdemi
      // hivasa (insert/update/select) allitja be — kesobbi `.select()`
      // hivasok MAR nem irjak felul, ha a role mar be van allitva.
      const chain: any = {}
      let role: FailPoint | 'run_select_existing' | 'run_fail_write' | null = null
      chain.insert = vi.fn(() => { role = 'run_insert'; return chain })
      chain.update = vi.fn((patch: any) => {
        if (patch.status === 'started') role = 'run_claim'
        else if (patch.status === 'completed') role = 'run_final_update'
        else role = 'run_fail_write'
        return chain
      })
      chain.select = vi.fn(() => {
        if (role === null) role = 'run_select_existing'
        return chain
      })
      chain.eq = vi.fn(() => chain)
      chain.neq = vi.fn(() => chain)
      chain.single = vi.fn(() => {
        // A run_claim fail-point teszteleséhez az ELSO insert-kiserletet
        // egy UNIQUE-utkozessel kell "elbuktatni" (fuggetlenul attol,
        // hogy failPoint maga nem 'run_insert'), hogy ensureRun egyaltalan
        // eljusson a select-existing/claim agig.
        if (role === 'run_insert' && failPoint === 'run_claim') {
          return Promise.resolve({
            data: null,
            error: { code: '23505', message: 'duplicate key value violates unique constraint', details: null, hint: null },
          })
        }
        return terminal(role, { id: 'run-1', started_at: new Date().toISOString() })
      })
      chain.maybeSingle = vi.fn(() => {
        if (role === 'run_select_existing') {
          // A sor MAR 'failed' allapotban van — ensureRun innen a
          // feltetles claim-UPDATE-agra jut.
          return Promise.resolve({ data: { id: 'run-1', status: 'failed' }, error: null })
        }
        return terminal(role, { id: 'run-1', status: 'started' })
      })
      chain.then = (resolve: any) => {
        if (role === failPoint) return resolve({ data: null, error: INJECTED_ERROR })
        if (role === 'run_claim') return resolve({ data: [{ id: 'run-1', started_at: new Date().toISOString() }], error: null })
        return resolve({ data: null, error: null })
      }
      return chain
    }

    if (table === 'youtube_videos') {
      return { select: vi.fn(() => ({ in: vi.fn(() => Promise.resolve({ data: [], error: null })) })) }
    }

    if (table === 'signal_clusters') {
      const chain: any = {
        upsert: vi.fn(() => chain),
        select: vi.fn(() => chain),
        single: vi.fn(() => terminal('cluster', { id: 'cluster-1' })),
      }
      return chain
    }

    if (table === 'signal_sources') {
      const chain: any = {
        upsert: vi.fn(() => chain),
        select: vi.fn(() => chain),
        single: vi.fn(() => terminal('source', { id: 'source-1' })),
      }
      return chain
    }

    if (table === 'signal_evidence') {
      const chain: any = {}
      let role: 'evidence_upsert' | 'evidence_select' = 'evidence_upsert'
      chain.upsert = vi.fn(() => { role = 'evidence_upsert'; return chain })
      chain.select = vi.fn(() => { role = 'evidence_select'; return chain })
      chain.eq = vi.fn(() => chain)
      chain.maybeSingle = vi.fn(() => terminal('evidence_select', { id: 'evidence-1' }))
      chain.then = (resolve: any) => resolve(terminal('evidence_upsert', null))
      return chain
    }

    if (table === 'signal_cluster_evidence') {
      const chain: any = { upsert: vi.fn(() => chain), then: (resolve: any) => resolve(terminal('cluster_evidence', null)) }
      return chain
    }

    if (table === 'signal_observations') {
      const chain: any = { upsert: vi.fn(() => chain), then: (resolve: any) => resolve(terminal('observation', null)) }
      return chain
    }

    if (table === 'signal_run_clusters') {
      const chain: any = { upsert: vi.fn(() => chain), then: (resolve: any) => resolve(terminal('run_cluster', null)) }
      return chain
    }

    throw new Error(`unexpected table in error-injection mock: ${table}`)
  })

  return { from }
}

function makeCandidate(id: string) {
  return {
    id,
    candidate_topic: 'Injection téma',
    candidate_topic_en: 'Injection topic',
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
      videoId: 'inj-vid-1', title: 'Injection Video', channelTitle: 'Chan', channelId: 'UC-inj',
      publishedAt: '2026-08-01T00:00:00.000Z', viewCount: 10, likeCount: 1, commentCount: 0,
      thumbnailUrl: '', description: 'desc', relevance_score: 80, region_relevance: 90, is_region_relevant: true,
      relevance_signals: [], market_label: 'hungarian_market',
    }],
    web_sources: [{ title: 'Injection Article', link: 'https://injection.test/a', snippet: 's' }],
    seed_keyword: 'injection seed',
    market_type: 'hungarian_market',
  }
}

function assertNoSensitiveData(result: unknown) {
  const json = JSON.stringify(result)
  expect(json.toLowerCase()).not.toMatch(/api[_-]?key|secret|password|authorization/)
  expect(json).not.toMatch(/at .*\(.*:\d+:\d+\)/) // stack-trace alaku sor
  expect(json).not.toContain(INJECTED_ERROR.message)
}

describe('emerging-signal capture — full error-injection matrix', () => {
  beforeEach(() => {
    mockedCreateAdminClient.mockReset()
  })

  const failPoints: FailPoint[] = [
    'run_insert', 'run_claim', 'source', 'cluster', 'evidence_upsert',
    'evidence_select', 'cluster_evidence', 'observation', 'run_cluster', 'run_final_update',
  ]

  it.each(failPoints)('failure at "%s" never throws, and never reports a completed outcome', async (failPoint) => {
    mockedCreateAdminClient.mockReturnValue(makeAdmin(failPoint) as any)
    const { captureOpportunitySignals } = await import('@/lib/emerging-signal/capture')

    const result = await captureOpportunitySignals({
      requestId: `inj-req-${failPoint}`,
      candidates: [makeCandidate(`cand-inj-${failPoint}`)] as any,
    })

    expect(result.outcome).not.toBe('completed')
    expect(['failed', 'already_in_progress']).toContain(result.outcome)
    assertNoSensitiveData(result)
  })

  it('a fully healthy run (no injected failure) reaches completed — sanity baseline for the matrix above', async () => {
    mockedCreateAdminClient.mockReturnValue(makeAdmin(null) as any)
    const { captureOpportunitySignals } = await import('@/lib/emerging-signal/capture')

    const result = await captureOpportunitySignals({ requestId: 'inj-req-baseline', candidates: [makeCandidate('cand-inj-baseline')] as any })
    expect(result.outcome).toBe('completed')
    expect(result.clustersCompleted).toBe(1)
    assertNoSensitiveData(result)
  })

  it('failure at "cluster" (before any evidence/run_cluster row could exist) still returns a well-formed result with zero completed clusters', async () => {
    mockedCreateAdminClient.mockReturnValue(makeAdmin('cluster') as any)
    const { captureOpportunitySignals } = await import('@/lib/emerging-signal/capture')
    const result = await captureOpportunitySignals({ requestId: 'inj-req-cluster-2', candidates: [makeCandidate('cand-inj-cluster-2')] as any })
    expect(result.outcome).toBe('failed')
    expect(result.clustersCompleted).toBe(0)
    expect(result.clustersFailed).toBe(1)
  })

  it('failure at "run_final_update" still reports the run/cluster work that DID happen, but the outcome itself is not completed', async () => {
    mockedCreateAdminClient.mockReturnValue(makeAdmin('run_final_update') as any)
    const { captureOpportunitySignals } = await import('@/lib/emerging-signal/capture')
    const result = await captureOpportunitySignals({ requestId: 'inj-req-final', candidates: [makeCandidate('cand-inj-final')] as any })
    expect(result.outcome).toBe('failed')
    expect(result.runId).toBe('run-1')
    expect(result.clustersCompleted).toBe(1)
  })

  it('failure at "run_insert" (unexpected, non-23505 DB error) yields failed with a null runId — no row was ever claimed', async () => {
    mockedCreateAdminClient.mockReturnValue(makeAdmin('run_insert') as any)
    const { captureOpportunitySignals } = await import('@/lib/emerging-signal/capture')
    const result = await captureOpportunitySignals({ requestId: 'inj-req-run-insert', candidates: [makeCandidate('cand-inj-run-insert')] as any })
    expect(result.outcome).toBe('failed')
    expect(result.runId).toBeNull()
  })

  it('failure at "run_claim" (retrying a failed run whose conditional UPDATE itself errors) yields failed with a null runId — never silently claims', async () => {
    mockedCreateAdminClient.mockReturnValue(makeAdmin('run_claim') as any)
    const { captureOpportunitySignals } = await import('@/lib/emerging-signal/capture')
    const result = await captureOpportunitySignals({ requestId: 'inj-req-run-claim', candidates: [makeCandidate('cand-inj-run-claim')] as any })
    expect(result.outcome).toBe('failed')
    expect(result.runId).toBeNull()
  })
})
