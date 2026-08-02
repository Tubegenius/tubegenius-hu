// Emerging Signal capture — REAL local DB integration tests.
//
// Ezek a tesztek a MEGLEVO, futo lokalis Supabase Docker stacket hasznaljak
// (127.0.0.1:54321, demo anon/service_role kulcsok — nem production).
// Ha a stack nem elerheto, a teljes describe-blokk kontrolláltan
// KIHAGYODIK (nem hibazik), hogy a "teljes vitest" futas Docker nelkuli
// kornyezetben is zold maradjon — ez szandekos, dokumentalt tervezesi
// dontes (ld. PFM-2B zarojelentes).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// A dockerPsql/kapcsolt tesztek tobb valodi subprocess- es haloati
// korutforgast vegeznek (docker exec + PostgREST) — az alapertelmezett
// 5000ms vitest timeout tul szoros ehhez, novelve.
vi.setConfig({ testTimeout: 20000 })
import { execSync } from 'child_process'

const LOCAL_URL = 'http://127.0.0.1:54321'
const LOCAL_SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'

// Stdin-en at adjuk at az SQL-t (`docker exec -i ... -f -`) — egyetlen
// subprocess-hivas kerdesenkent, NINCS shell-idezojelezes az SQL-en
// belul (nincs utkozes a backslash-escape-ekkel, pl. `like 'signal\_%'`).
function dockerPsql(sql: string): string {
  return execSync('docker exec -i supabase_db_WillViralFinal psql -U postgres -d postgres -t -A -f -', {
    input: sql,
    encoding: 'utf-8',
  })
}

let stackAvailable = false
try {
  dockerPsql('select 1;')
  stackAvailable = true
} catch {
  stackAvailable = false
}

const describeIfLocalDb = stackAvailable ? describe : describe.skip

describeIfLocalDb('emerging-signal capture — local DB integration (real Supabase Docker stack)', () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = LOCAL_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = LOCAL_SERVICE_ROLE_KEY
  })

  afterAll(() => {
    // Best-effort teljes takaritas — a service_role-nak NINCS DELETE joga
    // (szandekosan, ld. 049-053 grant-matrix), ezert a takaritas a Postgres
    // superuseren (docker exec) keresztul tortenik, NEM az alkalmazas-
    // kliensen keresztul.
    dockerPsql(`
      truncate table signal_cluster_evidence, signal_run_clusters, signal_observations,
        signal_evidence, signal_cluster_members, signal_clusters, signal_sources,
        signal_entities, signal_runs cascade;
      delete from youtube_videos where video_id like 'esdbit-%';
    `)
  })

  function makeCandidate(overrides: Record<string, unknown> = {}) {
    return {
      id: 'cand-esdbit-1',
      candidate_topic: 'ESDBIT teszt téma',
      candidate_topic_en: 'ESDBIT test topic',
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
        videoId: 'esdbit-vid1', title: 'ESDBIT Video', channelTitle: 'ESDBIT Channel', channelId: 'esdbit-UC1',
        publishedAt: '2026-08-01T00:00:00.000Z', viewCount: 1234, likeCount: 56, commentCount: 7,
        thumbnailUrl: '', description: 'desc', relevance_score: 80, region_relevance: 90, is_region_relevant: true,
        relevance_signals: [], market_label: 'hungarian_market',
      }],
      web_sources: [{ title: 'ESDBIT Article', link: 'https://esdbit-example.test/article-1', snippet: 'snippet' }],
      seed_keyword: 'esdbit seed',
      market_type: 'hungarian_market',
      ...overrides,
    }
  }

  it('a single candidate is fully captured: run completed, cluster, evidence, cluster_evidence links, observations, run_cluster all present — entities/membership intentionally empty (PFM-2C: no proxy entity extraction)', async () => {
    const { captureOpportunitySignals } = await import('@/lib/emerging-signal/capture')
    const result = await captureOpportunitySignals({ requestId: 'esdbit-req-single', candidates: [makeCandidate()] as any })

    expect(result.outcome).toBe('completed')
    expect(result.clustersCompleted).toBe(1)
    expect(result.runId).toBeTruthy()

    const runRow = dockerPsql(`select status from signal_runs where idempotency_key='opportunity:esdbit-req-single';`).trim()
    expect(runRow).toBe('completed')

    const clusterCount = dockerPsql(`select count(*) from signal_clusters where primary_label='ESDBIT teszt téma';`).trim()
    expect(clusterCount).toBe('1')

    // PFM-2C: az elso shadow writer NEM ir entitast/tagsagot — a korabbi
    // fabrikalt (entity_type='other', match_confidence=60) proxy-sorok
    // megszuntek.
    const memberCount = dockerPsql(`
      select count(*) from signal_cluster_members m
      join signal_clusters c on c.id = m.signal_cluster_id
      where c.primary_label='ESDBIT teszt téma';
    `).trim()
    expect(memberCount).toBe('0')
    const entityCount = dockerPsql(`select count(*) from signal_entities;`).trim()
    expect(entityCount).toBe('0')

    const evidenceCount = dockerPsql(`select count(*) from signal_evidence where external_ref in ('esdbit-vid1', 'https://esdbit-example.test/article-1');`).trim()
    expect(evidenceCount).toBe('2')

    // Klaszterfuggetlen evidence (054-es migracio) — a kapcsolat kizarolag
    // signal_cluster_evidence-ben el, egy join-sor mindket evidence-re.
    const clusterEvidenceCount = dockerPsql(`
      select count(*) from signal_cluster_evidence ce
      join signal_evidence e on e.id = ce.signal_evidence_id
      join signal_clusters c on c.id = ce.signal_cluster_id
      where c.primary_label='ESDBIT teszt téma' and e.external_ref in ('esdbit-vid1', 'https://esdbit-example.test/article-1');
    `).trim()
    expect(clusterEvidenceCount).toBe('2')

    const relationTypes = dockerPsql(`select distinct relation_type from signal_cluster_evidence;`).trim()
    expect(relationTypes).toBe('supports')
    const relationConfidence = dockerPsql(`select count(*) from signal_cluster_evidence where relation_confidence is not null;`).trim()
    expect(relationConfidence).toBe('0')

    const observationCount = dockerPsql(`
      select count(*) from signal_observations o
      join signal_evidence e on e.id = o.signal_evidence_id
      where e.external_ref = 'esdbit-vid1';
    `).trim()
    expect(observationCount).toBe('3') // view+like+comment

    const runClusterStatus = dockerPsql(`
      select rc.check_status from signal_run_clusters rc
      join signal_clusters c on c.id = rc.signal_cluster_id
      where c.primary_label='ESDBIT teszt téma';
    `).trim()
    expect(runClusterStatus).toBe('completed')
  })

  it('multiple candidates in one request are all captured under the same run', async () => {
    const { captureOpportunitySignals } = await import('@/lib/emerging-signal/capture')
    const result = await captureOpportunitySignals({
      requestId: 'esdbit-req-multi',
      candidates: [
        makeCandidate({ id: 'cand-esdbit-m1', candidate_topic: 'ESDBIT multi téma 1', candidate_topic_en: 'ESDBIT multi topic 1', seed_keyword: 'esdbit multi seed 1', source_videos: [], web_sources: [] }),
        makeCandidate({ id: 'cand-esdbit-m2', candidate_topic: 'ESDBIT multi téma 2', candidate_topic_en: 'ESDBIT multi topic 2', seed_keyword: 'esdbit multi seed 2', source_videos: [], web_sources: [] }),
      ] as any,
    })
    expect(result.outcome).toBe('completed')
    expect(result.clustersCompleted).toBe(2)

    const runClusterCount = dockerPsql(`
      select count(*) from signal_run_clusters rc join signal_runs r on r.id = rc.signal_run_id
      where r.idempotency_key = 'opportunity:esdbit-req-multi';
    `).trim()
    expect(runClusterCount).toBe('2')
  })

  it('the same requestId called twice: second call is a clean no-op (already_completed), no new rows', async () => {
    const { captureOpportunitySignals } = await import('@/lib/emerging-signal/capture')
    const first = await captureOpportunitySignals({ requestId: 'esdbit-req-noop', candidates: [makeCandidate({ id: 'cand-esdbit-noop', candidate_topic: 'ESDBIT noop téma', candidate_topic_en: 'ESDBIT noop topic', seed_keyword: 'esdbit noop seed' })] as any })
    expect(first.outcome).toBe('completed')

    const clusterCountBefore = dockerPsql(`select count(*) from signal_clusters where primary_label='ESDBIT noop téma';`).trim()

    const second = await captureOpportunitySignals({ requestId: 'esdbit-req-noop', candidates: [makeCandidate({ id: 'cand-esdbit-noop', candidate_topic: 'ESDBIT noop téma', candidate_topic_en: 'ESDBIT noop topic', seed_keyword: 'esdbit noop seed' })] as any })
    expect(second.outcome).toBe('already_completed')
    expect(second.clustersCompleted).toBe(0)

    const clusterCountAfter = dockerPsql(`select count(*) from signal_clusters where primary_label='ESDBIT noop téma';`).trim()
    expect(clusterCountAfter).toBe(clusterCountBefore)
    expect(clusterCountAfter).toBe('1')
  })

  it('two different candidates that normalize to the SAME fingerprint converge on one cluster row (sequential — true concurrency was already proven at the DB layer in PFM-2A)', async () => {
    const { captureOpportunitySignals } = await import('@/lib/emerging-signal/capture')
    const shared = { candidate_topic_en: 'ESDBIT convergence topic', seed_keyword: 'esdbit convergence seed', category: 'tech_ai' }
    await captureOpportunitySignals({ requestId: 'esdbit-req-conv-a', candidates: [makeCandidate({ id: 'cand-esdbit-conv-a', ...shared, candidate_topic: 'Different HU label A' })] as any })
    await captureOpportunitySignals({ requestId: 'esdbit-req-conv-b', candidates: [makeCandidate({ id: 'cand-esdbit-conv-b', ...shared, candidate_topic: 'Different HU label B' })] as any })

    // FONTOS: a signal_clusters upsert VALODI ON CONFLICT DO UPDATE-et hasznal
    // (a tabla grantja engedi az UPDATE-et), tehat a masodik hivas felulirja
    // az elso primary_label-jet 'Different HU label B'-re — ez szandekos,
    // dokumentalt viselkedes, NEM hiba. Ezert a konvergenciat NEM egy
    // konkret (esetleg mar felulirt) label alapjan ellenorizzuk, hanem
    // aszerint, hogy a KET candidate topikja EGYUTT hany klaszter-sorra
    // kepezodik le (varhatoan pontosan 1, barmelyik label "nyert").
    const clusterCount = dockerPsql(`
      select count(*) from signal_clusters where primary_label in ('Different HU label A', 'Different HU label B');
    `).trim()
    expect(clusterCount).toBe('1')
  })

  it('a failed run (partial failure) can be safely retried with the same requestId and reaches completed', async () => {
    const { captureOpportunitySignals } = await import('@/lib/emerging-signal/capture')
    // candidate_topic ures, DE candidate_topic_en kitoltott -> a fingerprint
    // sikeres (topicSource=candidateTopicEn), DE a primary_label (=
    // candidate_topic) ures marad -> signal_clusters_primary_label_not_blank
    // CHECK megsérti -> a candidate feldolgozasa 'failed', a teljes run 'failed'.
    const broken = makeCandidate({ id: 'cand-esdbit-retry', candidate_topic: '', candidate_topic_en: 'ESDBIT retry topic', seed_keyword: 'esdbit retry seed' })
    const firstAttempt = await captureOpportunitySignals({ requestId: 'esdbit-req-retry', candidates: [broken] as any })
    expect(firstAttempt.outcome).toBe('failed')

    const statusAfterFail = dockerPsql(`select status from signal_runs where idempotency_key='opportunity:esdbit-req-retry';`).trim()
    expect(statusAfterFail).toBe('failed')

    // Retry ugyanazzal a requestId-vel, most mar ervenyes candidate_topic-cal.
    const fixed = makeCandidate({ id: 'cand-esdbit-retry', candidate_topic: 'ESDBIT retry topic fixed', candidate_topic_en: 'ESDBIT retry topic', seed_keyword: 'esdbit retry seed' })
    const retryAttempt = await captureOpportunitySignals({ requestId: 'esdbit-req-retry', candidates: [fixed] as any })
    expect(retryAttempt.outcome).toBe('completed')

    const statusAfterRetry = dockerPsql(`select status from signal_runs where idempotency_key='opportunity:esdbit-req-retry';`).trim()
    expect(statusAfterRetry).toBe('completed')

    // Csak EGY signal_runs sor tartozik ehhez az idempotency_key-hez a retry utan is.
    const runRowCount = dockerPsql(`select count(*) from signal_runs where idempotency_key='opportunity:esdbit-req-retry';`).trim()
    expect(runRowCount).toBe('1')
  })

  // ── 054-es migracio: signal_cluster_evidence N:M ─────────────────────

  it('one evidence linked from two different candidates (same video, different topic/seed -> different fingerprint) produces TWO signal_cluster_evidence rows for the SAME evidence', async () => {
    const { captureOpportunitySignals } = await import('@/lib/emerging-signal/capture')
    const sharedVideo = { videoId: 'esdbit-dual-vid', title: 'ESDBIT Dual Video', channelTitle: 'ESDBIT Channel', channelId: 'esdbit-UC-dual', publishedAt: '2026-08-01T00:00:00.000Z', viewCount: 5, likeCount: 1, commentCount: 0, thumbnailUrl: '', description: 'desc', relevance_score: 80, region_relevance: 90, is_region_relevant: true, relevance_signals: [], market_label: 'hungarian_market' }
    const result = await captureOpportunitySignals({
      requestId: 'esdbit-req-dual-cluster',
      candidates: [
        makeCandidate({ id: 'cand-esdbit-dual-a', candidate_topic: 'ESDBIT dual A', candidate_topic_en: 'ESDBIT dual topic A', seed_keyword: 'esdbit dual seed a', source_videos: [sharedVideo], web_sources: [] }),
        makeCandidate({ id: 'cand-esdbit-dual-b', candidate_topic: 'ESDBIT dual B', candidate_topic_en: 'ESDBIT dual topic B', seed_keyword: 'esdbit dual seed b', source_videos: [sharedVideo], web_sources: [] }),
      ] as any,
    })
    expect(result.outcome).toBe('completed')
    expect(result.clustersCompleted).toBe(2)

    const evidenceRowCount = dockerPsql(`select count(*) from signal_evidence where external_ref = 'esdbit-dual-vid';`).trim()
    expect(evidenceRowCount).toBe('1') // egyetlen evidence-azonossag, klaszterfuggetlen

    const clusterCountForEvidence = dockerPsql(`
      select count(distinct ce.signal_cluster_id) from signal_cluster_evidence ce
      join signal_evidence e on e.id = ce.signal_evidence_id
      where e.external_ref = 'esdbit-dual-vid';
    `).trim()
    expect(clusterCountForEvidence).toBe('2')

    const joinRowCount = dockerPsql(`
      select count(*) from signal_cluster_evidence ce
      join signal_evidence e on e.id = ce.signal_evidence_id
      where e.external_ref = 'esdbit-dual-vid';
    `).trim()
    expect(joinRowCount).toBe('2')
  })

  it('the same evidence + same cluster retried across two separate runs converges on exactly ONE signal_cluster_evidence row', async () => {
    const { captureOpportunitySignals } = await import('@/lib/emerging-signal/capture')
    const uniqueVideo = { videoId: 'esdbit-retryjoin-vid', title: 'ESDBIT retry-join video', channelTitle: 'ESDBIT Channel', channelId: 'esdbit-UC-retryjoin', publishedAt: '2026-08-01T00:00:00.000Z', viewCount: 1, likeCount: 0, commentCount: 0, thumbnailUrl: '', description: 'desc', relevance_score: 80, region_relevance: 90, is_region_relevant: true, relevance_signals: [], market_label: 'hungarian_market' }
    const sameCandidate = () => makeCandidate({ id: 'cand-esdbit-retry-join', candidate_topic: 'ESDBIT retry-join téma', candidate_topic_en: 'ESDBIT retry-join topic', seed_keyword: 'esdbit retry-join seed', source_videos: [uniqueVideo], web_sources: [] })

    const first = await captureOpportunitySignals({ requestId: 'esdbit-req-retry-join-1', candidates: [sameCandidate()] as any })
    expect(first.outcome).toBe('completed')
    const second = await captureOpportunitySignals({ requestId: 'esdbit-req-retry-join-2', candidates: [sameCandidate()] as any })
    expect(second.outcome).toBe('completed')

    const joinRowCount = dockerPsql(`
      select count(*) from signal_cluster_evidence ce
      join signal_evidence e on e.id = ce.signal_evidence_id
      where e.external_ref = 'esdbit-retryjoin-vid';
    `).trim()
    expect(joinRowCount).toBe('1')
  })

  it('deleting a cluster cascades its signal_cluster_evidence rows but leaves the evidence row intact', async () => {
    const { captureOpportunitySignals } = await import('@/lib/emerging-signal/capture')
    const result = await captureOpportunitySignals({ requestId: 'esdbit-req-cluster-delete', candidates: [makeCandidate({ id: 'cand-esdbit-cluster-delete', candidate_topic: 'ESDBIT cluster-delete téma', candidate_topic_en: 'ESDBIT cluster-delete topic', seed_keyword: 'esdbit cluster-delete seed', source_videos: [{ videoId: 'esdbit-clusterdel-vid', title: 'T', channelTitle: 'C', channelId: 'esdbit-UC-clusterdel', publishedAt: '2026-08-01T00:00:00.000Z', viewCount: 1, likeCount: 0, commentCount: 0, thumbnailUrl: '', description: '', relevance_score: 80, region_relevance: 90, is_region_relevant: true, relevance_signals: [], market_label: 'hungarian_market' }], web_sources: [] })] as any })
    expect(result.outcome).toBe('completed')

    const clusterId = dockerPsql(`select id from signal_clusters where primary_label='ESDBIT cluster-delete téma';`).trim()
    expect(clusterId).toBeTruthy()
    const evidenceId = dockerPsql(`select id from signal_evidence where external_ref='esdbit-clusterdel-vid';`).trim()
    expect(evidenceId).toBeTruthy()

    dockerPsql(`delete from signal_clusters where id = '${clusterId}';`)

    const joinAfter = dockerPsql(`select count(*) from signal_cluster_evidence where signal_cluster_id = '${clusterId}';`).trim()
    expect(joinAfter).toBe('0')
    const evidenceAfter = dockerPsql(`select count(*) from signal_evidence where id = '${evidenceId}';`).trim()
    expect(evidenceAfter).toBe('1')
  })

  it('deleting an evidence row cascades its signal_cluster_evidence rows but leaves the cluster intact', async () => {
    const { captureOpportunitySignals } = await import('@/lib/emerging-signal/capture')
    const result = await captureOpportunitySignals({ requestId: 'esdbit-req-evidence-delete', candidates: [makeCandidate({ id: 'cand-esdbit-evidence-delete', candidate_topic: 'ESDBIT evidence-delete téma', candidate_topic_en: 'ESDBIT evidence-delete topic', seed_keyword: 'esdbit evidence-delete seed', source_videos: [{ videoId: 'esdbit-evdel-vid', title: 'T', channelTitle: 'C', channelId: 'esdbit-UC-evdel', publishedAt: '2026-08-01T00:00:00.000Z', viewCount: 1, likeCount: 0, commentCount: 0, thumbnailUrl: '', description: '', relevance_score: 80, region_relevance: 90, is_region_relevant: true, relevance_signals: [], market_label: 'hungarian_market' }], web_sources: [] })] as any })
    expect(result.outcome).toBe('completed')

    const clusterId = dockerPsql(`select id from signal_clusters where primary_label='ESDBIT evidence-delete téma';`).trim()
    const evidenceId = dockerPsql(`select id from signal_evidence where external_ref='esdbit-evdel-vid';`).trim()
    expect(clusterId).toBeTruthy()
    expect(evidenceId).toBeTruthy()

    dockerPsql(`delete from signal_evidence where id = '${evidenceId}';`)

    const joinAfter = dockerPsql(`select count(*) from signal_cluster_evidence where signal_evidence_id = '${evidenceId}';`).trim()
    expect(joinAfter).toBe('0')
    const clusterAfter = dockerPsql(`select count(*) from signal_clusters where id = '${clusterId}';`).trim()
    expect(clusterAfter).toBe('1')
  })

  it('deleting the run referenced ONLY via linked_in_run_id (not as cluster/evidence creator) sets linked_in_run_id to NULL, row survives (schema-level FK proof via direct SQL — a writer-driven scenario cannot isolate this because created_by_run_id/discovered_in_run_id RESTRICT would block the delete first)', () => {
    dockerPsql(`
      insert into signal_runs (id, run_type, idempotency_key, status, completed_at)
      values
        ('11111111-1111-1111-1111-111111111101', 'shadow_batch', 'esdbit-fk-owner-run', 'completed', now()),
        ('11111111-1111-1111-1111-111111111102', 'shadow_batch', 'esdbit-fk-linked-run', 'completed', now());

      insert into signal_sources (id, source_type, external_id, source_family_key)
      values ('11111111-1111-1111-1111-111111111103', 'web_domain', 'esdbit-fk-test.example', 'esdbit-fk-test.example');

      insert into signal_clusters (id, primary_label, cluster_fingerprint, created_by_run_id)
      values ('11111111-1111-1111-1111-111111111104', 'ESDBIT FK test cluster', repeat('a', 64), '11111111-1111-1111-1111-111111111101');

      insert into signal_evidence (id, signal_source_id, evidence_type, external_ref, title, canonical_url, discovered_in_run_id)
      values ('11111111-1111-1111-1111-111111111105', '11111111-1111-1111-1111-111111111103', 'serper_web', 'https://esdbit-fk-test.example/a', 'FK test evidence', 'https://esdbit-fk-test.example/a', '11111111-1111-1111-1111-111111111101');

      insert into signal_cluster_evidence (id, signal_cluster_id, signal_evidence_id, linked_in_run_id)
      values ('11111111-1111-1111-1111-111111111106', '11111111-1111-1111-1111-111111111104', '11111111-1111-1111-1111-111111111105', '11111111-1111-1111-1111-111111111102');
    `)

    // A "linked" run NEM tulajdonosa semelyik clusternek/evidence-nek (azok
    // az "owner" runra hivatkoznak RESTRICT-tel) — igy torolheto.
    dockerPsql(`delete from signal_runs where id = '11111111-1111-1111-1111-111111111102';`)

    const linkedRunIdAfter = dockerPsql(`select coalesce(linked_in_run_id::text, 'NULL') from signal_cluster_evidence where id = '11111111-1111-1111-1111-111111111106';`).trim()
    expect(linkedRunIdAfter).toBe('NULL')
    const rowStillExists = dockerPsql(`select count(*) from signal_cluster_evidence where id = '11111111-1111-1111-1111-111111111106';`).trim()
    expect(rowStillExists).toBe('1')

    dockerPsql(`
      delete from signal_cluster_evidence where id = '11111111-1111-1111-1111-111111111106';
      delete from signal_evidence where id = '11111111-1111-1111-1111-111111111105';
      delete from signal_clusters where id = '11111111-1111-1111-1111-111111111104';
      delete from signal_sources where id = '11111111-1111-1111-1111-111111111103';
      delete from signal_runs where id = '11111111-1111-1111-1111-111111111101';
    `)
  })

  it('signal_cluster_evidence grant matrix: service_role INSERT+SELECT only, no UPDATE/DELETE, anon/authenticated forbidden', () => {
    const serviceGrants = dockerPsql(`
      select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants
      where table_schema='public' and table_name='signal_cluster_evidence' and grantee='service_role';
    `).trim()
    expect(serviceGrants).toBe('INSERT,SELECT')

    const forbidden = dockerPsql(`
      select count(*) from information_schema.role_table_grants
      where table_schema='public' and table_name='signal_cluster_evidence' and grantee in ('anon','authenticated');
    `).trim()
    expect(forbidden).toBe('0')
  })

  // ── Atomi run-claim, VALODI parhuzamossaggal ──────────────────────────

  it('two REAL concurrent new-run attempts with the same requestId: exactly one becomes the worker (completed), the other is a clean no-op', async () => {
    const { captureOpportunitySignals } = await import('@/lib/emerging-signal/capture')
    const cand = () => makeCandidate({ id: 'cand-esdbit-concurrent-new', candidate_topic: 'ESDBIT concurrent new téma', candidate_topic_en: 'ESDBIT concurrent new topic', seed_keyword: 'esdbit concurrent new seed' })

    const [a, b] = await Promise.all([
      captureOpportunitySignals({ requestId: 'esdbit-req-concurrent-new', candidates: [cand()] as any }),
      captureOpportunitySignals({ requestId: 'esdbit-req-concurrent-new', candidates: [cand()] as any }),
    ])

    const outcomes = [a.outcome, b.outcome]
    expect(outcomes.filter(o => o === 'completed')).toHaveLength(1)
    expect(outcomes.filter(o => o === 'already_in_progress' || o === 'already_completed')).toHaveLength(1)

    const runRowCount = dockerPsql(`select count(*) from signal_runs where idempotency_key='opportunity:esdbit-req-concurrent-new';`).trim()
    expect(runRowCount).toBe('1')
    const clusterRowCount = dockerPsql(`select count(*) from signal_clusters where primary_label='ESDBIT concurrent new téma';`).trim()
    expect(clusterRowCount).toBe('1')
  })

  it('two REAL concurrent retries of the SAME failed run: exactly one claims ownership and completes, no duplicate cluster', async () => {
    const { captureOpportunitySignals } = await import('@/lib/emerging-signal/capture')
    const broken = makeCandidate({ id: 'cand-esdbit-concurrent-retry', candidate_topic: '', candidate_topic_en: 'ESDBIT concurrent retry topic', seed_keyword: 'esdbit concurrent retry seed' })
    const first = await captureOpportunitySignals({ requestId: 'esdbit-req-concurrent-retry', candidates: [broken] as any })
    expect(first.outcome).toBe('failed')
    const statusAfterFail = dockerPsql(`select status from signal_runs where idempotency_key='opportunity:esdbit-req-concurrent-retry';`).trim()
    expect(statusAfterFail).toBe('failed')

    const fixed = () => makeCandidate({ id: 'cand-esdbit-concurrent-retry', candidate_topic: 'ESDBIT concurrent retry topic fixed', candidate_topic_en: 'ESDBIT concurrent retry topic', seed_keyword: 'esdbit concurrent retry seed' })
    const [a, b] = await Promise.all([
      captureOpportunitySignals({ requestId: 'esdbit-req-concurrent-retry', candidates: [fixed()] as any }),
      captureOpportunitySignals({ requestId: 'esdbit-req-concurrent-retry', candidates: [fixed()] as any }),
    ])

    const outcomes = [a.outcome, b.outcome]
    expect(outcomes.filter(o => o === 'completed')).toHaveLength(1)
    expect(outcomes.filter(o => o === 'already_in_progress' || o === 'already_completed')).toHaveLength(1)

    const statusAfter = dockerPsql(`select status from signal_runs where idempotency_key='opportunity:esdbit-req-concurrent-retry';`).trim()
    expect(statusAfter).toBe('completed')
    const runRowCount = dockerPsql(`select count(*) from signal_runs where idempotency_key='opportunity:esdbit-req-concurrent-retry';`).trim()
    expect(runRowCount).toBe('1')
    const clusterRowCount = dockerPsql(`select count(*) from signal_clusters where primary_label like 'ESDBIT concurrent retry topic fixed%';`).trim()
    expect(clusterRowCount).toBe('1')
  })

  it('constraint/grant/RLS remained intact after writer activity (re-checks the 053-style invariants)', () => {
    const rlsBad = dockerPsql(`
      select count(*) from pg_tables where schemaname='public' and tablename like 'signal\\_%' escape '\\' and rowsecurity is not true;
    `).trim()
    expect(rlsBad).toBe('0')

    const forbiddenGrants = dockerPsql(`
      select count(*) from information_schema.role_table_grants
      where table_schema='public' and table_name like 'signal\\_%' escape '\\' and grantee in ('anon','authenticated');
    `).trim()
    expect(forbiddenGrants).toBe('0')

    const deleteGrants = dockerPsql(`
      select count(*) from information_schema.role_table_grants
      where table_schema='public' and table_name like 'signal\\_%' escape '\\' and grantee='service_role' and privilege_type='DELETE';
    `).trim()
    expect(deleteGrants).toBe('0')
  })
})
