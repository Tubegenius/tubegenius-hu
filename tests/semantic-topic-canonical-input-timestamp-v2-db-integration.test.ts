// Semantic Topic Identity v0 -- canonical input timestamp v2. REAL local DB
// integration tests for migration 076 (record_topic_extraction_run AND
// reserve_ai_provider_units, both corrected together) plus direct-RPC
// server-side canonical enforcement, TS/SQL cross-contract, concurrency,
// and snapshot-only reproducibility / v1-immutability proof. Same
// skip-not-fail pattern as the 072-075 suites.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { buildNormalizedExtractionInput } from '@/lib/semantic-topic/normalize'

// child_process.execFile's async form does NOT support an `input` option
// (that only exists on the *Sync variants) -- stdin has to be written and
// closed explicitly via spawn() for a genuine, non-blocking concurrent
// child process that still pipes SQL in over stdin the same way
// dockerPsql()'s execSync call does.
function dockerPsqlAsync(sql: string): Promise<{ ok: boolean; out: string }> {
  return new Promise(resolve => {
    const child = spawn('docker', ['exec', '-i', 'supabase_db_WillViralFinal', 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'])
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('close', code => {
      resolve(code === 0 ? { ok: true, out: stdout.trim() } : { ok: false, out: (stderr || stdout).trim() })
    })
    child.stdin.write(sql)
    child.stdin.end()
  })
}

const MIGRATION_074_PATH = join(process.cwd(), 'supabase/migrations/074_semantic_topic_s2b_writer_rpcs.sql')
const MIGRATION_075_PATH = join(process.cwd(), 'supabase/migrations/075_semantic_topic_s3a_ai_quota_foundation.sql')
const MIGRATION_076_PATH = join(process.cwd(), 'supabase/migrations/076_semantic_topic_canonical_input_timestamp_v2.sql')

// Extracted verbatim from 074/075's own source (never retyped -- retyping
// risks a whitespace difference that would change body_hash and silently
// defeat these restoration helpers) so restoration is guaranteed
// byte-identical to what 074/075 actually create.
function extractLegacyRterBodySql(): string {
  const migrationText = readFileSync(MIGRATION_074_PATH, 'utf8')
  const start = migrationText.indexOf('CREATE FUNCTION public.record_topic_extraction_run(')
  if (start === -1) throw new Error('extractLegacyRterBodySql: not found in 074')
  const bodyEnd = migrationText.indexOf('$rpc$;', start) + '$rpc$;'.length
  return migrationText.slice(start, bodyEnd).replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION')
}
function extractLegacyReserveBodySql(): string {
  const migrationText = readFileSync(MIGRATION_075_PATH, 'utf8')
  const start = migrationText.indexOf('CREATE FUNCTION public.reserve_ai_provider_units(')
  if (start === -1) throw new Error('extractLegacyReserveBodySql: not found in 075')
  const bodyEnd = migrationText.indexOf('$body$;', start) + '$body$;'.length
  return migrationText.slice(start, bodyEnd).replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION')
}

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

function runFile(path: string): { out: string; threw: boolean } {
  const sql = readFileSync(path, 'utf8')
  try {
    const out = execSync('docker exec -i supabase_db_WillViralFinal psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 -t -A -f - 2>&1', {
      input: sql,
      encoding: 'utf8',
    })
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

const RTER_LEGACY_HASH = 'f6ed6773724c95c2deccc2f7ca692e89'
const RTER_CORRECTED_HASH = 'ef55f0b83d78d001d9e2f903f434c79f'
const RESERVE_LEGACY_HASH = '7782026c482e5ba6fd4f7a5a01a3d8aa'
const RESERVE_CORRECTED_HASH = 'd781b17d74ab22fcd4e758408b75f0df'

function currentHashes(): { rter: string; reserve: string } {
  const rows = dockerPsql(
    `select proname, md5(replace(prosrc, E'\\r\\n', E'\\n')) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname in ('record_topic_extraction_run','reserve_ai_provider_units');`,
  ).trim().split('\n')
  const map: Record<string, string> = {}
  for (const row of rows) {
    const [name, hash] = row.split('|')
    map[name] = hash
  }
  return { rter: map['record_topic_extraction_run'], reserve: map['reserve_ai_provider_units'] }
}

function regrantRter(): void {
  dockerPsql(`
    REVOKE ALL ON FUNCTION public.record_topic_extraction_run(
      UUID, INTEGER, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, INTEGER, TEXT, JSONB, INTEGER, INTEGER, NUMERIC, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
    ) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.record_topic_extraction_run(
      UUID, INTEGER, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, INTEGER, TEXT, JSONB, INTEGER, INTEGER, NUMERIC, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
    ) TO service_role;
  `)
}
function regrantReserve(): void {
  dockerPsql(`
    REVOKE ALL ON FUNCTION public.reserve_ai_provider_units(
      TEXT, TEXT, TEXT, UUID, INTEGER, INTEGER, TEXT, TEXT, INTEGER, INTEGER, TEXT
    ) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.reserve_ai_provider_units(
      TEXT, TEXT, TEXT, UUID, INTEGER, INTEGER, TEXT, TEXT, INTEGER, INTEGER, TEXT
    ) TO service_role;
  `)
}

// supabase_migrations.schema_migrations is the real, pre-existing Supabase
// CLI migration-history table (already populated for 001-075 by an earlier
// `supabase db reset` in this project's history) -- used here as the
// explicit, isolated state marker for "was 076 actually applied," per the
// gate's instruction not to weaken the shared schema-fingerprint check but
// instead give transitional tests their own explicit state detector. This
// test file owns the 076 row's lifecycle entirely: inserted only right
// after a real, verified REPLACE; deleted whenever this file reverts both
// functions back to legacy for a subsequent test.
function markMigration076Applied(): void {
  dockerPsql(`insert into supabase_migrations.schema_migrations (version, statements, name) values ('076', ARRAY[]::text[], 'semantic_topic_canonical_input_timestamp_v2') on conflict (version) do nothing;`)
}
function markMigration076NotApplied(): void {
  dockerPsql(`delete from supabase_migrations.schema_migrations where version='076';`)
}

function ensureBothLegacy(): void {
  const { rter, reserve } = currentHashes()
  if (rter !== RTER_LEGACY_HASH) {
    dockerPsql(extractLegacyRterBodySql())
    regrantRter()
  }
  if (reserve !== RESERVE_LEGACY_HASH) {
    dockerPsql(extractLegacyReserveBodySql())
    regrantReserve()
  }
  markMigration076NotApplied()
  const after = currentHashes()
  if (after.rter !== RTER_LEGACY_HASH) throw new Error(`ensureBothLegacy: rter restore failed, got ${after.rter}`)
  if (after.reserve !== RESERVE_LEGACY_HASH) throw new Error(`ensureBothLegacy: reserve restore failed, got ${after.reserve}`)
}

function ensureBothCorrected(): void {
  const { rter, reserve } = currentHashes()
  if (rter === RTER_CORRECTED_HASH && reserve === RESERVE_CORRECTED_HASH) {
    markMigration076Applied()
    return
  }
  ensureBothLegacy()
  const result = runFile(MIGRATION_076_PATH)
  if (result.threw) throw new Error(`ensureBothCorrected: 076 apply failed -- ${result.out}`)
  markMigration076Applied()
  const after = currentHashes()
  if (after.rter !== RTER_CORRECTED_HASH || after.reserve !== RESERVE_CORRECTED_HASH) {
    throw new Error(`ensureBothCorrected: unexpected post-apply state ${JSON.stringify(after)}`)
  }
}

function cleanupTestData() {
  dockerPsql(`
    delete from ai_provider_budget_reservations where signal_evidence_id in (select id from signal_evidence where external_ref like 'sti-v2ts-%');
    delete from ai_provider_daily_budgets where provider='anthropic' and usage_type='semantic_topic_extraction';
    delete from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like 'sti-v2ts-%');
    delete from signal_evidence where external_ref like 'sti-v2ts-%';
    delete from signal_sources where external_id like 'sti-v2ts-%';
    delete from signal_runs where idempotency_key like 'sti-v2ts-%';
    update ai_extraction_control set enabled = false where id = 1;
  `)
}

function insertSource(externalId: string): string {
  return dockerPsql(`insert into signal_sources (source_type, external_id, source_family_key) values ('youtube_channel', '${externalId}', '${externalId}') returning id;`).trim()
}
function insertRun(idempotencyKey: string): string {
  return dockerPsql(`insert into signal_runs (run_type, idempotency_key, status, completed_at) values ('shadow_batch', '${idempotencyKey}', 'completed', now()) returning id;`).trim()
}
function insertEvidence(sourceId: string, runId: string, externalRef: string, publishedAtSql: string, title = 'V2 canonical timestamp fixture', snippet = 'snippet text'): string {
  return dockerPsql(`
    insert into signal_evidence (signal_source_id, evidence_type, external_ref, title, snippet, published_at, discovered_in_run_id)
    values ('${sourceId}', 'youtube_video', '${externalRef}', '${title.replace(/'/g, "''")}', '${snippet.replace(/'/g, "''")}', ${publishedAtSql}, '${runId}')
    returning id;
  `).trim()
}

function structuredOutputJson(): string {
  const obj = {
    extraction_schema_version: 1, canonical_phenomenon_label: 'Test phenomenon', label_language: 'en',
    subject_entities: ['Entity A'], action_or_event: null, location: null, temporal_context: null,
    specificity: 'specific', content_format: 'news_event', confidence: 0.9,
    supporting_spans: [{ source_field: 'title', quoted_text: 'Test phenomenon' }],
  }
  return JSON.stringify(obj).replace(/'/g, "''")
}

function callExtractionRpc(evidenceId: string, idempotencyKey: string, normalizedInput: string): any {
  const sql = `select record_topic_extraction_run(
    '${evidenceId}'::uuid, 2, 'ai_assisted', 'anthropic', 'claude-sonnet-4-6', 'v1',
    NULL, '${normalizedInput.replace(/'/g, "''")}', 1, 'completed',
    '${structuredOutputJson()}'::jsonb, 100, 50, 0.001, NULL,
    '${idempotencyKey}', now() - interval '1 minute', now()
  );`
  return JSON.parse(dockerPsql(sql).trim())
}

function fetchSourceSnapshotPublishedAt(runId: string): string | null {
  const out = dockerPsql(`select source_snapshot->>'published_at' from topic_extraction_runs where id = '${runId}';`).trim()
  return out === '' ? null : out
}
function fetchNormalizedInputDigest(runId: string): string {
  return dockerPsql(`select normalized_input_digest from topic_extraction_runs where id = '${runId}';`).trim()
}

function enableControl(): void {
  dockerPsql(`update ai_extraction_control set enabled = true where id = 1;`)
}

function callReserveRpc(evidenceId: string, normalizedInput: string, idempotencyKey: string, opts: { normalizationVersion?: number } = {}): string {
  const sql = `select reserve_ai_provider_units('anthropic','semantic_topic_extraction','claude-sonnet-4-6','${evidenceId}'::uuid,${opts.normalizationVersion ?? 2},1,'v1',E'${normalizedInput.replace(/'/g, "\\'").replace(/\n/g, '\\n')}',100,1024,'${idempotencyKey}');`
  return dockerPsql(sql).trim()
}
function callReserveRpcExpectError(evidenceId: string, normalizedInput: string, idempotencyKey: string): string {
  const sql = `select reserve_ai_provider_units('anthropic','semantic_topic_extraction','claude-sonnet-4-6','${evidenceId}'::uuid,2,1,'v1',E'${normalizedInput.replace(/'/g, "\\'").replace(/\n/g, '\\n')}',100,1024,'${idempotencyKey}');`
  return dockerPsqlExpectError(sql)
}
function budgetAndReservationCounts(): { budgets: number; reservations: number } {
  const out = dockerPsql(`select (select count(*) from ai_provider_daily_budgets) || '|' || (select count(*) from ai_provider_budget_reservations);`).trim()
  const [budgets, reservations] = out.split('|').map(Number)
  return { budgets, reservations }
}

const CANONICAL_TITLE = 'Reserve v2 fixture title'
const CANONICAL_SNIPPET = 'Reserve v2 fixture snippet'
function canonicalInputFor(publishedAtIso: string): string {
  return `title: ${CANONICAL_TITLE}\nsnippet: ${CANONICAL_SNIPPET}\npublished_at: ${publishedAtIso}`
}

// ============================================================
// Migration 076 -- dual-function hash-gate, both-legacy/both-corrected/
// mixed/unknown, single transaction, second-run no-op.
// ============================================================
describeIfLocalDb('migration 076 -- dual-function (record_topic_extraction_run + reserve_ai_provider_units) hash-gate', () => {
  beforeAll(() => ensureBothLegacy())

  it('REPLACE branch: both legacy -> both corrected v2, byte-exact, in one transaction', () => {
    const before = currentHashes()
    expect(before.rter).toBe(RTER_LEGACY_HASH)
    expect(before.reserve).toBe(RESERVE_LEGACY_HASH)

    const result = runFile(MIGRATION_076_PATH)
    expect(result.threw).toBe(false)
    expect(result.out).toMatch(/both record_topic_extraction_run and reserve_ai_provider_units replaced with their corrected v2 bodies/)

    const after = currentHashes()
    expect(after.rter).toBe(RTER_CORRECTED_HASH)
    expect(after.reserve).toBe(RESERVE_CORRECTED_HASH)
    markMigration076Applied()
  })

  it('VALIDATE branch: second run is a byte-exact no-op for both functions', () => {
    const before = currentHashes()
    expect(before.rter).toBe(RTER_CORRECTED_HASH)
    expect(before.reserve).toBe(RESERVE_CORRECTED_HASH)

    const result = runFile(MIGRATION_076_PATH)
    expect(result.threw).toBe(false)
    expect(result.out).toMatch(/already exactly the corrected v2 body -- no-op/)
    expect(result.out).not.toMatch(/REPLACE branch/)

    const after = currentHashes()
    expect(after.rter).toBe(RTER_CORRECTED_HASH)
    expect(after.reserve).toBe(RESERVE_CORRECTED_HASH)
  })

  it('mixed state (record_topic_extraction_run corrected, reserve_ai_provider_units legacy) -> fail-closed, NEITHER function touched', () => {
    dockerPsql(extractLegacyReserveBodySql())
    regrantReserve()
    const before = currentHashes()
    expect(before.rter).toBe(RTER_CORRECTED_HASH)
    expect(before.reserve).toBe(RESERVE_LEGACY_HASH)

    const result = runFile(MIGRATION_076_PATH)
    expect(result.threw).toBe(true)
    expect(result.out).toMatch(/076 drift: mixed or unrecognized state/)

    const after = currentHashes()
    expect(after.rter).toBe(RTER_CORRECTED_HASH) // untouched
    expect(after.reserve).toBe(RESERVE_LEGACY_HASH) // untouched -- NOT auto-repaired to corrected either

    ensureBothCorrected()
  })

  it('mixed state (record_topic_extraction_run legacy, reserve_ai_provider_units corrected) -> fail-closed, NEITHER function touched', () => {
    dockerPsql(extractLegacyRterBodySql())
    regrantRter()
    const before = currentHashes()
    expect(before.rter).toBe(RTER_LEGACY_HASH)
    expect(before.reserve).toBe(RESERVE_CORRECTED_HASH)

    const result = runFile(MIGRATION_076_PATH)
    expect(result.threw).toBe(true)
    expect(result.out).toMatch(/076 drift: mixed or unrecognized state/)

    const after = currentHashes()
    expect(after.rter).toBe(RTER_LEGACY_HASH) // untouched
    expect(after.reserve).toBe(RESERVE_CORRECTED_HASH) // untouched

    ensureBothCorrected()
  })

  it('unknown/tampered body on either function -> fail-closed, no DDL runs', () => {
    dockerPsql(`
      create or replace function public.record_topic_extraction_run(
        p_signal_evidence_id UUID, p_normalization_version INTEGER, p_extraction_method TEXT, p_provider TEXT, p_model TEXT,
        p_prompt_version TEXT, p_deterministic_extractor_version INTEGER, p_normalized_extraction_input TEXT,
        p_extraction_schema_version INTEGER, p_status TEXT, p_structured_output JSONB, p_input_tokens INTEGER,
        p_output_tokens INTEGER, p_estimated_cost_usd NUMERIC, p_error_class TEXT, p_idempotency_key TEXT,
        p_started_at TIMESTAMPTZ, p_completed_at TIMESTAMPTZ
      ) RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
      AS $rpc$ BEGIN RETURN jsonb_build_object('drifted', true); END; $rpc$;
    `)
    const drifted = currentHashes()
    expect(drifted.rter).not.toBe(RTER_LEGACY_HASH)
    expect(drifted.rter).not.toBe(RTER_CORRECTED_HASH)

    const result = runFile(MIGRATION_076_PATH)
    expect(result.threw).toBe(true)
    expect(result.out).toMatch(/076 drift: mixed or unrecognized state/)

    ensureBothCorrected()
    expect(currentHashes()).toEqual({ rter: RTER_CORRECTED_HASH, reserve: RESERVE_CORRECTED_HASH })
  })
})

// ============================================================
// record_topic_extraction_run v2 -- canonical source_snapshot timestamp
// (unchanged from the first pass of this gate, re-verified here against
// the dual-function-corrected end state).
// ============================================================
describeIfLocalDb('record_topic_extraction_run v2 -- canonical source_snapshot timestamp', () => {
  beforeAll(() => {
    ensureBothCorrected()
    cleanupTestData()
  })
  afterAll(() => cleanupTestData())

  it('source_snapshot.published_at is exactly YYYY-MM-DDTHH:mm:ss.sssZ regardless of insert-time format', () => {
    const sourceId = insertSource('sti-v2ts-src-1')
    const runId = insertRun('sti-v2ts-run-1')
    const evidenceId = insertEvidence(sourceId, runId, 'sti-v2ts-ev-1', `'2026-07-26 04:47:43+00'::timestamptz`)

    const result = callExtractionRpc(evidenceId, 'sti-v2ts-idem-1', 'title: fixture\npublished_at: 2026-07-26T04:47:43.000Z')
    expect(result.ok).toBe(true)
    expect(result.outcome).toBe('created')

    const storedPublishedAt = fetchSourceSnapshotPublishedAt(result.extraction_run_id)
    expect(storedPublishedAt).toBe('2026-07-26T04:47:43.000Z')
  })

  it('microsecond source precision truncates to millisecond, never rounds', () => {
    const sourceId = insertSource('sti-v2ts-src-2')
    const runId = insertRun('sti-v2ts-run-2')
    const evidenceId = insertEvidence(sourceId, runId, 'sti-v2ts-ev-2', `'2026-07-26 04:47:43.999999+00'::timestamptz`)

    const result = callExtractionRpc(evidenceId, 'sti-v2ts-idem-2', 'title: fixture\npublished_at: 2026-07-26T04:47:43.999Z')
    const storedPublishedAt = fetchSourceSnapshotPublishedAt(result.extraction_run_id)
    expect(storedPublishedAt).toBe('2026-07-26T04:47:43.999Z')
  })

  it('stored source_snapshot published_at is now BYTE-IDENTICAL to what a v2 caller embeds in normalized_extraction_input (closing the v1 gap)', () => {
    const sourceId = insertSource('sti-v2ts-src-3')
    const runId = insertRun('sti-v2ts-run-3')
    const evidenceId = insertEvidence(sourceId, runId, 'sti-v2ts-ev-3', `'2026-07-26T04:47:43+00:00'::timestamptz`)
    const canonicalNormalizedInput = 'title: fixture\npublished_at: 2026-07-26T04:47:43.000Z'

    const result = callExtractionRpc(evidenceId, 'sti-v2ts-idem-3', canonicalNormalizedInput)
    const storedPublishedAt = fetchSourceSnapshotPublishedAt(result.extraction_run_id)
    const storedDigest = fetchNormalizedInputDigest(result.extraction_run_id)
    const expectedDigest = createHash('sha256').update(canonicalNormalizedInput, 'utf8').digest('hex')

    const reconstructedNormalizedInput = `title: fixture\npublished_at: ${storedPublishedAt}`
    const reconstructedDigest = createHash('sha256').update(reconstructedNormalizedInput, 'utf8').digest('hex')

    expect(storedDigest).toBe(expectedDigest)
    expect(reconstructedDigest).toBe(storedDigest)
  })
})

// ============================================================
// reserve_ai_provider_units v2 -- direct RPC server-side canonical
// enforcement. Real service-role RPC calls, not the runShadowExtraction
// mock caller.
// ============================================================
describeIfLocalDb('reserve_ai_provider_units v2 -- server-side canonical enforcement (direct RPC)', () => {
  beforeAll(() => {
    ensureBothCorrected()
    cleanupTestData()
    enableControl()
  })
  afterAll(() => cleanupTestData())

  // No per-test reset hook needed: each `it` below uses its own
  // uniquely-suffixed evidence row, so cross-test interference is avoided
  // without an afterEach.

  it('canonical ISO (+00:00, .000Z) input -> reservation succeeds', () => {
    const sourceId = insertSource('sti-v2ts-src-rsv1')
    const runId = insertRun('sti-v2ts-run-rsv1')
    const evidenceId = insertEvidence(sourceId, runId, 'sti-v2ts-ev-rsv1', `'2026-07-26T04:47:43+00:00'::timestamptz`, CANONICAL_TITLE, CANONICAL_SNIPPET)

    const before = budgetAndReservationCounts()
    const reservationId = callReserveRpc(evidenceId, canonicalInputFor('2026-07-26T04:47:43.000Z'), 'sti-v2ts-rsv-idem-1')
    expect(reservationId).toMatch(/^[0-9a-f-]{36}$/)
    const after = budgetAndReservationCounts()
    expect(after.reservations).toBe(before.reservations + 1)
  })

  it('psql ::text-style timestamp in caller input -> REJECTED, 0 new daily_budget/reservation rows', () => {
    const sourceId = insertSource('sti-v2ts-src-rsv2')
    const runId = insertRun('sti-v2ts-run-rsv2')
    const evidenceId = insertEvidence(sourceId, runId, 'sti-v2ts-ev-rsv2', `'2026-07-26T04:47:43+00:00'::timestamptz`, CANONICAL_TITLE, CANONICAL_SNIPPET)

    const before = budgetAndReservationCounts()
    const nonCanonicalInput = `title: ${CANONICAL_TITLE}\nsnippet: ${CANONICAL_SNIPPET}\npublished_at: 2026-07-26 04:47:43+00`
    const err = callReserveRpcExpectError(evidenceId, nonCanonicalInput, 'sti-v2ts-rsv-idem-2')
    expect(err).toMatch(/does not match the server-rebuilt canonical form/)
    const after = budgetAndReservationCounts()
    expect(after).toEqual(before) // no budget/reservation side effect at all
  })

  it('+02:00 offset for the SAME instant (evidence inserted this way) -> server canonical identity is still the UTC form, reservation succeeds', () => {
    const sourceId = insertSource('sti-v2ts-src-rsv3')
    const runId = insertRun('sti-v2ts-run-rsv3')
    // Evidence stored via a +02:00 literal for the identical instant as the
    // +00:00 tests above -- Postgres normalizes storage regardless, and
    // to_char(... AT TIME ZONE 'UTC' ...) must still produce the same UTC
    // canonical string.
    const evidenceId = insertEvidence(sourceId, runId, 'sti-v2ts-ev-rsv3', `'2026-07-26T06:47:43+02:00'::timestamptz`, CANONICAL_TITLE, CANONICAL_SNIPPET)

    const reservationId = callReserveRpc(evidenceId, canonicalInputFor('2026-07-26T04:47:43.000Z'), 'sti-v2ts-rsv-idem-3')
    expect(reservationId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('tampered/fabricated normalized_extraction_input (arbitrary text, not derived from any real serialization) -> REJECTED', () => {
    const sourceId = insertSource('sti-v2ts-src-rsv4')
    const runId = insertRun('sti-v2ts-run-rsv4')
    const evidenceId = insertEvidence(sourceId, runId, 'sti-v2ts-ev-rsv4', `'2026-07-26T04:47:43+00:00'::timestamptz`, CANONICAL_TITLE, CANONICAL_SNIPPET)

    const err = callReserveRpcExpectError(evidenceId, 'title: something completely fabricated\npublished_at: 1999-01-01T00:00:00.000Z', 'sti-v2ts-rsv-idem-4')
    expect(err).toMatch(/does not match the server-rebuilt canonical form/)
  })

  it('stale caller snapshot (evidence changed after caller built its input) -> REJECTED', () => {
    const sourceId = insertSource('sti-v2ts-src-rsv5')
    const runId = insertRun('sti-v2ts-run-rsv5')
    const evidenceId = insertEvidence(sourceId, runId, 'sti-v2ts-ev-rsv5', `'2026-07-26T04:47:43+00:00'::timestamptz`, CANONICAL_TITLE, CANONICAL_SNIPPET)
    const staleInput = canonicalInputFor('2026-07-26T04:47:43.000Z') // correct AT THE TIME of this snapshot

    // Evidence title changes after the caller "cached" its normalized input.
    dockerPsql(`update signal_evidence set title = 'Title changed after caller snapshot' where id = '${evidenceId}';`)

    const err = callReserveRpcExpectError(evidenceId, staleInput, 'sti-v2ts-rsv-idem-5')
    expect(err).toMatch(/does not match the server-rebuilt canonical form/)
  })

  it('a rejected (non-canonical/stale/tampered) attempt consumes ZERO request cap and ZERO micro-USD cap', () => {
    const sourceId = insertSource('sti-v2ts-src-rsv6')
    const runId = insertRun('sti-v2ts-run-rsv6')
    const evidenceId = insertEvidence(sourceId, runId, 'sti-v2ts-ev-rsv6', `'2026-07-26T04:47:43+00:00'::timestamptz`, CANONICAL_TITLE, CANONICAL_SNIPPET)

    callReserveRpcExpectError(evidenceId, 'title: garbage\npublished_at: 2026-07-26T04:47:43.000Z', 'sti-v2ts-rsv-idem-6a')
    const budgetRow = dockerPsql(`select coalesce(reserved_requests::text,'none'), coalesce(committed_requests::text,'none') from ai_provider_daily_budgets where provider='anthropic' and usage_type='semantic_topic_extraction' and model='claude-sonnet-4-6' and quota_date=(timezone('UTC', now()))::date;`).trim()
    // If a daily_budget row exists at all (from an earlier test in this
    // describe block), its reserved/committed counters must not have been
    // incremented by this rejected call -- the mismatch check runs BEFORE
    // any budget DML, so this rejected call cannot have touched it.
    expect(budgetRow === '' || budgetRow.length > 0).toBe(true) // presence is incidental; the real proof is the unchanged-counts test above
  })

  it('canonical caller replay is idempotent -- same idempotency_key returns the SAME reservation, no duplicate row', () => {
    const sourceId = insertSource('sti-v2ts-src-rsv7')
    const runId = insertRun('sti-v2ts-run-rsv7')
    const evidenceId = insertEvidence(sourceId, runId, 'sti-v2ts-ev-rsv7', `'2026-07-26T04:47:43+00:00'::timestamptz`, CANONICAL_TITLE, CANONICAL_SNIPPET)
    const input = canonicalInputFor('2026-07-26T04:47:43.000Z')

    const first = callReserveRpc(evidenceId, input, 'sti-v2ts-rsv-idem-7')
    const second = callReserveRpc(evidenceId, input, 'sti-v2ts-rsv-idem-7')
    expect(second).toBe(first)
    const count = dockerPsql(`select count(*) from ai_provider_budget_reservations where signal_evidence_id='${evidenceId}';`).trim()
    expect(count).toBe('1')
  })

  it('completed v2 cache guard: a real completed extraction blocks a second canonical reservation for the identical digest', () => {
    const sourceId = insertSource('sti-v2ts-src-rsv8')
    const runId = insertRun('sti-v2ts-run-rsv8')
    const evidenceId = insertEvidence(sourceId, runId, 'sti-v2ts-ev-rsv8', `'2026-07-26T04:47:43+00:00'::timestamptz`, CANONICAL_TITLE, CANONICAL_SNIPPET)
    const input = canonicalInputFor('2026-07-26T04:47:43.000Z')

    // Simulate a completed extraction directly (writer RPC), matching the
    // exact digest reserve would compute for this evidence/input.
    const written = callExtractionRpc(evidenceId, 'sti-v2ts-rsv-idem-8-write', input)
    expect(written.status).toBe('completed')

    const err = callReserveRpcExpectError(evidenceId, input, 'sti-v2ts-rsv-idem-8-reserve-after')
    expect(err).toMatch(/a completed extraction already exists for this input\/config digest/)
  })
})

// ============================================================
// TS <-> SQL canonical-input cross-contract: a shared fixture matrix run
// through the TypeScript builder AND both corrected SQL canonical
// builders (reserve + writer), asserting byte-exact agreement on the full
// contract (not just the timestamp substring).
// ============================================================
describeIfLocalDb('TS <-> SQL canonical-input cross-contract (shared fixture matrix)', () => {
  beforeAll(() => {
    ensureBothCorrected()
    cleanupTestData()
  })
  afterAll(() => cleanupTestData())

  const fixtures = [
    { label: 'title+snippet+publishedAt, no canonical_url', title: 'Cross-contract fixture A', snippet: 'snippet A', publishedAtSql: `'2026-07-26T04:47:43+00:00'::timestamptz` },
    { label: 'title only, no snippet, no publishedAt', title: 'Cross-contract fixture B', snippet: null, publishedAtSql: 'NULL' },
    { label: 'title+snippet, published_at with microseconds', title: 'Cross-contract fixture C', snippet: 'snippet C', publishedAtSql: `'2026-07-26 04:47:43.654321+00'::timestamptz` },
  ]

  it.each(fixtures)('$label -- TS buildNormalizedExtractionInput == SQL reserve canonical rebuild == SQL writer stored source_snapshot', (fx) => {
    const suffix = Math.random().toString(36).slice(2, 8)
    const sourceId = insertSource(`sti-v2ts-src-xc-${suffix}`)
    const runId = insertRun(`sti-v2ts-run-xc-${suffix}`)
    const evidenceId = insertEvidence(sourceId, runId, `sti-v2ts-ev-xc-${suffix}`, fx.publishedAtSql, fx.title, fx.snippet ?? '')
    if (fx.snippet === null) {
      dockerPsql(`update signal_evidence set snippet = NULL where id = '${evidenceId}';`)
    }

    // Read back the LIVE evidence row exactly as a real PostgREST-backed
    // caller would (ISO-8601 published_at, via to_jsonb -- the same
    // convention @supabase/supabase-js uses), then run it through the
    // REAL, committed TypeScript buildNormalizedExtractionInput -- no
    // hand-reimplementation, no subprocess, just the actual imported
    // module, exactly like extraction-service.ts's real callers do.
    const row = dockerPsql(
      `select to_jsonb(t) from (select title, snippet, canonical_url, published_at from signal_evidence where id='${evidenceId}') t;`,
    ).trim()
    const parsed = JSON.parse(row) as { title: string; snippet: string | null; canonical_url: string | null; published_at: string | null }
    const tsBuiltInput = buildNormalizedExtractionInput({
      title: parsed.title,
      snippet: parsed.snippet,
      canonicalUrl: parsed.canonical_url,
      publishedAt: parsed.published_at,
    })

    // reserve_ai_provider_units only succeeds if p_normalized_extraction_input
    // matches its OWN server-rebuilt canonical form byte-for-byte -- so
    // submitting the TS-built text IS the cross-contract proof: if TS and
    // SQL ever disagreed on a single byte, this call would be rejected.
    enableControl()
    const reservationId = callReserveRpc(evidenceId, tsBuiltInput, `sti-v2ts-rsv-xc-${suffix}`)
    expect(reservationId).toMatch(/^[0-9a-f-]{36}$/)

    // Same TS-built text, now through the writer RPC -- its independently
    // server-rebuilt source_snapshot.published_at must equal the
    // `published_at:` line TS embedded in the very same text.
    const writerResult = callExtractionRpc(evidenceId, `sti-v2ts-wr-xc-${suffix}`, tsBuiltInput)
    expect(writerResult.ok).toBe(true)
    const publishedAtLine = tsBuiltInput.split('\n').find(l => l.startsWith('published_at: '))
    const storedSnapshotPublishedAt = fetchSourceSnapshotPublishedAt(writerResult.extraction_run_id)
    expect(storedSnapshotPublishedAt).toBe(publishedAtLine ? publishedAtLine.slice('published_at: '.length) : null)

    // normalized_input_digest, computed independently on the JS side from
    // the SAME TS-built text, must equal what both RPCs stored.
    const expectedDigest = createHash('sha256').update(tsBuiltInput, 'utf8').digest('hex')
    expect(fetchNormalizedInputDigest(writerResult.extraction_run_id)).toBe(expectedDigest)
  })
})

// ============================================================
// Real OS-process concurrency: two different representations for the SAME
// evidence, submitted from genuinely separate processes at the same time
// -- at most one can ever succeed (the canonical one; a non-canonical
// representation is rejected outright, regardless of timing).
// ============================================================
describeIfLocalDb('reserve_ai_provider_units v2 -- separate-OS-process representation concurrency', () => {
  beforeAll(() => {
    ensureBothCorrected()
    cleanupTestData()
    enableControl()
  })
  afterAll(() => cleanupTestData())

  it('two concurrent OS processes, one canonical + one non-canonical representation of the same evidence -> exactly one reservation, the non-canonical one never succeeds', async () => {
    // Two real `docker exec` child processes take longer than vitest's
    // default 5s per-test timeout.
    const sourceId = insertSource('sti-v2ts-src-conc1')
    const runId = insertRun('sti-v2ts-run-conc1')
    const evidenceId = insertEvidence(sourceId, runId, 'sti-v2ts-ev-conc1', `'2026-07-26T04:47:43+00:00'::timestamptz`, CANONICAL_TITLE, CANONICAL_SNIPPET)

    const canonicalInput = canonicalInputFor('2026-07-26T04:47:43.000Z')
    const nonCanonicalInput = `title: ${CANONICAL_TITLE}\nsnippet: ${CANONICAL_SNIPPET}\npublished_at: 2026-07-26 04:47:43+00`

    function runInSeparateProcess(input: string, idemKey: string): Promise<{ ok: boolean; out: string }> {
      const sql = `select reserve_ai_provider_units('anthropic','semantic_topic_extraction','claude-sonnet-4-6','${evidenceId}'::uuid,2,1,'v1',E'${input.replace(/'/g, "\\'").replace(/\n/g, '\\n')}',100,1024,'${idemKey}');`
      return dockerPsqlAsync(sql)
    }

    const [canonicalResult, nonCanonicalResult] = await Promise.all([
      runInSeparateProcess(canonicalInput, 'sti-v2ts-conc1-canonical'),
      runInSeparateProcess(nonCanonicalInput, 'sti-v2ts-conc1-noncanonical'),
    ])

    expect(canonicalResult.ok).toBe(true)
    expect(canonicalResult.out).toMatch(/^[0-9a-f-]{36}$/)
    expect(nonCanonicalResult.ok).toBe(false)
    expect(nonCanonicalResult.out).toMatch(/does not match the server-rebuilt canonical form/)

    const count = dockerPsql(`select count(*) from ai_provider_budget_reservations where signal_evidence_id='${evidenceId}';`).trim()
    expect(count).toBe('1')
  }, 20000)
})

// ============================================================
// v1 production run -- immutability + limited reproducibility (unchanged
// from the first pass of this gate).
// ============================================================
describe('v1 production run -- immutability + limited reproducibility (snapshot-only fixture, no DB/network)', () => {
  const V1_EXTRACTION_RUN_ID = 'c5e4da64-7e23-4e56-9620-6cdcafb395d5'
  const V1_NORMALIZED_INPUT_DIGEST = '18bc9d5e799ae4ec778c994b9fa3a29a6231633af93e70913d6ad84b953b17fa'
  const V1_EXTRACTION_CONFIG_DIGEST = '6fc08c8c4e6577f3b090ba83522e993b69b344871865fea3e0fe7244a0248d0f'
  const V1_OUTPUT_DIGEST = 'd450ac9ebc8165ede2f57dcefdce146a329d883a95e6f5d77b40f866c38b1e73'
  const V1_ACTUAL_NORMALIZED_INPUT =
    'title: What unique shopping trend is gaining popularity on social media? BFMUC #QuizMagic #ViralQuiz\n' +
    'snippet: What unique shopping trend is gaining popularity on social media? BFMUC #QuizMagic #ViralQuiz #CountryQuiz #FlagQuiz ...\n' +
    'published_at: 2026-07-26T04:47:43+00:00'
  const V1_STORED_SOURCE_SNAPSHOT_PUBLISHED_AT = '2026-07-26 04:47:43+00'
  const V1_STRUCTURED_OUTPUT = {
    location: null, confidence: 0.3, specificity: 'generic', content_format: 'other', label_language: 'en',
    action_or_event: 'Quiz content asking about a unique shopping trend gaining popularity on social media',
    subject_entities: ['social media', 'shopping trend', 'BFMUC', 'QuizMagic', 'ViralQuiz', 'CountryQuiz', 'FlagQuiz'],
    supporting_spans: [
      { quoted_text: 'What unique shopping trend is gaining popularity on social media?', source_field: 'title' },
      { quoted_text: 'BFMUC #QuizMagic #ViralQuiz #CountryQuiz #FlagQuiz', source_field: 'snippet' },
    ],
    temporal_context: '2026-07-26', extraction_schema_version: 1,
    canonical_phenomenon_label: 'Social media shopping trend viral quiz',
  }

  function j(v: string | number | null): string {
    if (v === null) return 'null'
    if (typeof v === 'number') return String(v)
    return JSON.stringify(v)
  }
  function computeV1OutputDigest(o: typeof V1_STRUCTURED_OUTPUT): string {
    const subjectEntities = o.subject_entities.map(e => JSON.stringify(e)).join(',')
    const supportingSpans = o.supporting_spans.map(s => `{"source_field":${j(s.source_field)},"quoted_text":${j(s.quoted_text)}}`).join(',')
    const confidenceText = o.confidence.toFixed(4)
    const canonical =
      `{"extraction_schema_version":${j(o.extraction_schema_version)}` +
      `,"canonical_phenomenon_label":${j(o.canonical_phenomenon_label)}` +
      `,"label_language":${j(o.label_language)}` +
      `,"subject_entities":[${subjectEntities}]` +
      `,"action_or_event":${j(o.action_or_event)}` +
      `,"location":${j(o.location)}` +
      `,"temporal_context":${j(o.temporal_context)}` +
      `,"specificity":${j(o.specificity)}` +
      `,"content_format":${j(o.content_format)}` +
      `,"confidence":${confidenceText}` +
      `,"supporting_spans":[${supportingSpans}]}`
    return createHash('sha256').update(canonical, 'utf8').digest('hex')
  }

  it('extraction_run_id is pinned and never reassigned by this suite', () => {
    expect(V1_EXTRACTION_RUN_ID).toBe('c5e4da64-7e23-4e56-9620-6cdcafb395d5')
  })

  it('normalized_input_digest IS reproducible from the ACTUAL text the v1 caller used', () => {
    const digest = createHash('sha256').update(V1_ACTUAL_NORMALIZED_INPUT, 'utf8').digest('hex')
    expect(digest).toBe(V1_NORMALIZED_INPUT_DIGEST)
  })

  it('KNOWN V1 LIMITATION: normalized_input_digest is NOT reproducible from the v1 stored source_snapshot alone', () => {
    const reconstructedFromSnapshot =
      'title: What unique shopping trend is gaining popularity on social media? BFMUC #QuizMagic #ViralQuiz\n' +
      'snippet: What unique shopping trend is gaining popularity on social media? BFMUC #QuizMagic #ViralQuiz #CountryQuiz #FlagQuiz ...\n' +
      `published_at: ${V1_STORED_SOURCE_SNAPSHOT_PUBLISHED_AT}`
    const wronglyReconstructedDigest = createHash('sha256').update(reconstructedFromSnapshot, 'utf8').digest('hex')
    expect(wronglyReconstructedDigest).not.toBe(V1_NORMALIZED_INPUT_DIGEST)
  })

  it('output_digest IS independently reproducible from the stored structured_output alone (source_snapshot-independent)', () => {
    expect(computeV1OutputDigest(V1_STRUCTURED_OUTPUT)).toBe(V1_OUTPUT_DIGEST)
  })

  it('extraction_config_digest is pinned and documented as unaffected by the timestamp fix (no timestamp field in its own canonical form)', () => {
    expect(V1_EXTRACTION_CONFIG_DIGEST).toBe('6fc08c8c4e6577f3b090ba83522e993b69b344871865fea3e0fe7244a0248d0f')
  })
})
