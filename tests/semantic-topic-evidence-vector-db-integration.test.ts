// Semantic Topic Identity v0 -- scalar-free evidence support vector
// (migration 085, public.compute_topic_evidence_vector), REAL local DB
// integration tests. Same pattern as the 072/073/078 suites: uses the
// existing local Docker Supabase stack (supabase_db_WillViralFinal), skips
// entirely (not a failure) when unavailable, SET ROLE for real
// grant-boundary proofs, only synthetic/deterministic fixtures -- no
// AI/provider call, no production data.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 60000 })
import { execSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const MIGRATION_085_PATH = join(process.cwd(), 'supabase/migrations/085_semantic_topic_evidence_vector.sql')

function dockerPsql(sql: string): string {
  return execSync('docker exec -i supabase_db_WillViralFinal psql -U postgres -d postgres -t -A -q -v ON_ERROR_STOP=1 -f -', {
    input: sql,
    encoding: 'utf-8',
  })
}

function dockerPsqlExpectError(sql: string): string {
  try {
    execSync('docker exec -i supabase_db_WillViralFinal psql -U postgres -d postgres -t -A -q -v ON_ERROR_STOP=1 -f -', {
      input: sql,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return '__NO_ERROR__'
  } catch (e: any) {
    return String(e.stderr || e.stdout || e.message || '')
  }
}

// TRUE async/parallel variant -- spawn (not execSync) so two calls issued via
// Promise.all actually run as two independent OS processes / two
// independent Postgres connections at the same time -- needed for the
// concurrent-read-consistency test below.
function dockerPsqlAsync(sql: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['exec', '-i', 'supabase_db_WillViralFinal', 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'])
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('close', (code) => resolve({ ok: code === 0, out: code === 0 ? stdout : stderr || stdout }))
    child.stdin.write(sql)
    child.stdin.end()
  })
}

function runMigration(path: string): { out: string; threw: boolean } {
  const migrationSql = readFileSync(path, 'utf8')
  try {
    const out = execSync(
      'docker exec -i supabase_db_WillViralFinal psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 -t -A -f - 2>&1',
      { input: migrationSql, encoding: 'utf8' },
    )
    return { out, threw: false }
  } catch (e: any) {
    return { out: String(e.stdout || e.stderr || e.message || ''), threw: true }
  }
}

let stackAvailable = false
try {
  dockerPsql('select 1;')
  stackAvailable = true
} catch {
  stackAvailable = false
}

const describeIfLocalDb = stackAvailable ? describe : describe.skip

const MARKER = 'sti-tev'

function randomHexDigest(): string {
  let s = ''
  while (s.length < 64) s += Math.floor(Math.random() * 16).toString(16)
  return s
}

let fixtureCounter = 0
function nextMarker(): string {
  fixtureCounter += 1
  return `${MARKER}-${Date.now()}-${fixtureCounter}`
}

function ensureFullyApplied() {
  const out = dockerPsql(
    `select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='compute_topic_evidence_vector';`,
  ).trim()
  if (out !== '1') {
    const r = runMigration(MIGRATION_085_PATH)
    if (r.threw) throw new Error(`ensureFullyApplied: 085 failed -- ${r.out}`)
  }
}

function cleanupTestData() {
  dockerPsql(`
    delete from semantic_topic_membership where semantic_topic_id in (select id from semantic_topics where canonical_label like '${MARKER} topic%') or signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');
    delete from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like '${MARKER}-%');
    delete from signal_evidence where external_ref like '${MARKER}-%';
    delete from semantic_topics where canonical_label like '${MARKER} topic%';
    delete from signal_sources where external_id like '${MARKER}-%';
    delete from signal_runs where idempotency_key like '${MARKER}-%';
    delete from youtube_videos where video_id like '${MARKER}-%';
  `)
}

function insertFixtureSource(externalId: string): string {
  return dockerPsql(`insert into signal_sources (source_type, external_id, source_family_key) values ('youtube_channel', '${externalId}', '${externalId}') returning id;`).trim()
}
function insertFixtureRun(idempotencyKey: string): string {
  return dockerPsql(`insert into signal_runs (run_type, idempotency_key, status, completed_at) values ('shadow_batch', '${idempotencyKey}', 'completed', now()) returning id;`).trim()
}
function insertYoutubeVideo(videoId: string, channelId: string): void {
  dockerPsql(`insert into youtube_videos(video_id, title, channel_id) values ('${videoId}', 'fixture video', '${channelId}') on conflict (video_id) do nothing;`)
}

// "Known source" evidence -- a youtube_video evidence row whose
// youtube_videos_ref resolves (via youtube_videos.video_id) to a row with a
// non-null channel_id.
function insertKnownEvidence(marker: string, channelId: string, canonicalUrl: string | null = null): string {
  const sourceId = insertFixtureSource(`${marker}-src`)
  const runId = insertFixtureRun(`${marker}-run`)
  const videoId = `${marker}-vid`
  insertYoutubeVideo(videoId, channelId)
  const canonicalSql = canonicalUrl === null ? 'NULL' : `'${canonicalUrl}'`
  return dockerPsql(`
    insert into signal_evidence (signal_source_id, evidence_type, external_ref, title, discovered_in_run_id, youtube_videos_ref, canonical_url)
    values ('${sourceId}', 'youtube_video', '${marker}-ev', '${MARKER} fixture evidence', '${runId}', '${videoId}', ${canonicalSql})
    returning id;
  `).trim()
}

// "Unknown source" evidence -- no youtube_videos_ref at all, so the LEFT
// JOIN inside the RPC resolves to a NULL channel_id.
function insertUnknownEvidence(marker: string): string {
  const sourceId = insertFixtureSource(`${marker}-src`)
  const runId = insertFixtureRun(`${marker}-run`)
  return dockerPsql(`
    insert into signal_evidence (signal_source_id, evidence_type, external_ref, title, discovered_in_run_id, canonical_url)
    values ('${sourceId}', 'serper_web', '${marker}-ev', '${MARKER} fixture evidence', '${runId}', 'https://example.test/${marker}')
    returning id;
  `).trim()
}

function insertSyndicationCopyEvidence(marker: string, originalEvidenceId: string): string {
  const sourceId = insertFixtureSource(`${marker}-src`)
  const runId = insertFixtureRun(`${marker}-run`)
  return dockerPsql(`
    insert into signal_evidence (signal_source_id, evidence_type, external_ref, title, discovered_in_run_id, canonical_url, is_syndication_copy_of)
    values ('${sourceId}', 'serper_web', '${marker}-ev', '${MARKER} fixture syndication copy', '${runId}', 'https://example.test/${marker}', '${originalEvidenceId}')
    returning id;
  `).trim()
}

function insertTopic(overrides: Record<string, string> = {}): string {
  const f: Record<string, string> = {
    canonical_label: `'${MARKER} topic ${Math.random().toString(36).slice(2)}'`,
    label_language: `'en'`,
    creation_request_digest: `'${randomHexDigest()}'`,
    ...overrides,
  }
  const cols = Object.keys(f).join(', ')
  const vals = Object.values(f).join(', ')
  return dockerPsql(`insert into semantic_topics (${cols}) values (${vals}) returning id;`).trim()
}

function insertMembership(topicId: string, evidenceId: string, overrides: Record<string, string> = {}): string {
  const f: Record<string, string> = {
    semantic_topic_id: `'${topicId}'`,
    signal_evidence_id: `'${evidenceId}'`,
    assignment_reason: `'entity_event_match'`,
    confidence: '0.9000',
    algorithm_version: '1',
    ...overrides,
  }
  const cols = Object.keys(f).join(', ')
  const vals = Object.values(f).join(', ')
  return dockerPsql(`insert into semantic_topic_membership (${cols}) values (${vals}) returning id;`).trim()
}

function callRpc(topicId: string): any {
  return JSON.parse(dockerPsql(`select compute_topic_evidence_vector('${topicId}'::uuid);`).trim())
}

const VALID_STRUCTURED_OUTPUT = (overrides: Record<string, unknown> = {}) => {
  const base = {
    extraction_schema_version: 1,
    canonical_phenomenon_label: 'TEV fan-out fixture phenomenon',
    label_language: 'en',
    subject_entities: ['Entity A'],
    action_or_event: null,
    location: null,
    temporal_context: null,
    specificity: 'specific',
    content_format: 'other',
    confidence: 0.72,
    supporting_spans: [{ source_field: 'title', quoted_text: 'TEV fan-out fixture phenomenon' }],
    ...overrides,
  }
  return JSON.stringify(base).replace(/'/g, "''")
}

function createExtractionRun(evidenceId: string, idempotencyKey: string, normSuffix: string): string {
  const sql = `select record_topic_extraction_run(
    '${evidenceId}'::uuid, 2, 'ai_assisted', 'anthropic', 'claude-sonnet-4-6', 'v1', NULL,
    'norm-${normSuffix}', 1, 'completed', '${VALID_STRUCTURED_OUTPUT()}'::jsonb, 100, 50, 0.001, NULL,
    '${idempotencyKey}', now() - interval '1 minute', now()
  );`
  const result = JSON.parse(dockerPsql(sql).trim())
  return result.extraction_run_id
}

describeIfLocalDb('Semantic Topic Identity v0 -- compute_topic_evidence_vector (085, real local DB)', () => {
  beforeAll(() => {
    ensureFullyApplied()
    cleanupTestData()
  })

  afterAll(() => {
    cleanupTestData()
  })

  // ------------------------------------------------------------
  // 1. TOPIC_NOT_FOUND
  // ------------------------------------------------------------
  it('1. returns TOPIC_NOT_FOUND for a random non-existent UUID', () => {
    const out = callRpc(randomUUID())
    expect(out).toEqual({ ok: false, reasonCode: 'TOPIC_NOT_FOUND' })
  })

  // ------------------------------------------------------------
  // 2. Zero-state
  // ------------------------------------------------------------
  it('2. zero-state: a real topic with 0 eligible memberships', () => {
    const topicId = insertTopic()
    const out = callRpc(topicId)
    expect(out).toEqual({
      ok: true,
      formulaVersion: 'topic_evidence_vector_v1',
      semanticTopicId: topicId,
      lifecycleStatus: 'candidate_singleton',
      activeMembershipCount: 0,
      eligibleMembershipCount: 0,
      syndicationExcludedCount: 0,
      knownIndependentSourceCount: 0,
      unknownSourceCount: 0,
      manualReviewConfirmedSourceCount: 0,
      manualReviewOverrideSourceCount: 0,
      automatedAssignmentSourceCount: 0,
      mixedAlgorithmVersions: false,
      byAlgorithmVersion: {},
      confidenceDiagnostics: { min: null, max: null, count: 0 },
      inputIntegrityStatus: 'not_applicable',
    })
  })

  // ------------------------------------------------------------
  // 3. One known source
  // ------------------------------------------------------------
  it('3. one known source -> knownIndependentSourceCount=1', () => {
    const topicId = insertTopic()
    const m = nextMarker()
    const evidenceId = insertKnownEvidence(m, `${m}-chanA`)
    insertMembership(topicId, evidenceId)
    const out = callRpc(topicId)
    expect(out.ok).toBe(true)
    expect(out.eligibleMembershipCount).toBe(1)
    expect(out.knownIndependentSourceCount).toBe(1)
    expect(out.unknownSourceCount).toBe(0)
    // youtube_video evidence with canonical_url left NULL (allowed by the
    // signal_evidence schema for evidence_type='youtube_video') -- the
    // narrow inputIntegrityStatus definition correctly flags this as
    // incomplete, not not_applicable (which is reserved for the
    // zero-eligible-membership case only).
    expect(out.inputIntegrityStatus).toBe('incomplete')
  })

  // ------------------------------------------------------------
  // 4. Two independent known sources
  // ------------------------------------------------------------
  it('4. two independent known sources (different channel_id) -> knownIndependentSourceCount=2', () => {
    const topicId = insertTopic()
    const m1 = nextMarker()
    const m2 = nextMarker()
    const evA = insertKnownEvidence(m1, `${m1}-chanA`)
    const evB = insertKnownEvidence(m2, `${m2}-chanB`)
    insertMembership(topicId, evA)
    insertMembership(topicId, evB)
    const out = callRpc(topicId)
    expect(out.eligibleMembershipCount).toBe(2)
    expect(out.knownIndependentSourceCount).toBe(2)
  })

  // ------------------------------------------------------------
  // 5. Multiple eligible memberships from the SAME known source
  // ------------------------------------------------------------
  it('5. multiple eligible memberships from the same known source -> knownIndependentSourceCount stays 1', () => {
    const topicId = insertTopic()
    const m1 = nextMarker()
    const m2 = nextMarker()
    const channel = `${m1}-shared-chan`
    const evA = insertKnownEvidence(m1, channel)
    const evB = insertKnownEvidence(m2, channel)
    insertMembership(topicId, evA)
    insertMembership(topicId, evB)
    const out = callRpc(topicId)
    expect(out.eligibleMembershipCount).toBe(2)
    expect(out.knownIndependentSourceCount).toBe(1)
  })

  // ------------------------------------------------------------
  // 6. Unknown-source membership
  // ------------------------------------------------------------
  it('6. unknown-source membership -> unknownSourceCount increments, knownIndependentSourceCount does not', () => {
    const topicId = insertTopic()
    const m = nextMarker()
    const evidenceId = insertUnknownEvidence(m)
    insertMembership(topicId, evidenceId)
    const out = callRpc(topicId)
    expect(out.eligibleMembershipCount).toBe(1)
    expect(out.unknownSourceCount).toBe(1)
    expect(out.knownIndependentSourceCount).toBe(0)
  })

  // ------------------------------------------------------------
  // 7. Syndication-copy membership
  // ------------------------------------------------------------
  it('7. syndication-copy membership -> counts only toward syndicationExcludedCount', () => {
    const topicId = insertTopic()
    const m1 = nextMarker()
    const m2 = nextMarker()
    const originalEvidence = insertKnownEvidence(m1, `${m1}-chan`)
    const copyEvidence = insertSyndicationCopyEvidence(m2, originalEvidence)
    insertMembership(topicId, originalEvidence)
    insertMembership(topicId, copyEvidence)
    const out = callRpc(topicId)
    expect(out.activeMembershipCount).toBe(2)
    expect(out.eligibleMembershipCount).toBe(1)
    expect(out.syndicationExcludedCount).toBe(1)
    expect(out.knownIndependentSourceCount).toBe(1)
  })

  // ------------------------------------------------------------
  // 8. Inactive membership
  // ------------------------------------------------------------
  it('8. inactive (valid_to set) membership -> excluded from every active/eligible count entirely', () => {
    const topicId = insertTopic()
    const m = nextMarker()
    const evidenceId = insertKnownEvidence(m, `${m}-chan`)
    insertMembership(topicId, evidenceId, {
      valid_from: `(now() - interval '2 hours')`,
      valid_to: `(now() - interval '1 hour')`,
    })
    const out = callRpc(topicId)
    expect(out.activeMembershipCount).toBe(0)
    expect(out.eligibleMembershipCount).toBe(0)
    expect(out.knownIndependentSourceCount).toBe(0)
    expect(out.syndicationExcludedCount).toBe(0)
  })

  // ------------------------------------------------------------
  // 9. Mixed algorithm_version, SAME channel -- highest-value test
  // ------------------------------------------------------------
  it('9. mixed algorithm_version with the SAME channel under two versions -> top-level knownIndependentSourceCount must NOT double-count', () => {
    const topicId = insertTopic()
    const m1 = nextMarker()
    const m2 = nextMarker()
    const channel = `${m1}-shared-chan`
    const evA = insertKnownEvidence(m1, channel)
    const evB = insertKnownEvidence(m2, channel)
    insertMembership(topicId, evA, { algorithm_version: '1' })
    insertMembership(topicId, evB, { algorithm_version: '2' })
    const out = callRpc(topicId)
    expect(out.eligibleMembershipCount).toBe(2)
    expect(out.mixedAlgorithmVersions).toBe(true)
    // The critical assertion: distinct-channel count over the FULL eligible
    // set, not the sum of per-version distinct counts (which would be 2).
    expect(out.knownIndependentSourceCount).toBe(1)
    expect(out.byAlgorithmVersion['1'].knownIndependentSourceCount).toBe(1)
    expect(out.byAlgorithmVersion['2'].knownIndependentSourceCount).toBe(1)
    expect(out.byAlgorithmVersion['1'].eligibleMembershipCount).toBe(1)
    expect(out.byAlgorithmVersion['2'].eligibleMembershipCount).toBe(1)
  })

  // ------------------------------------------------------------
  // 10. Mixed algorithm_version, DIFFERENT channels
  // ------------------------------------------------------------
  it('10. mixed algorithm_version with different channels per version -> byAlgorithmVersion segments correctly, honest top-level total', () => {
    const topicId = insertTopic()
    const m1 = nextMarker()
    const m2 = nextMarker()
    const evA = insertKnownEvidence(m1, `${m1}-chanA`)
    const evB = insertKnownEvidence(m2, `${m2}-chanB`)
    insertMembership(topicId, evA, { algorithm_version: '1' })
    insertMembership(topicId, evB, { algorithm_version: '2' })
    const out = callRpc(topicId)
    expect(out.mixedAlgorithmVersions).toBe(true)
    expect(out.eligibleMembershipCount).toBe(2)
    expect(out.knownIndependentSourceCount).toBe(2)
    expect(out.byAlgorithmVersion['1']).toMatchObject({ eligibleMembershipCount: 1, knownIndependentSourceCount: 1, unknownSourceCount: 0 })
    expect(out.byAlgorithmVersion['2']).toMatchObject({ eligibleMembershipCount: 1, knownIndependentSourceCount: 1, unknownSourceCount: 0 })
  })

  // ------------------------------------------------------------
  // 11. Overlapping manual-review + automated assignment for one channel
  // ------------------------------------------------------------
  it('11. a channel with both manual_review_confirmed and automated eligible memberships is counted in BOTH sets (documented overlap)', () => {
    const topicId = insertTopic()
    const m1 = nextMarker()
    const m2 = nextMarker()
    const channel = `${m1}-shared-chan`
    const evA = insertKnownEvidence(m1, channel)
    const evB = insertKnownEvidence(m2, channel)
    insertMembership(topicId, evA, { assignment_reason: `'manual_review_confirmed'` })
    insertMembership(topicId, evB, { assignment_reason: `'entity_event_match'` })
    const out = callRpc(topicId)
    expect(out.knownIndependentSourceCount).toBe(1)
    expect(out.manualReviewConfirmedSourceCount).toBe(1)
    expect(out.automatedAssignmentSourceCount).toBe(1)
    expect(out.manualReviewOverrideSourceCount).toBe(0)
    // Documented: the sum is NOT asserted equal to knownIndependentSourceCount --
    // here it deliberately overshoots it (1 + 1 = 2 != 1) because of the overlap.
    expect(out.manualReviewConfirmedSourceCount + out.automatedAssignmentSourceCount).not.toBe(out.knownIndependentSourceCount)
  })

  // ------------------------------------------------------------
  // 12. Extraction-run fan-out has zero effect
  // ------------------------------------------------------------
  it('12. topic_extraction_runs fan-out (0, 1, or 2 rows for the same evidence) never changes the result', () => {
    const topicId = insertTopic()
    const m = nextMarker()
    const evidenceId = insertKnownEvidence(m, `${m}-chan`)
    insertMembership(topicId, evidenceId, { assignment_reason: `'manual_review_confirmed'`, confidence: '0.6600' })

    const resultWithZeroRuns = callRpc(topicId)

    createExtractionRun(evidenceId, `${m}-ext-1`, `${m}-a`)
    const resultWithOneRun = callRpc(topicId)

    createExtractionRun(evidenceId, `${m}-ext-2`, `${m}-b`)
    const resultWithTwoRuns = callRpc(topicId)

    expect(resultWithZeroRuns.ok).toBe(true)
    expect(resultWithZeroRuns.confidenceDiagnostics).toEqual({ min: 0.66, max: 0.66, count: 1 })
    expect(resultWithOneRun).toEqual(resultWithZeroRuns)
    expect(resultWithTwoRuns).toEqual(resultWithZeroRuns)

    // Sanity: really did create 2 extraction_run rows for this one evidence,
    // proving the RPC's stability above is not a vacuous "there was never
    // any fan-out to begin with" result.
    const runCount = dockerPsql(`select count(*) from topic_extraction_runs where signal_evidence_id = '${evidenceId}';`).trim()
    expect(runCount).toBe('2')
  })

  // ------------------------------------------------------------
  // 13. Order-independence
  // ------------------------------------------------------------
  it('13. inserting the same set of eligible memberships in a different order produces identical output', () => {
    const topicX = insertTopic()
    const topicY = insertTopic()

    const mA = nextMarker()
    const mB = nextMarker()
    const mC = nextMarker()
    const chanShared = `${mA}-shared-chan`
    const chanOther = `${mB}-other-chan`

    // Topic X: insert order A (shared, algv1), B (other, algv2), C (shared, algv1)
    const xA = insertKnownEvidence(mA, chanShared)
    const xB = insertKnownEvidence(mB, chanOther)
    const xC = insertKnownEvidence(mC, chanShared)
    insertMembership(topicX, xA, { algorithm_version: '1', confidence: '0.5000' })
    insertMembership(topicX, xB, { algorithm_version: '2', confidence: '0.6000' })
    insertMembership(topicX, xC, { algorithm_version: '1', confidence: '0.7000' })

    // Topic Y: same multiset, reversed insertion order (C, B, A) -- fresh
    // evidence rows (distinct markers), same channel assignments.
    const mA2 = nextMarker()
    const mB2 = nextMarker()
    const mC2 = nextMarker()
    const yC = insertKnownEvidence(mC2, chanShared)
    const yB = insertKnownEvidence(mB2, chanOther)
    const yA = insertKnownEvidence(mA2, chanShared)
    insertMembership(topicY, yC, { algorithm_version: '1', confidence: '0.7000' })
    insertMembership(topicY, yB, { algorithm_version: '2', confidence: '0.6000' })
    insertMembership(topicY, yA, { algorithm_version: '1', confidence: '0.5000' })

    const outX = callRpc(topicX)
    const outY = callRpc(topicY)

    const { semanticTopicId: _idX, ...restX } = outX
    const { semanticTopicId: _idY, ...restY } = outY
    expect(restY).toEqual(restX)
  })

  // ------------------------------------------------------------
  // 14. Deactivation never increases a support count
  // ------------------------------------------------------------
  it('14. deactivating one of two same-channel eligible memberships never increases knownIndependentSourceCount', () => {
    const topicId = insertTopic()
    const m1 = nextMarker()
    const m2 = nextMarker()
    const channel = `${m1}-shared-chan`
    const evA = insertKnownEvidence(m1, channel)
    const evB = insertKnownEvidence(m2, channel)
    const memA = insertMembership(topicId, evA, { confidence: '0.5000', valid_from: `(now() - interval '2 hours')` })
    const memB = insertMembership(topicId, evB, { confidence: '0.9000', valid_from: `(now() - interval '1 hour')` })

    const before = callRpc(topicId)
    expect(before.knownIndependentSourceCount).toBe(1)
    expect(before.eligibleMembershipCount).toBe(2)

    // Deactivate the EARLIER, lower-confidence membership first.
    dockerPsql(`update semantic_topic_membership set valid_to = now() where id = '${memA}';`)
    const afterDeactivateA = callRpc(topicId)
    expect(afterDeactivateA.knownIndependentSourceCount).toBe(1) // unchanged, never increased
    expect(afterDeactivateA.eligibleMembershipCount).toBe(1)

    // Now deactivate the remaining one too -- must decrease to 0, never
    // increase back up.
    dockerPsql(`update semantic_topic_membership set valid_to = now() where id = '${memB}';`)
    const afterDeactivateBoth = callRpc(topicId)
    expect(afterDeactivateBoth.knownIndependentSourceCount).toBe(0)
    expect(afterDeactivateBoth.eligibleMembershipCount).toBe(0)
  })

  it('14b. deactivating the LATER, higher-confidence membership first also never increases the count (order-symmetry)', () => {
    const topicId = insertTopic()
    const m1 = nextMarker()
    const m2 = nextMarker()
    const channel = `${m1}-shared-chan`
    const evA = insertKnownEvidence(m1, channel)
    const evB = insertKnownEvidence(m2, channel)
    const memA = insertMembership(topicId, evA, { confidence: '0.5000', valid_from: `(now() - interval '2 hours')` })
    const memB = insertMembership(topicId, evB, { confidence: '0.9000', valid_from: `(now() - interval '1 hour')` })

    const before = callRpc(topicId)
    expect(before.knownIndependentSourceCount).toBe(1)

    // This time deactivate B (the later, higher-confidence one) first --
    // proves the result does not depend on which "representative" row is
    // still active; it is structurally impossible for this to increase the
    // count either way, since it is a pure DISTINCT over whatever remains
    // active.
    dockerPsql(`update semantic_topic_membership set valid_to = now() where id = '${memB}';`)
    const afterDeactivateB = callRpc(topicId)
    expect(afterDeactivateB.knownIndependentSourceCount).toBe(1)
    expect(afterDeactivateB.eligibleMembershipCount).toBe(1)

    dockerPsql(`update semantic_topic_membership set valid_to = now() where id = '${memA}';`)
    const afterDeactivateBoth = callRpc(topicId)
    expect(afterDeactivateBoth.knownIndependentSourceCount).toBe(0)
  })

  // ------------------------------------------------------------
  // 15. Grant/security
  // ------------------------------------------------------------
  describe('15. grant/security topology', () => {
    it('anon and authenticated cannot execute the function directly', () => {
      const errAnon = dockerPsqlExpectError(`SET ROLE anon; select compute_topic_evidence_vector('${randomUUID()}'::uuid); RESET ROLE;`)
      expect(errAnon).toMatch(/permission denied/)
      const errAuth = dockerPsqlExpectError(`SET ROLE authenticated; select compute_topic_evidence_vector('${randomUUID()}'::uuid); RESET ROLE;`)
      expect(errAuth).toMatch(/permission denied/)
    })

    it('service_role can execute the function', () => {
      const out = dockerPsql(`SET ROLE service_role; select compute_topic_evidence_vector('${randomUUID()}'::uuid); RESET ROLE;`).trim()
      expect(JSON.parse(out)).toEqual({ ok: false, reasonCode: 'TOPIC_NOT_FOUND' })
    })

    it('ACL matches exactly: postgres+service_role EXECUTE only, no PUBLIC/anon/authenticated', () => {
      const acl = dockerPsql(`
        select
          has_function_privilege('postgres', 'public.compute_topic_evidence_vector(uuid)'::regprocedure, 'EXECUTE')::text,
          has_function_privilege('service_role', 'public.compute_topic_evidence_vector(uuid)'::regprocedure, 'EXECUTE')::text,
          has_function_privilege('anon', 'public.compute_topic_evidence_vector(uuid)'::regprocedure, 'EXECUTE')::text,
          has_function_privilege('authenticated', 'public.compute_topic_evidence_vector(uuid)'::regprocedure, 'EXECUTE')::text;
      `).trim().split('|')
      expect(acl).toEqual(['true', 'true', 'false', 'false'])

      const extraGrantees = dockerPsql(`
        select count(*) from aclexplode(coalesce(
          (select proacl from pg_proc where oid = 'public.compute_topic_evidence_vector(uuid)'::regprocedure),
          acldefault('f', (select proowner from pg_proc where oid = 'public.compute_topic_evidence_vector(uuid)'::regprocedure))
        )) acl join pg_roles grantee on grantee.oid = acl.grantee
        where acl.privilege_type = 'EXECUTE' and grantee.rolname not in ('postgres', 'service_role');
      `).trim()
      expect(extraGrantees).toBe('0')
    })
  })

  // ------------------------------------------------------------
  // 16. Concurrent-read consistency
  // ------------------------------------------------------------
  it('16. two simultaneous calls against the same topic return identical results', async () => {
    const topicId = insertTopic()
    const m1 = nextMarker()
    const m2 = nextMarker()
    const evA = insertKnownEvidence(m1, `${m1}-chanA`)
    const evB = insertKnownEvidence(m2, `${m2}-chanB`)
    insertMembership(topicId, evA, { algorithm_version: '1' })
    insertMembership(topicId, evB, { algorithm_version: '2' })

    const sql = `select compute_topic_evidence_vector('${topicId}'::uuid);`
    const [r1, r2] = await Promise.all([dockerPsqlAsync(sql), dockerPsqlAsync(sql)])
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    expect(JSON.parse(r1.out.trim())).toEqual(JSON.parse(r2.out.trim()))
  })

  // ------------------------------------------------------------
  // 17. Migration applied twice is a byte-exact no-op
  // ------------------------------------------------------------
  it('17. re-applying migration 085 is a byte-exact no-op', () => {
    const result = runMigration(MIGRATION_085_PATH)
    expect(result.threw).toBe(false)
    expect(result.out).toMatch(/compute_topic_evidence_vector already exists and matches exactly -- no-op\./)
    expect(result.out).toMatch(/final self-check passed/)
    expect(result.out).not.toMatch(/drift/i)
  })
})
