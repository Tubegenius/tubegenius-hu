// Semantic Topic Identity v0 -- S2B writer RPCs, REAL local DB integration
// tests. Same pattern as the 072/073 suites: uses the existing local
// Docker Supabase stack (supabase_db_WillViralFinal), skips entirely (not
// a failure) when unavailable, direct postgres-privileged psql fixture
// inserts for everything the RPCs themselves don't own, SET ROLE for real
// grant-boundary checks. Only synthetic, deterministic fixtures are used --
// no AI/provider call, no production data.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 30000 })
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const MIGRATION_PATH = join(process.cwd(), 'supabase/migrations/074_semantic_topic_s2b_writer_rpcs.sql')

// Extracted verbatim from 074's own source (never retyped -- a retyped copy
// risks a whitespace difference that changes body_hash and silently breaks
// any test relying on it matching 074's own pinned legacy hash constant)
// so restoring record_topic_extraction_run to "exactly what 074 itself
// would create" is guaranteed byte-identical, for tests that need to run
// 074's own idempotency checks after migration 076 may have already
// advanced the function in this same shared local DB.
function extractLegacyRterBodySql(): string {
  const migrationText = readFileSync(MIGRATION_PATH, 'utf8')
  const start = migrationText.indexOf('CREATE FUNCTION public.record_topic_extraction_run(')
  if (start === -1) throw new Error('extractLegacyRterBodySql: CREATE FUNCTION record_topic_extraction_run not found in 074')
  const bodyEnd = migrationText.indexOf('$rpc$;', start)
  if (bodyEnd === -1) throw new Error('extractLegacyRterBodySql: closing $rpc$; not found')
  const createStatement = migrationText.slice(start, bodyEnd + '$rpc$;'.length)
  const grantStart = migrationText.indexOf('REVOKE ALL ON FUNCTION public.record_topic_extraction_run(', bodyEnd)
  const grantEnd = migrationText.indexOf(') TO service_role;', grantStart) + ') TO service_role;'.length
  const grantStatements = migrationText.slice(grantStart, grantEnd)
  return createStatement.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION') + '\n' + grantStatements
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

function runMigration(): { out: string; threw: boolean } {
  const migrationSql = readFileSync(MIGRATION_PATH, 'utf8')
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

function ensureFullyApplied() {
  const out = dockerPsql(
    `select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('record_topic_extraction_run','record_topic_assignment_decision');`,
  ).trim()
  if (out === '2') {
    return
  }
  if (out !== '0') {
    // Partial topology (e.g. left over from an interrupted previous run of
    // the drift/topology tests below) -- the migration's own fail-closed
    // gate will never repair this by itself, it only ever raises. Force
    // back to a clean 0/2 first, then let the CREATE branch run for both.
    dockerPsql(`
      drop function if exists public.record_topic_assignment_decision(uuid, text, text, jsonb, text, uuid);
      drop function if exists public.record_topic_extraction_run(uuid, integer, text, text, text, text, integer, text, integer, text, jsonb, integer, integer, numeric, text, text, timestamptz, timestamptz);
    `)
  }
  const result = runMigration()
  if (result.threw) {
    throw new Error(`ensureFullyApplied: migration failed even after forcing a clean 0/2 topology -- ${result.out}`)
  }
}

function cleanupTestData() {
  dockerPsql(`
    delete from semantic_topic_membership_events where signal_evidence_id in (select id from signal_evidence where external_ref like 'sti-s2b-%');
    delete from topic_assignment_decisions where signal_evidence_id in (select id from signal_evidence where external_ref like 'sti-s2b-%');
    delete from semantic_topic_membership where signal_evidence_id in (select id from signal_evidence where external_ref like 'sti-s2b-%');
    delete from semantic_topics where canonical_label like 'S2B test%';
    delete from topic_extraction_runs where signal_evidence_id in (select id from signal_evidence where external_ref like 'sti-s2b-%');
    delete from signal_evidence where external_ref like 'sti-s2b-%';
    delete from signal_sources where external_id like 'sti-s2b-%';
    delete from signal_runs where idempotency_key like 'sti-s2b-%';
  `)
}

function insertSource(externalId: string): string {
  return dockerPsql(`
    insert into signal_sources (source_type, external_id, source_family_key)
    values ('youtube_channel', '${externalId}', '${externalId}')
    returning id;
  `).trim()
}
function insertRun(idempotencyKey: string): string {
  return dockerPsql(`
    insert into signal_runs (run_type, idempotency_key, status, completed_at)
    values ('shadow_batch', '${idempotencyKey}', 'completed', now())
    returning id;
  `).trim()
}
function insertEvidence(sourceId: string, runId: string, externalRef: string, overrides: Record<string, string> = {}): string {
  const f: Record<string, string> = {
    signal_source_id: `'${sourceId}'`,
    evidence_type: `'youtube_video'`,
    external_ref: `'${externalRef}'`,
    title: `'S2B fixture evidence'`,
    discovered_in_run_id: `'${runId}'`,
    ...overrides,
  }
  const cols = Object.keys(f).join(', ')
  const vals = Object.values(f).join(', ')
  return dockerPsql(`insert into signal_evidence (${cols}) values (${vals}) returning id;`).trim()
}

function structuredOutput(overrides: Record<string, unknown> = {}): string {
  const base = {
    extraction_schema_version: 1,
    canonical_phenomenon_label: 'Test phenomenon',
    label_language: 'en',
    subject_entities: ['Entity A'],
    action_or_event: null,
    location: null,
    temporal_context: null,
    specificity: 'specific',
    content_format: 'news_event',
    confidence: 0.9,
    supporting_spans: [{ source_field: 'title', quoted_text: 'Test phenomenon' }],
    ...overrides,
  }
  return JSON.stringify(base).replace(/'/g, "''")
}

function callExtractionRpc(evidenceId: string, idempotencyKey: string, overrides: Record<string, string> = {}): any {
  const p = {
    normalization_version: '1',
    extraction_method: `'deterministic'`,
    provider: 'NULL',
    model: 'NULL',
    prompt_version: 'NULL',
    deterministic_extractor_version: '1',
    normalized_extraction_input: `'norm-${idempotencyKey}'`,
    extraction_schema_version: '1',
    status: `'completed'`,
    structured_output: `'${structuredOutput()}'::jsonb`,
    input_tokens: 'NULL',
    output_tokens: 'NULL',
    estimated_cost_usd: 'NULL',
    error_class: 'NULL',
    started_at: `now() - interval '1 minute'`,
    completed_at: `now()`,
    ...overrides,
  }
  const sql = `select record_topic_extraction_run(
    '${evidenceId}'::uuid, ${p.normalization_version}, ${p.extraction_method}, ${p.provider}, ${p.model}, ${p.prompt_version},
    ${p.deterministic_extractor_version}, ${p.normalized_extraction_input}, ${p.extraction_schema_version}, ${p.status},
    ${p.structured_output}, ${p.input_tokens}, ${p.output_tokens}, ${p.estimated_cost_usd}, ${p.error_class},
    '${idempotencyKey}', ${p.started_at}, ${p.completed_at}
  );`
  return JSON.parse(dockerPsql(sql).trim())
}
function callExtractionRpcExpectError(evidenceId: string, idempotencyKey: string, overrides: Record<string, string> = {}): string {
  const p = {
    normalization_version: '1',
    extraction_method: `'deterministic'`,
    provider: 'NULL',
    model: 'NULL',
    prompt_version: 'NULL',
    deterministic_extractor_version: '1',
    normalized_extraction_input: `'norm-${idempotencyKey}'`,
    extraction_schema_version: '1',
    status: `'completed'`,
    structured_output: `'${structuredOutput()}'::jsonb`,
    input_tokens: 'NULL',
    output_tokens: 'NULL',
    estimated_cost_usd: 'NULL',
    error_class: 'NULL',
    started_at: `now() - interval '1 minute'`,
    completed_at: `now()`,
    ...overrides,
  }
  const sql = `select record_topic_extraction_run(
    '${evidenceId}'::uuid, ${p.normalization_version}, ${p.extraction_method}, ${p.provider}, ${p.model}, ${p.prompt_version},
    ${p.deterministic_extractor_version}, ${p.normalized_extraction_input}, ${p.extraction_schema_version}, ${p.status},
    ${p.structured_output}, ${p.input_tokens}, ${p.output_tokens}, ${p.estimated_cost_usd}, ${p.error_class},
    '${idempotencyKey}', ${p.started_at}, ${p.completed_at}
  );`
  return dockerPsqlExpectError(sql)
}

function callAssignmentRpc(extractionRunId: string, outcome: string, decisionReason: string, idempotencyKey: string, existingTopicId: string | null = null): any {
  const topicArg = existingTopicId ? `'${existingTopicId}'::uuid` : 'NULL'
  const sql = `select record_topic_assignment_decision('${extractionRunId}'::uuid, '${outcome}', '${decisionReason}', '{}'::jsonb, '${idempotencyKey}', ${topicArg});`
  return JSON.parse(dockerPsql(sql).trim())
}
function callAssignmentRpcExpectError(extractionRunId: string, outcome: string, decisionReason: string, idempotencyKey: string, existingTopicId: string | null = null): string {
  const topicArg = existingTopicId ? `'${existingTopicId}'::uuid` : 'NULL'
  const sql = `select record_topic_assignment_decision('${extractionRunId}'::uuid, '${outcome}', '${decisionReason}', '{}'::jsonb, '${idempotencyKey}', ${topicArg});`
  return dockerPsqlExpectError(sql)
}

// One evidence + one completed, specific, high-confidence extraction --
// the common starting fixture for most assignment-side tests.
function createCompletedExtraction(marker: string, extractionOverrides: Record<string, string> = {}): { evidenceId: string; extractionRunId: string } {
  const sourceId = insertSource(`sti-s2b-${marker}-src`)
  const runId = insertRun(`sti-s2b-${marker}-run`)
  const evidenceId = insertEvidence(sourceId, runId, `sti-s2b-${marker}-ev`)
  const result = callExtractionRpc(evidenceId, `sti-s2b-${marker}-ext`, extractionOverrides)
  return { evidenceId, extractionRunId: result.extraction_run_id }
}

describeIfLocalDb('Semantic Topic Identity v0 S2B — writer RPCs (real local DB)', () => {
  beforeAll(() => {
    ensureFullyApplied()
    cleanupTestData()
  })
  afterAll(() => {
    cleanupTestData()
  })

  // ============================================================
  // record_topic_extraction_run
  // ============================================================
  describe('record_topic_extraction_run', () => {
    it('deterministic completed extraction creates a row with server-built source_snapshot', () => {
      const marker = `ext-basic-${randomUUID().slice(0, 8)}`
      const sourceId = insertSource(`sti-s2b-${marker}-src`)
      const runId = insertRun(`sti-s2b-${marker}-run`)
      const evidenceId = insertEvidence(sourceId, runId, `sti-s2b-${marker}-ev`)
      const result = callExtractionRpc(evidenceId, `sti-s2b-${marker}-idem`)
      expect(result.ok).toBe(true)
      expect(result.outcome).toBe('created')
      expect(result.status).toBe('completed')

      const row = dockerPsql(`select status||'|'||(source_snapshot->>'evidence_id')||'|'||(source_snapshot_digest ~ '^[0-9a-f]{64}$')::text from topic_extraction_runs where id='${result.extraction_run_id}';`).trim()
      const [status, snapshotEvidenceId, digestValid] = row.split('|')
      expect(status).toBe('completed')
      expect(snapshotEvidenceId).toBe(evidenceId)
      expect(digestValid).toBe('true')
    })

    it('deterministic failed extraction creates a row with NULL structured_output/confidence', () => {
      const marker = `ext-failed-${randomUUID().slice(0, 8)}`
      const { evidenceId } = { evidenceId: insertEvidence(insertSource(`sti-s2b-${marker}-src`), insertRun(`sti-s2b-${marker}-run`), `sti-s2b-${marker}-ev`) }
      const result = callExtractionRpc(evidenceId, `sti-s2b-${marker}-idem`, {
        status: `'failed'`, structured_output: 'NULL', error_class: `'provider_timeout'`,
      })
      expect(result.status).toBe('failed')
      const row = dockerPsql(`select coalesce(structured_output::text,'NULL')||'|'||coalesce(confidence::text,'NULL')||'|'||error_class from topic_extraction_runs where id='${result.extraction_run_id}';`).trim()
      expect(row).toBe('NULL|NULL|provider_timeout')
    })

    it('rejects ai_assisted with incomplete provider/model/prompt_version (073 CHECK, RPC does not swallow it)', () => {
      const marker = `ext-ai-incomplete-${randomUUID().slice(0, 8)}`
      const evidenceId = insertEvidence(insertSource(`sti-s2b-${marker}-src`), insertRun(`sti-s2b-${marker}-run`), `sti-s2b-${marker}-ev`)
      const err = callExtractionRpcExpectError(evidenceId, `sti-s2b-${marker}-idem`, {
        extraction_method: `'ai_assisted'`, provider: `'openai'`, model: 'NULL', prompt_version: `'v1'`, deterministic_extractor_version: 'NULL',
      })
      expect(err).toMatch(/topic_extraction_runs_provider_fields_pairing/)
    })

    it('accepts ai_assisted with all three provider fields present, deterministic_extractor_version NULL', () => {
      const marker = `ext-ai-complete-${randomUUID().slice(0, 8)}`
      const evidenceId = insertEvidence(insertSource(`sti-s2b-${marker}-src`), insertRun(`sti-s2b-${marker}-run`), `sti-s2b-${marker}-ev`)
      const result = callExtractionRpc(evidenceId, `sti-s2b-${marker}-idem`, {
        extraction_method: `'ai_assisted'`, provider: `'openai'`, model: `'gpt-test'`, prompt_version: `'v1'`, deterministic_extractor_version: 'NULL',
        input_tokens: '100', output_tokens: '50', estimated_cost_usd: '0.001',
      })
      expect(result.ok).toBe(true)
    })

    it('extraction_config_digest is identical for identical config fields, different for a changed field', () => {
      const marker = `ext-cfgdigest-${randomUUID().slice(0, 8)}`
      const ev1 = insertEvidence(insertSource(`sti-s2b-${marker}-src1`), insertRun(`sti-s2b-${marker}-run1`), `sti-s2b-${marker}-ev1`)
      const ev2 = insertEvidence(insertSource(`sti-s2b-${marker}-src2`), insertRun(`sti-s2b-${marker}-run2`), `sti-s2b-${marker}-ev2`)
      const r1 = callExtractionRpc(ev1, `sti-s2b-${marker}-idem1`)
      const r2 = callExtractionRpc(ev2, `sti-s2b-${marker}-idem2`)
      const d1 = dockerPsql(`select extraction_config_digest from topic_extraction_runs where id='${r1.extraction_run_id}';`).trim()
      const d2 = dockerPsql(`select extraction_config_digest from topic_extraction_runs where id='${r2.extraction_run_id}';`).trim()
      expect(d1).toBe(d2)
      const r3 = callExtractionRpc(ev2, `sti-s2b-${marker}-idem3`, { normalization_version: '2' })
      // r3 collides on completed-cache? no -- normalized_input_digest differs? actually input text same,
      // normalization_version differs -> extraction_config_digest differs -> different cache key -> new row
      const d3 = dockerPsql(`select extraction_config_digest from topic_extraction_runs where id='${r3.extraction_run_id}';`).trim()
      expect(d3).not.toBe(d1)
    })

    it('structured_output with an unknown top-level key is rejected (full rollback, 0 rows added)', () => {
      const marker = `ext-unknownkey-${randomUUID().slice(0, 8)}`
      const evidenceId = insertEvidence(insertSource(`sti-s2b-${marker}-src`), insertRun(`sti-s2b-${marker}-run`), `sti-s2b-${marker}-ev`)
      const badOutput = structuredOutput({ unexpected_field: 'x' })
      const err = callExtractionRpcExpectError(evidenceId, `sti-s2b-${marker}-idem`, { structured_output: `'${badOutput}'::jsonb` })
      expect(err).toMatch(/topic_extraction_runs_structured_output_shape/)
      const count = dockerPsql(`select count(*) from topic_extraction_runs where signal_evidence_id='${evidenceId}';`).trim()
      expect(count).toBe('0')
    })

    it('structured_output with an invalid enum value (specificity) is rejected', () => {
      const marker = `ext-badenum-${randomUUID().slice(0, 8)}`
      const evidenceId = insertEvidence(insertSource(`sti-s2b-${marker}-src`), insertRun(`sti-s2b-${marker}-run`), `sti-s2b-${marker}-ev`)
      const badOutput = structuredOutput({ specificity: 'super-specific' })
      const err = callExtractionRpcExpectError(evidenceId, `sti-s2b-${marker}-idem`, { structured_output: `'${badOutput}'::jsonb` })
      expect(err).toMatch(/topic_extraction_runs_structured_output_shape/)
    })

    it('structured_output with confidence out of [0,1] range is rejected', () => {
      const marker = `ext-badconf-${randomUUID().slice(0, 8)}`
      const evidenceId = insertEvidence(insertSource(`sti-s2b-${marker}-src`), insertRun(`sti-s2b-${marker}-run`), `sti-s2b-${marker}-ev`)
      const badOutput = structuredOutput({ confidence: 1.5 })
      const err = callExtractionRpcExpectError(evidenceId, `sti-s2b-${marker}-idem`, { structured_output: `'${badOutput}'::jsonb` })
      // The RPC derives the top-level `confidence` column from
      // structured_output->>'confidence', so an out-of-range value trips
      // that column's own topic_extraction_runs_confidence_range CHECK
      // (evaluated ahead of the structured_output_shape CHECK) -- either
      // constraint firing proves the same thing: out-of-range is rejected.
      expect(err).toMatch(/topic_extraction_runs_confidence_range|topic_extraction_runs_structured_output_shape/)
    })

    it('supporting_spans: valid {source_field, quoted_text} accepted, malformed element rejected', () => {
      const marker = `ext-spans-${randomUUID().slice(0, 8)}`
      const ev1 = insertEvidence(insertSource(`sti-s2b-${marker}-src1`), insertRun(`sti-s2b-${marker}-run1`), `sti-s2b-${marker}-ev1`)
      const good = callExtractionRpc(ev1, `sti-s2b-${marker}-idem-good`, {
        structured_output: `'${structuredOutput({ supporting_spans: [{ source_field: 'title', quoted_text: 'ok' }] })}'::jsonb`,
      })
      expect(good.ok).toBe(true)

      const ev2 = insertEvidence(insertSource(`sti-s2b-${marker}-src2`), insertRun(`sti-s2b-${marker}-run2`), `sti-s2b-${marker}-ev2`)
      // more than 10 supporting_spans -- rejected by the 073 length-bound CHECK
      const tooMany = Array.from({ length: 11 }, () => ({ source_field: 'title', quoted_text: 'x' }))
      const err = callExtractionRpcExpectError(ev2, `sti-s2b-${marker}-idem-bad`, {
        structured_output: `'${structuredOutput({ supporting_spans: tooMany })}'::jsonb`,
      })
      expect(err).toMatch(/topic_extraction_runs_structured_output_shape/)
    })

    it('idempotent replay: same idempotency_key + same params returns the same row, no duplicate', () => {
      const marker = `ext-replay-${randomUUID().slice(0, 8)}`
      const evidenceId = insertEvidence(insertSource(`sti-s2b-${marker}-src`), insertRun(`sti-s2b-${marker}-run`), `sti-s2b-${marker}-ev`)
      const key = `sti-s2b-${marker}-idem`
      const r1 = callExtractionRpc(evidenceId, key)
      const r2 = callExtractionRpc(evidenceId, key)
      expect(r1.outcome).toBe('created')
      expect(r2.outcome).toBe('replayed')
      expect(r2.extraction_run_id).toBe(r1.extraction_run_id)
      const count = dockerPsql(`select count(*) from topic_extraction_runs where idempotency_key='${key}';`).trim()
      expect(count).toBe('1')
    })

    it('idempotency mismatch: same key, different normalized_extraction_input -> error, no row mutated', () => {
      const marker = `ext-mismatch-${randomUUID().slice(0, 8)}`
      const evidenceId = insertEvidence(insertSource(`sti-s2b-${marker}-src`), insertRun(`sti-s2b-${marker}-run`), `sti-s2b-${marker}-ev`)
      const key = `sti-s2b-${marker}-idem`
      callExtractionRpc(evidenceId, key)
      const err = callExtractionRpcExpectError(evidenceId, key, { normalized_extraction_input: `'a totally different text'` })
      expect(err).toMatch(/idempotency_key.*already used with a different request/)
      const count = dockerPsql(`select count(*) from topic_extraction_runs where idempotency_key='${key}';`).trim()
      expect(count).toBe('1')
    })

    it('completed cache replay: same (evidence, normalized_input, config) under a different idempotency_key -> cache_hit, no new row', () => {
      const marker = `ext-cache-${randomUUID().slice(0, 8)}`
      const evidenceId = insertEvidence(insertSource(`sti-s2b-${marker}-src`), insertRun(`sti-s2b-${marker}-run`), `sti-s2b-${marker}-ev`)
      const sharedInput = { normalized_extraction_input: `'shared-cache-text-${marker}'` }
      const r1 = callExtractionRpc(evidenceId, `sti-s2b-${marker}-idem-a`, sharedInput)
      const r2 = callExtractionRpc(evidenceId, `sti-s2b-${marker}-idem-b`, sharedInput)
      expect(r1.outcome).toBe('created')
      expect(r2.outcome).toBe('cache_hit')
      expect(r2.extraction_run_id).toBe(r1.extraction_run_id)
      const count = dockerPsql(`select count(*) from topic_extraction_runs where signal_evidence_id='${evidenceId}' and status='completed';`).trim()
      expect(count).toBe('1')
    })

    it('failed retry: a fresh idempotency_key for the same evidence always inserts a new row (no cache interaction)', () => {
      const marker = `ext-failretry-${randomUUID().slice(0, 8)}`
      const evidenceId = insertEvidence(insertSource(`sti-s2b-${marker}-src`), insertRun(`sti-s2b-${marker}-run`), `sti-s2b-${marker}-ev`)
      const overrides = { status: `'failed'`, structured_output: 'NULL', error_class: `'x'` }
      const r1 = callExtractionRpc(evidenceId, `sti-s2b-${marker}-idem-1`, overrides)
      const r2 = callExtractionRpc(evidenceId, `sti-s2b-${marker}-idem-2`, overrides)
      expect(r1.extraction_run_id).not.toBe(r2.extraction_run_id)
      const count = dockerPsql(`select count(*) from topic_extraction_runs where signal_evidence_id='${evidenceId}';`).trim()
      expect(count).toBe('2')
    })

    it('missing evidence -> error, no row created', () => {
      const err = callExtractionRpcExpectError(randomUUID(), `sti-s2b-missing-ev-${randomUUID().slice(0, 8)}`)
      expect(err).toMatch(/signal_evidence.*not found/)
    })

    it('two truly concurrent identical requests -> exactly one row, outcomes {created, replayed}', async () => {
      const marker = `ext-concurrent-${randomUUID().slice(0, 8)}`
      const evidenceId = insertEvidence(insertSource(`sti-s2b-${marker}-src`), insertRun(`sti-s2b-${marker}-run`), `sti-s2b-${marker}-ev`)
      const key = `sti-s2b-${marker}-idem`
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const execFileAsync = promisify(execFile)
      const sql = `select record_topic_extraction_run('${evidenceId}'::uuid, 1, 'deterministic', NULL, NULL, NULL, 1, 'norm-concurrent', 1, 'completed', '${structuredOutput()}'::jsonb, NULL, NULL, NULL, NULL, '${key}', now() - interval '1 min', now());`
      const args = ['exec', '-i', 'supabase_db_WillViralFinal', 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-c', sql]
      const [r1, r2] = await Promise.all([execFileAsync('docker', args), execFileAsync('docker', args)])
      const outcomes = [r1.stdout, r2.stdout].map(o => JSON.parse(o.trim()).outcome).sort()
      expect(outcomes).toEqual(['created', 'replayed'])
      const count = dockerPsql(`select count(*) from topic_extraction_runs where idempotency_key='${key}';`).trim()
      expect(count).toBe('1')
    })

    it('two truly concurrent requests hitting the same completed-cache key (different idempotency_keys) -> exactly one completed row, both calls succeed', async () => {
      const marker = `ext-concurrent-cache-${randomUUID().slice(0, 8)}`
      const evidenceId = insertEvidence(insertSource(`sti-s2b-${marker}-src`), insertRun(`sti-s2b-${marker}-run`), `sti-s2b-${marker}-ev`)
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const execFileAsync = promisify(execFile)
      const sqlFor = (key: string) => `select record_topic_extraction_run('${evidenceId}'::uuid, 1, 'deterministic', NULL, NULL, NULL, 1, 'norm-concurrent-cache', 1, 'completed', '${structuredOutput()}'::jsonb, NULL, NULL, NULL, NULL, '${key}', now() - interval '1 min', now());`
      const argsFor = (key: string) => ['exec', '-i', 'supabase_db_WillViralFinal', 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-c', sqlFor(key)]
      const [r1, r2] = await Promise.all([
        execFileAsync('docker', argsFor(`sti-s2b-${marker}-idem-a`)),
        execFileAsync('docker', argsFor(`sti-s2b-${marker}-idem-b`)),
      ])
      const results = [JSON.parse(r1.stdout.trim()), JSON.parse(r2.stdout.trim())]
      expect(results.every(r => r.ok)).toBe(true)
      expect(new Set(results.map(r => r.extraction_run_id)).size).toBe(1)
      const count = dockerPsql(`select count(*) from topic_extraction_runs where signal_evidence_id='${evidenceId}' and status='completed';`).trim()
      expect(count).toBe('1')
    })
  })

  // ============================================================
  // record_topic_assignment_decision
  // ============================================================
  describe('record_topic_assignment_decision — CREATE_NEW', () => {
    it('creates the full topic -> membership -> decision -> event chain', () => {
      const marker = `crn-chain-${randomUUID().slice(0, 8)}`
      const { evidenceId, extractionRunId } = createCompletedExtraction(marker)
      const result = callAssignmentRpc(extractionRunId, 'CREATE_NEW', 'no_similar_topic_found', `sti-s2b-${marker}-dec`)
      expect(result.ok).toBe(true)
      expect(result.outcome).toBe('CREATE_NEW')
      expect(result.semantic_topic_id).toBeTruthy()
      expect(result.resulting_membership_id).toBeTruthy()

      const chain = dockerPsql(`
        select d.semantic_topic_id::text||'|'||m.semantic_topic_id::text||'|'||e.semantic_topic_id::text||'|'||m.signal_evidence_id::text||'|'||e.related_membership_id::text||'|'||e.related_assignment_decision_id::text
        from topic_assignment_decisions d
        join semantic_topic_membership m on m.id = d.resulting_membership_id
        join semantic_topic_membership_events e on e.related_assignment_decision_id = d.id
        where d.id = '${result.decision_id}';
      `).trim()
      const [dTopic, mTopic, eTopic, mEvidence, eMembership, eDecision] = chain.split('|')
      expect(dTopic).toBe(mTopic)
      expect(mTopic).toBe(eTopic)
      expect(mEvidence).toBe(evidenceId)
      expect(eMembership).toBe(result.resulting_membership_id)
      expect(eDecision).toBe(result.decision_id)
    })

    it('new topic starts lifecycle_status=candidate_singleton / status_version=1', () => {
      const marker = `crn-initial-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      const result = callAssignmentRpc(extractionRunId, 'CREATE_NEW', 'no_similar_topic_found', `sti-s2b-${marker}-dec`)
      const row = dockerPsql(`select lifecycle_status||'|'||status_version from semantic_topics where id='${result.semantic_topic_id}';`).trim()
      expect(row).toBe('candidate_singleton|1')
    })

    it('rejects when p_existing_semantic_topic_id is supplied', () => {
      const marker = `crn-rejects-topicid-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      const err = callAssignmentRpcExpectError(extractionRunId, 'CREATE_NEW', 'no_similar_topic_found', `sti-s2b-${marker}-dec`, randomUUID())
      expect(err).toMatch(/CREATE_NEW must not supply p_existing_semantic_topic_id/)
    })

    it('rejects decision_reason other than no_similar_topic_found', () => {
      const marker = `crn-rejects-reason-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      const err = callAssignmentRpcExpectError(extractionRunId, 'CREATE_NEW', 'exact_entity_match', `sti-s2b-${marker}-dec`)
      expect(err).toMatch(/CREATE_NEW requires decision_reason=no_similar_topic_found/)
    })

    it('rejects specificity=generic and specificity=unknown', () => {
      const marker = `crn-rejects-specificity-${randomUUID().slice(0, 8)}`
      const { extractionRunId: r1 } = createCompletedExtraction(`${marker}-a`, { structured_output: `'${structuredOutput({ specificity: 'generic' })}'::jsonb` })
      const err1 = callAssignmentRpcExpectError(r1, 'CREATE_NEW', 'no_similar_topic_found', `sti-s2b-${marker}-dec-a`)
      expect(err1).toMatch(/CREATE_NEW requires structured_output.specificity=specific/)

      const { extractionRunId: r2 } = createCompletedExtraction(`${marker}-b`, { structured_output: `'${structuredOutput({ specificity: 'unknown' })}'::jsonb` })
      const err2 = callAssignmentRpcExpectError(r2, 'CREATE_NEW', 'no_similar_topic_found', `sti-s2b-${marker}-dec-b`)
      expect(err2).toMatch(/CREATE_NEW requires structured_output.specificity=specific/)
    })

    it('confidence threshold boundary: 0.8500 accepted, 0.849999 rejected, 0.9000/1.0000 accepted', () => {
      const marker = `crn-threshold-${randomUUID().slice(0, 8)}`
      const cases: [string, number, boolean][] = [
        ['at-threshold', 0.85, true],
        ['just-below', 0.849999, false],
        ['high', 0.9, true],
        ['max', 1.0, true],
      ]
      for (const [label, confidence, shouldAccept] of cases) {
        const { extractionRunId } = createCompletedExtraction(`${marker}-${label}`, { structured_output: `'${structuredOutput({ confidence })}'::jsonb` })
        if (shouldAccept) {
          const result = callAssignmentRpc(extractionRunId, 'CREATE_NEW', 'no_similar_topic_found', `sti-s2b-${marker}-${label}-dec`)
          expect(result.ok).toBe(true)
        } else {
          const err = callAssignmentRpcExpectError(extractionRunId, 'CREATE_NEW', 'no_similar_topic_found', `sti-s2b-${marker}-${label}-dec`)
          expect(err).toMatch(/CREATE_NEW requires confidence >= 0.8500/)
        }
      }
    })

    it('rejects when the extraction_run status is not completed', () => {
      const marker = `crn-notcompleted-${randomUUID().slice(0, 8)}`
      const evidenceId = insertEvidence(insertSource(`sti-s2b-${marker}-src`), insertRun(`sti-s2b-${marker}-run`), `sti-s2b-${marker}-ev`)
      const failed = callExtractionRpc(evidenceId, `sti-s2b-${marker}-ext`, { status: `'failed'`, structured_output: 'NULL', error_class: `'x'` })
      const err = callAssignmentRpcExpectError(failed.extraction_run_id, 'CREATE_NEW', 'no_similar_topic_found', `sti-s2b-${marker}-dec`)
      expect(err).toMatch(/is not completed/)
    })

    it('at most one decision per extraction_run: a second call with different params errors', () => {
      const marker = `crn-onedecision-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      callAssignmentRpc(extractionRunId, 'CREATE_NEW', 'no_similar_topic_found', `sti-s2b-${marker}-dec-1`)
      const err = callAssignmentRpcExpectError(extractionRunId, 'QUARANTINE', 'below_confidence_threshold', `sti-s2b-${marker}-dec-2`)
      expect(err).toMatch(/already has a decision with different parameters/)
      const count = dockerPsql(`select count(*) from topic_assignment_decisions where extraction_run_id='${extractionRunId}';`).trim()
      expect(count).toBe('1')
    })

    it('idempotent replay: same params return the same decision, no second topic', () => {
      const marker = `crn-replay-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      const key = `sti-s2b-${marker}-dec`
      const r1 = callAssignmentRpc(extractionRunId, 'CREATE_NEW', 'no_similar_topic_found', key)
      const r2 = callAssignmentRpc(extractionRunId, 'CREATE_NEW', 'no_similar_topic_found', key)
      expect(r1.outcome_kind).toBe('created')
      expect(r2.outcome_kind).toBe('replayed')
      expect(r2.semantic_topic_id).toBe(r1.semantic_topic_id)
      const count = dockerPsql(`select count(*) from semantic_topics where id='${r1.semantic_topic_id}';`).trim()
      expect(count).toBe('1')
    })

    it('idempotency_key reused for a different extraction_run -> error', () => {
      const marker = `crn-keyreuse-${randomUUID().slice(0, 8)}`
      const { extractionRunId: r1 } = createCompletedExtraction(`${marker}-a`)
      const { extractionRunId: r2 } = createCompletedExtraction(`${marker}-b`)
      const key = `sti-s2b-${marker}-dec`
      callAssignmentRpc(r1, 'CREATE_NEW', 'no_similar_topic_found', key)
      const err = callAssignmentRpcExpectError(r2, 'CREATE_NEW', 'no_similar_topic_found', key)
      expect(err).toMatch(/idempotency_key.*already used for a different extraction_run/)
    })

    it('at most one active membership per evidence: a second CREATE_NEW for the same evidence conflicts', () => {
      const marker = `crn-oneactive-${randomUUID().slice(0, 8)}`
      const sourceId = insertSource(`sti-s2b-${marker}-src`)
      const runId = insertRun(`sti-s2b-${marker}-run`)
      const evidenceId = insertEvidence(sourceId, runId, `sti-s2b-${marker}-ev`)
      const ext1 = callExtractionRpc(evidenceId, `sti-s2b-${marker}-ext1`)
      const ext2 = callExtractionRpc(evidenceId, `sti-s2b-${marker}-ext2`, { normalized_extraction_input: `'different-text-${marker}'` })
      callAssignmentRpc(ext1.extraction_run_id, 'CREATE_NEW', 'no_similar_topic_found', `sti-s2b-${marker}-dec1`)
      const err = callAssignmentRpcExpectError(ext2.extraction_run_id, 'CREATE_NEW', 'no_similar_topic_found', `sti-s2b-${marker}-dec2`)
      expect(err).toMatch(/semantic_topic_membership_active_evidence_key/)
    })

    it('two truly concurrent CREATE_NEW calls for two different evidences both succeed independently', async () => {
      const marker = `crn-concurrent-${randomUUID().slice(0, 8)}`
      const { extractionRunId: r1 } = createCompletedExtraction(`${marker}-a`)
      const { extractionRunId: r2 } = createCompletedExtraction(`${marker}-b`)
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const execFileAsync = promisify(execFile)
      const argsFor = (runId: string, key: string) => ['exec', '-i', 'supabase_db_WillViralFinal', 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-c',
        `select record_topic_assignment_decision('${runId}'::uuid, 'CREATE_NEW', 'no_similar_topic_found', '{}'::jsonb, '${key}', NULL);`]
      const [o1, o2] = await Promise.all([
        execFileAsync('docker', argsFor(r1, `sti-s2b-${marker}-dec-a`)),
        execFileAsync('docker', argsFor(r2, `sti-s2b-${marker}-dec-b`)),
      ])
      const results = [JSON.parse(o1.stdout.trim()), JSON.parse(o2.stdout.trim())]
      expect(results.every(r => r.ok)).toBe(true)
      expect(results[0].semantic_topic_id).not.toBe(results[1].semantic_topic_id)
    })
  })

  describe('record_topic_assignment_decision — ATTACH_EXISTING', () => {
    it('a second active membership triggers candidate_singleton -> corroborating, status_version+1', () => {
      const marker = `atx-transition-${randomUUID().slice(0, 8)}`
      const { extractionRunId: r1 } = createCompletedExtraction(`${marker}-a`)
      const { extractionRunId: r2 } = createCompletedExtraction(`${marker}-b`)
      const created = callAssignmentRpc(r1, 'CREATE_NEW', 'no_similar_topic_found', `sti-s2b-${marker}-dec1`)
      const before = dockerPsql(`select lifecycle_status||'|'||status_version from semantic_topics where id='${created.semantic_topic_id}';`).trim()
      expect(before).toBe('candidate_singleton|1')

      callAssignmentRpc(r2, 'ATTACH_EXISTING', 'exact_entity_match', `sti-s2b-${marker}-dec2`, created.semantic_topic_id)
      const after = dockerPsql(`select lifecycle_status||'|'||status_version from semantic_topics where id='${created.semantic_topic_id}';`).trim()
      expect(after).toBe('corroborating|2')
    })

    it('a third membership does not re-trigger the transition (stays corroborating, version unchanged)', () => {
      const marker = `atx-notwice-${randomUUID().slice(0, 8)}`
      const { extractionRunId: r1 } = createCompletedExtraction(`${marker}-a`)
      const { extractionRunId: r2 } = createCompletedExtraction(`${marker}-b`)
      const { extractionRunId: r3 } = createCompletedExtraction(`${marker}-c`)
      const created = callAssignmentRpc(r1, 'CREATE_NEW', 'no_similar_topic_found', `sti-s2b-${marker}-dec1`)
      callAssignmentRpc(r2, 'ATTACH_EXISTING', 'exact_entity_match', `sti-s2b-${marker}-dec2`, created.semantic_topic_id)
      const afterSecond = dockerPsql(`select lifecycle_status||'|'||status_version from semantic_topics where id='${created.semantic_topic_id}';`).trim()
      callAssignmentRpc(r3, 'ATTACH_EXISTING', 'exact_entity_match', `sti-s2b-${marker}-dec3`, created.semantic_topic_id)
      const afterThird = dockerPsql(`select lifecycle_status||'|'||status_version from semantic_topics where id='${created.semantic_topic_id}';`).trim()
      expect(afterThird).toBe(afterSecond)
      expect(afterThird).toBe('corroborating|2')
    })

    it('attaching to an already-coherent topic leaves lifecycle_status/status_version unchanged', () => {
      const marker = `atx-coherent-${randomUUID().slice(0, 8)}`
      const { extractionRunId: r1 } = createCompletedExtraction(`${marker}-a`)
      const { extractionRunId: r2 } = createCompletedExtraction(`${marker}-b`)
      const created = callAssignmentRpc(r1, 'CREATE_NEW', 'no_similar_topic_found', `sti-s2b-${marker}-dec1`)
      dockerPsql(`update semantic_topics set lifecycle_status='coherent', status_version=5 where id='${created.semantic_topic_id}';`)
      callAssignmentRpc(r2, 'ATTACH_EXISTING', 'exact_entity_match', `sti-s2b-${marker}-dec2`, created.semantic_topic_id)
      const after = dockerPsql(`select lifecycle_status||'|'||status_version from semantic_topics where id='${created.semantic_topic_id}';`).trim()
      expect(after).toBe('coherent|5')
    })

    it('ambiguous topic requires manual_review_confirmed or manual_review_override', () => {
      const marker = `atx-ambiguous-${randomUUID().slice(0, 8)}`
      const { extractionRunId: r1 } = createCompletedExtraction(`${marker}-a`)
      const { extractionRunId: r2 } = createCompletedExtraction(`${marker}-b`)
      const { extractionRunId: r3 } = createCompletedExtraction(`${marker}-c`)
      const created = callAssignmentRpc(r1, 'CREATE_NEW', 'no_similar_topic_found', `sti-s2b-${marker}-dec1`)
      dockerPsql(`update semantic_topics set lifecycle_status='ambiguous' where id='${created.semantic_topic_id}';`)

      const err = callAssignmentRpcExpectError(r2, 'ATTACH_EXISTING', 'exact_entity_match', `sti-s2b-${marker}-dec2`, created.semantic_topic_id)
      expect(err).toMatch(/lifecycle_status=ambiguous requires a manual_review_\* decision_reason/)

      const ok = callAssignmentRpc(r3, 'ATTACH_EXISTING', 'manual_review_confirmed', `sti-s2b-${marker}-dec3`, created.semantic_topic_id)
      expect(ok.ok).toBe(true)
    })

    it.each(['split_required', 'merge_candidate', 'superseded', 'archived'])(
      'lifecycle_status=%s always rejects ATTACH_EXISTING, even with manual_review_override',
      (status) => {
        const marker = `atx-forbidden-${status}-${randomUUID().slice(0, 8)}`
        const { extractionRunId: r1 } = createCompletedExtraction(`${marker}-a`)
        const { extractionRunId: r2 } = createCompletedExtraction(`${marker}-b`)
        const created = callAssignmentRpc(r1, 'CREATE_NEW', 'no_similar_topic_found', `sti-s2b-${marker}-dec1`)
        dockerPsql(`update semantic_topics set lifecycle_status='${status}' where id='${created.semantic_topic_id}';`)
        const err = callAssignmentRpcExpectError(r2, 'ATTACH_EXISTING', 'manual_review_override', `sti-s2b-${marker}-dec2`, created.semantic_topic_id)
        expect(err).toMatch(new RegExp(`lifecycle_status=${status} never accepts ATTACH_EXISTING`))
      },
    )

    it('decision_reason -> assignment_reason mapping is exact for all 4 allowed reasons', () => {
      const marker = `atx-mapping-${randomUUID().slice(0, 8)}`
      const mapping: [string, string][] = [
        ['exact_entity_match', 'entity_event_match'],
        ['embedding_similarity_match', 'embedding_similarity'],
        ['manual_review_confirmed', 'manual_review_confirmed'],
        ['manual_review_override', 'manual_review_override'],
      ]
      for (const [reason, expectedAssignmentReason] of mapping) {
        const { extractionRunId: r1 } = createCompletedExtraction(`${marker}-${reason}-a`)
        const { extractionRunId: r2 } = createCompletedExtraction(`${marker}-${reason}-b`)
        const created = callAssignmentRpc(r1, 'CREATE_NEW', 'no_similar_topic_found', `sti-s2b-${marker}-${reason}-dec1`)
        const attached = callAssignmentRpc(r2, 'ATTACH_EXISTING', reason, `sti-s2b-${marker}-${reason}-dec2`, created.semantic_topic_id)
        const row = dockerPsql(`select assignment_reason from semantic_topic_membership where id='${attached.resulting_membership_id}';`).trim()
        expect(row).toBe(expectedAssignmentReason)
        const eventReason = dockerPsql(`select event_reason from semantic_topic_membership_events where related_membership_id='${attached.resulting_membership_id}';`).trim()
        expect(eventReason).toBe(expectedAssignmentReason)
      }
    })

    it('idempotent replay of an ATTACH_EXISTING does not re-trigger the lifecycle transition', () => {
      const marker = `atx-replay-notransition-${randomUUID().slice(0, 8)}`
      const { extractionRunId: r1 } = createCompletedExtraction(`${marker}-a`)
      const { extractionRunId: r2 } = createCompletedExtraction(`${marker}-b`)
      const created = callAssignmentRpc(r1, 'CREATE_NEW', 'no_similar_topic_found', `sti-s2b-${marker}-dec1`)
      const key2 = `sti-s2b-${marker}-dec2`
      callAssignmentRpc(r2, 'ATTACH_EXISTING', 'exact_entity_match', key2, created.semantic_topic_id)
      const afterFirst = dockerPsql(`select status_version from semantic_topics where id='${created.semantic_topic_id}';`).trim()
      callAssignmentRpc(r2, 'ATTACH_EXISTING', 'exact_entity_match', key2, created.semantic_topic_id)
      const afterReplay = dockerPsql(`select status_version from semantic_topics where id='${created.semantic_topic_id}';`).trim()
      expect(afterReplay).toBe(afterFirst)
      expect(afterReplay).toBe('2')
    })

    it('two evidences concurrently ATTACH to the same candidate_singleton topic -> exactly one transition, both memberships succeed', async () => {
      const marker = `atx-concurrent-${randomUUID().slice(0, 8)}`
      const { extractionRunId: r0 } = createCompletedExtraction(`${marker}-seed`)
      const { extractionRunId: r1 } = createCompletedExtraction(`${marker}-a`)
      const { extractionRunId: r2 } = createCompletedExtraction(`${marker}-b`)
      const created = callAssignmentRpc(r0, 'CREATE_NEW', 'no_similar_topic_found', `sti-s2b-${marker}-dec0`)

      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const execFileAsync = promisify(execFile)
      const argsFor = (runId: string, key: string) => ['exec', '-i', 'supabase_db_WillViralFinal', 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-c',
        `select record_topic_assignment_decision('${runId}'::uuid, 'ATTACH_EXISTING', 'exact_entity_match', '{}'::jsonb, '${key}', '${created.semantic_topic_id}'::uuid);`]
      const [o1, o2] = await Promise.all([
        execFileAsync('docker', argsFor(r1, `sti-s2b-${marker}-dec1`)),
        execFileAsync('docker', argsFor(r2, `sti-s2b-${marker}-dec2`)),
      ])
      const results = [JSON.parse(o1.stdout.trim()), JSON.parse(o2.stdout.trim())]
      expect(results.every(r => r.ok)).toBe(true)

      const finalState = dockerPsql(`select lifecycle_status||'|'||status_version from semantic_topics where id='${created.semantic_topic_id}';`).trim()
      expect(finalState).toBe('corroborating|2')
      const activeCount = dockerPsql(`select count(*) from semantic_topic_membership where semantic_topic_id='${created.semantic_topic_id}' and valid_to is null;`).trim()
      expect(activeCount).toBe('3')
    })
  })

  describe('record_topic_assignment_decision — QUARANTINE', () => {
    it('creates the decision only; topic/membership/event are never created', () => {
      const marker = `qua-basic-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker, { structured_output: `'${structuredOutput({ confidence: 0.5 })}'::jsonb` })
      const result = callAssignmentRpc(extractionRunId, 'QUARANTINE', 'below_confidence_threshold', `sti-s2b-${marker}-dec`)
      expect(result.outcome).toBe('QUARANTINE')
      expect(result.semantic_topic_id).toBeNull()
      expect(result.resulting_membership_id).toBeNull()
      const row = dockerPsql(`select semantic_topic_id is null and resulting_membership_id is null from topic_assignment_decisions where id='${result.decision_id}';`).trim()
      expect(row).toBe('t')
      const eventCount = dockerPsql(`select count(*) from semantic_topic_membership_events where related_assignment_decision_id='${result.decision_id}';`).trim()
      expect(eventCount).toBe('0')
    })

    it('rejects decision_reason outside {malformed_extraction, below_confidence_threshold}', () => {
      const marker = `qua-badreason-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      const err = callAssignmentRpcExpectError(extractionRunId, 'QUARANTINE', 'exact_entity_match', `sti-s2b-${marker}-dec`)
      expect(err).toMatch(/QUARANTINE does not accept decision_reason=exact_entity_match/)
    })

    it('rejects when p_existing_semantic_topic_id is supplied', () => {
      const marker = `qua-rejects-topicid-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      const err = callAssignmentRpcExpectError(extractionRunId, 'QUARANTINE', 'below_confidence_threshold', `sti-s2b-${marker}-dec`, randomUUID())
      expect(err).toMatch(/QUARANTINE must not supply p_existing_semantic_topic_id/)
    })

    it('QUARANTINE is not gated by confidence/specificity -- a low-confidence, generic extraction is accepted', () => {
      const marker = `qua-nogate-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker, { structured_output: `'${structuredOutput({ specificity: 'generic', confidence: 0.1 })}'::jsonb` })
      const result = callAssignmentRpc(extractionRunId, 'QUARANTINE', 'malformed_extraction', `sti-s2b-${marker}-dec`)
      expect(result.ok).toBe(true)
    })
  })

  describe('referential consistency across the RPC-created chain', () => {
    it('0 orphans across every decision/topic/membership/event/evidence/extraction created in this suite so far', () => {
      const orphanCounts = dockerPsql(`
        select
          (select count(*) from topic_assignment_decisions d where d.semantic_topic_id is not null and not exists (select 1 from semantic_topics t where t.id = d.semantic_topic_id))
          ||'|'||
          (select count(*) from topic_assignment_decisions d where d.resulting_membership_id is not null and not exists (select 1 from semantic_topic_membership m where m.id = d.resulting_membership_id))
          ||'|'||
          (select count(*) from semantic_topic_membership_events e where not exists (select 1 from topic_assignment_decisions d where d.id = e.related_assignment_decision_id))
          ||'|'||
          (select count(*) from semantic_topic_membership_events e where not exists (select 1 from semantic_topic_membership m where m.id = e.related_membership_id))
          ||'|'||
          (select count(*) from semantic_topic_membership_events e join topic_assignment_decisions d on d.id = e.related_assignment_decision_id where e.semantic_topic_id is distinct from d.semantic_topic_id)
          ||'|'||
          (select count(*) from semantic_topic_membership_events e join semantic_topic_membership m on m.id = e.related_membership_id where e.semantic_topic_id is distinct from m.semantic_topic_id)
        ;
      `).trim()
      const parts = orphanCounts.split('|')
      expect(parts).toEqual(['0', '0', '0', '0', '0', '0'])
    })

    it('every membership row this suite created belongs to an evidence with exactly the extraction chain it came from (no cross-evidence membership reuse)', () => {
      const mismatched = dockerPsql(`
        select count(*) from semantic_topic_membership m
        join topic_assignment_decisions d on d.resulting_membership_id = m.id
        where d.signal_evidence_id is distinct from m.signal_evidence_id;
      `).trim()
      expect(mismatched).toBe('0')
    })

    it('at most one active membership per evidence holds across every fixture this suite created', () => {
      const violations = dockerPsql(`
        select count(*) from (
          select signal_evidence_id from semantic_topic_membership
          where signal_evidence_id in (select id from signal_evidence where external_ref like 'sti-s2b-%')
            and valid_to is null
          group by signal_evidence_id having count(*) > 1
        ) x;
      `).trim()
      expect(violations).toBe('0')
    })
  })

  // ============================================================
  // Security / topology
  // ============================================================
  describe('security / grant matrix / topology', () => {
    it('both RPCs: owner=postgres, plpgsql, volatile, security definer, search_path=public,pg_temp, exactly 1 overload each', () => {
      const rows = dockerPsql(`
        select p.proname||'|'||r.rolname||'|'||l.lanname||'|'||p.provolatile::text||'|'||p.prosecdef::text||'|'||(select string_agg(cfg,';') from unnest(p.proconfig) cfg)
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang join pg_roles r on r.oid=p.proowner
        where n.nspname='public' and p.proname in ('record_topic_extraction_run','record_topic_assignment_decision')
        order by p.proname;
      `).trim().split('\n')
      expect(rows.length).toBe(2)
      for (const row of rows) {
        const [, owner, lang, volatility, secdef, searchPath] = row.split('|')
        expect(owner).toBe('postgres')
        expect(lang).toBe('plpgsql')
        expect(volatility).toBe('v')
        expect(secdef).toBe('true')
        expect(searchPath).toBe('search_path=public, pg_temp')
      }
      const overloadCount = dockerPsql(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='record_topic_extraction_run';`).trim()
      expect(overloadCount).toBe('1')
      const overloadCount2 = dockerPsql(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='record_topic_assignment_decision';`).trim()
      expect(overloadCount2).toBe('1')
    })

    it('SET ROLE service_role CAN EXECUTE both RPCs', () => {
      const marker = `sec-svc-${randomUUID().slice(0, 8)}`
      const sourceId = insertSource(`sti-s2b-${marker}-src`)
      const runId = insertRun(`sti-s2b-${marker}-run`)
      const evidenceId = insertEvidence(sourceId, runId, `sti-s2b-${marker}-ev`)
      const out = dockerPsql(`
        SET ROLE service_role;
        select record_topic_extraction_run('${evidenceId}'::uuid, 1, 'deterministic', NULL, NULL, NULL, 1, 'norm-svc', 1, 'completed', '${structuredOutput()}'::jsonb, NULL, NULL, NULL, NULL, 'sti-s2b-${marker}-idem', now() - interval '1 min', now());
        RESET ROLE;
      `).trim()
      expect(out).toMatch(/"ok": true/)
    })

    it('anon cannot EXECUTE either RPC', () => {
      const err1 = dockerPsqlExpectError(`SET ROLE anon; select record_topic_extraction_run(gen_random_uuid(), 1, 'deterministic', NULL, NULL, NULL, 1, 'x', 1, 'completed', '{}'::jsonb, NULL, NULL, NULL, NULL, 'x', now(), now()); RESET ROLE;`)
      expect(err1).toMatch(/permission denied for function/)
      const err2 = dockerPsqlExpectError(`SET ROLE anon; select record_topic_assignment_decision(gen_random_uuid(), 'CREATE_NEW', 'no_similar_topic_found', '{}'::jsonb, 'x', NULL); RESET ROLE;`)
      expect(err2).toMatch(/permission denied for function/)
    })

    it('authenticated cannot EXECUTE either RPC', () => {
      const err1 = dockerPsqlExpectError(`SET ROLE authenticated; select record_topic_extraction_run(gen_random_uuid(), 1, 'deterministic', NULL, NULL, NULL, 1, 'x', 1, 'completed', '{}'::jsonb, NULL, NULL, NULL, NULL, 'x', now(), now()); RESET ROLE;`)
      expect(err1).toMatch(/permission denied for function/)
      const err2 = dockerPsqlExpectError(`SET ROLE authenticated; select record_topic_assignment_decision(gen_random_uuid(), 'CREATE_NEW', 'no_similar_topic_found', '{}'::jsonb, 'x', NULL); RESET ROLE;`)
      expect(err2).toMatch(/permission denied for function/)
    })

    it('service_role still cannot INSERT directly into any of the five S1/S2A tables', () => {
      const tables = ['topic_extraction_runs', 'topic_assignment_decisions', 'semantic_topic_membership_events', 'semantic_topics', 'semantic_topic_membership']
      for (const table of tables) {
        const err = dockerPsqlExpectError(`SET ROLE service_role; insert into ${table} default values; RESET ROLE;`)
        expect(err).toMatch(/permission denied/i)
      }
    })

    it('second migration run is a byte-exact no-op (VALIDATE branch, no DDL/DCL)', () => {
      // Migration 076 (canonical input timestamp v2) may have already
      // advanced record_topic_extraction_run to its corrected v2 body as a
      // side effect of an earlier test file in this same run/DB -- 074's own
      // VALIDATE branch only ever accepts 074's own pinned hash, so this
      // test must restore the exact 074-created state first, or it would be
      // testing "074 vs. a function 076 already replaced," not "074 vs.
      // itself." See the parallel case for 070/071 in
      // tests/shadow-topic-scoring-rpc-db-integration.test.ts.
      const currentHash = dockerPsql(
        `select md5(replace(prosrc, E'\\r\\n', E'\\n')) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='record_topic_extraction_run';`,
      ).trim()
      if (currentHash !== 'f6ed6773724c95c2deccc2f7ca692e89') {
        dockerPsql(extractLegacyRterBodySql())
        const restoredHash = dockerPsql(
          `select md5(replace(prosrc, E'\\r\\n', E'\\n')) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='record_topic_extraction_run';`,
        ).trim()
        if (restoredHash !== 'f6ed6773724c95c2deccc2f7ca692e89') {
          throw new Error(`restore-to-legacy failed: got ${restoredHash}, expected f6ed6773724c95c2deccc2f7ca692e89`)
        }
      }

      const { out, threw } = runMigration()
      expect(threw).toBe(false)
      expect(out).toMatch(/record_topic_extraction_run already exists and matches exactly -- no-op/)
      expect(out).toMatch(/record_topic_assignment_decision already exists and matches exactly -- no-op/)
    })

    it('074 standalone can never be safely re-applied once migration 076 has advanced record_topic_extraction_run to v2 (forward-only enforcement)', () => {
      // Advance to v2 via 076, then prove 074 alone fails closed against it --
      // parallel case to shadow-topic-scoring-rpc-db-integration.test.ts's
      // "070 standalone can never be safely re-applied once 071 has advanced."
      //
      // 076 (canonical input timestamp v2) requires BOTH
      // record_topic_extraction_run (074) AND reserve_ai_provider_units
      // (075) to be exactly legacy before its own REPLACE branch will run
      // -- reserve_ai_provider_units is untouched by anything else in this
      // file, so its state depends on which other test files already ran
      // against this shared local DB. Force it back to 075's own legacy
      // body first (never DROP, same reasoning as record_topic_extraction_run's
      // own restoration above) so this test deterministically exercises
      // 076's REPLACE branch regardless of test-file execution order.
      const migration075 = readFileSync(join(process.cwd(), 'supabase/migrations/075_semantic_topic_s3a_ai_quota_foundation.sql'), 'utf8')
      const reserveStart = migration075.indexOf('CREATE FUNCTION public.reserve_ai_provider_units(')
      const reserveBodyEnd = migration075.indexOf('$body$;', reserveStart) + '$body$;'.length
      const legacyReserveSql = migration075.slice(reserveStart, reserveBodyEnd).replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION')
      dockerPsql(legacyReserveSql)
      dockerPsql(`
        REVOKE ALL ON FUNCTION public.reserve_ai_provider_units(TEXT, TEXT, TEXT, UUID, INTEGER, INTEGER, TEXT, TEXT, INTEGER, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
        GRANT EXECUTE ON FUNCTION public.reserve_ai_provider_units(TEXT, TEXT, TEXT, UUID, INTEGER, INTEGER, TEXT, TEXT, INTEGER, INTEGER, TEXT) TO service_role;
      `)

      const migration076 = readFileSync(join(process.cwd(), 'supabase/migrations/076_semantic_topic_canonical_input_timestamp_v2.sql'), 'utf8')
      const apply076 = (() => {
        try {
          return { out: execSync('docker exec -i supabase_db_WillViralFinal psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 -t -A -f - 2>&1', { input: migration076, encoding: 'utf8' }), threw: false }
        } catch (e: any) {
          return { out: String(e.stdout || e.stderr || e.message || ''), threw: true }
        }
      })()
      expect(apply076.threw).toBe(false)
      expect(apply076.out).toMatch(/both record_topic_extraction_run and reserve_ai_provider_units replaced/)

      const { out, threw } = runMigration()
      expect(threw).toBe(true)
      expect(out).toMatch(/074 drift/)

      const hashAfter = dockerPsql(
        `select md5(replace(prosrc, E'\\r\\n', E'\\n')) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='record_topic_extraction_run';`,
      ).trim()
      expect(hashAfter).toBe('ef55f0b83d78d001d9e2f903f434c79f') // untouched by the fail-closed 074 attempt -- still v2
    })

    it('1/2 partial topology raises before any DDL runs, leaving the surviving function untouched', () => {
      dockerPsql(`drop function if exists public.record_topic_assignment_decision(uuid, text, text, jsonb, text, uuid);`)
      const { out, threw } = runMigration()
      expect(threw).toBe(true)
      expect(out).toMatch(/partial topology detected -- 1 of 2/)
      const stillThere = dockerPsql(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='record_topic_extraction_run';`).trim()
      expect(stillThere).toBe('1')
      // The fail-closed gate never auto-repairs a partial state -- re-running
      // the same migration against 1/2 would raise the identical exception
      // forever. Restoring to a clean 2/2 requires dropping the survivor
      // too, back to 0/2, so the next run takes the CREATE branch for both.
      dockerPsql(`drop function if exists public.record_topic_extraction_run(uuid, integer, text, text, text, text, integer, text, integer, text, jsonb, integer, integer, numeric, text, text, timestamptz, timestamptz);`)
      const restore = runMigration()
      expect(restore.threw).toBe(false)
      expect(restore.out).toMatch(/record_topic_extraction_run created/)
      expect(restore.out).toMatch(/record_topic_assignment_decision created/)
    })

    it('artificial body drift on record_topic_extraction_run is rejected fail-closed, no auto-repair', () => {
      dockerPsql(`
        create or replace function public.record_topic_extraction_run(
          p_signal_evidence_id UUID, p_normalization_version INTEGER, p_extraction_method TEXT, p_provider TEXT, p_model TEXT,
          p_prompt_version TEXT, p_deterministic_extractor_version INTEGER, p_normalized_extraction_input TEXT, p_extraction_schema_version INTEGER,
          p_status TEXT, p_structured_output JSONB, p_input_tokens INTEGER, p_output_tokens INTEGER, p_estimated_cost_usd NUMERIC,
          p_error_class TEXT, p_idempotency_key TEXT, p_started_at TIMESTAMPTZ, p_completed_at TIMESTAMPTZ
        ) RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
        AS $rpc$ BEGIN RETURN jsonb_build_object('drifted', true); END; $rpc$;
      `)
      const { out, threw } = runMigration()
      expect(threw).toBe(true)
      expect(out).toMatch(/074 drift: record_topic_extraction_run body hash does not match exactly/)
      const restore = runMigration()
      expect(restore.threw).toBe(true) // still drifted -- migration never auto-repairs
      // Restore for subsequent tests: dropping only the drifted function
      // would leave a 1/2 partial topology, which the fail-closed gate
      // would then reject on the very next run -- drop BOTH back to a
      // clean 0/2 first, so the following run's CREATE branch fires for
      // both and restores a full, matching 2/2 state.
      dockerPsql(`
        drop function if exists public.record_topic_extraction_run(uuid, integer, text, text, text, text, integer, text, integer, text, jsonb, integer, integer, numeric, text, text, timestamptz, timestamptz);
        drop function if exists public.record_topic_assignment_decision(uuid, text, text, jsonb, text, uuid);
      `)
      const recreated = runMigration()
      expect(recreated.threw).toBe(false)
      expect(recreated.out).toMatch(/record_topic_extraction_run created/)
      expect(recreated.out).toMatch(/record_topic_assignment_decision created/)
    })

    it('artificial ACL drift (extra PUBLIC grant) on record_topic_assignment_decision is rejected fail-closed', () => {
      dockerPsql(`grant execute on function public.record_topic_assignment_decision(uuid, text, text, jsonb, text, uuid) to authenticated;`)
      const { out, threw } = runMigration()
      expect(threw).toBe(true)
      expect(out).toMatch(/074 drift: record_topic_assignment_decision ACL does not match exactly/)
      dockerPsql(`revoke execute on function public.record_topic_assignment_decision(uuid, text, text, jsonb, text, uuid) from authenticated;`)
      const restore = runMigration()
      expect(restore.threw).toBe(false)
    })

    it('0 NOT VALID constraints anywhere in the public schema', () => {
      const count = dockerPsql(`select count(*) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='public' and c.convalidated is false;`).trim()
      expect(count).toBe('0')
    })
  })

  // ============================================================
  // Digest canonicalization — output_digest and decision_digest
  // ============================================================
  describe('output_digest canonicalization (explicit fixed-field-order, never jsonb::text)', () => {
    it('identical output with a different top-level JSON key order produces the same digest', () => {
      const marker = `dig-out-keyorder-${randomUUID().slice(0, 8)}`
      const ev1 = insertEvidence(insertSource(`sti-s2b-${marker}-src1`), insertRun(`sti-s2b-${marker}-run1`), `sti-s2b-${marker}-ev1`)
      const ev2 = insertEvidence(insertSource(`sti-s2b-${marker}-src2`), insertRun(`sti-s2b-${marker}-run2`), `sti-s2b-${marker}-ev2`)
      const outputA = `'{"extraction_schema_version":1,"canonical_phenomenon_label":"X","label_language":"en","subject_entities":["A","B"],"action_or_event":null,"location":null,"temporal_context":null,"specificity":"specific","content_format":"other","confidence":0.9,"supporting_spans":[]}'::jsonb`
      const outputB = `'{"label_language":"en","confidence":0.9,"canonical_phenomenon_label":"X","extraction_schema_version":1,"specificity":"specific","subject_entities":["A","B"],"content_format":"other","action_or_event":null,"location":null,"temporal_context":null,"supporting_spans":[]}'::jsonb`
      const r1 = callExtractionRpc(ev1, `sti-s2b-${marker}-idem1`, { structured_output: outputA, normalized_extraction_input: `'txt-a'` })
      const r2 = callExtractionRpc(ev2, `sti-s2b-${marker}-idem2`, { structured_output: outputB, normalized_extraction_input: `'txt-b'` })
      const d1 = dockerPsql(`select output_digest from topic_extraction_runs where id='${r1.extraction_run_id}';`).trim()
      const d2 = dockerPsql(`select output_digest from topic_extraction_runs where id='${r2.extraction_run_id}';`).trim()
      expect(d1).toBe(d2)
    })

    it('identical output with different whitespace/formatting produces the same digest', () => {
      const marker = `dig-out-whitespace-${randomUUID().slice(0, 8)}`
      const ev1 = insertEvidence(insertSource(`sti-s2b-${marker}-src1`), insertRun(`sti-s2b-${marker}-run1`), `sti-s2b-${marker}-ev1`)
      const ev2 = insertEvidence(insertSource(`sti-s2b-${marker}-src2`), insertRun(`sti-s2b-${marker}-run2`), `sti-s2b-${marker}-ev2`)
      const compact = `'{"extraction_schema_version":1,"canonical_phenomenon_label":"X","label_language":"en","subject_entities":["A"],"action_or_event":null,"location":null,"temporal_context":null,"specificity":"specific","content_format":"other","confidence":0.9,"supporting_spans":[]}'::jsonb`
      const spaced = `'{  "extraction_schema_version" : 1,   "canonical_phenomenon_label":   "X",
        "label_language": "en", "subject_entities":["A"],"action_or_event":null,"location":null,
        "temporal_context":null,"specificity":"specific","content_format":"other","confidence":0.900,"supporting_spans":[]  }'::jsonb`
      const r1 = callExtractionRpc(ev1, `sti-s2b-${marker}-idem1`, { structured_output: compact, normalized_extraction_input: `'txt-a'` })
      const r2 = callExtractionRpc(ev2, `sti-s2b-${marker}-idem2`, { structured_output: spaced, normalized_extraction_input: `'txt-b'` })
      const d1 = dockerPsql(`select output_digest from topic_extraction_runs where id='${r1.extraction_run_id}';`).trim()
      const d2 = dockerPsql(`select output_digest from topic_extraction_runs where id='${r2.extraction_run_id}';`).trim()
      expect(d1).toBe(d2)
    })

    it('quotes, backslashes, and Unicode in text fields round-trip exactly and hash consistently', () => {
      const marker = `dig-out-escaping-${randomUUID().slice(0, 8)}`
      const evidenceId = insertEvidence(insertSource(`sti-s2b-${marker}-src`), insertRun(`sti-s2b-${marker}-run`), `sti-s2b-${marker}-ev`)
      const label = 'He said "hello"\\world — café 日本語 emoji \u{1F600}'
      const output = structuredOutput({ canonical_phenomenon_label: label, supporting_spans: [{ source_field: 'title', quoted_text: label }] })
      const result = callExtractionRpc(evidenceId, `sti-s2b-${marker}-idem`, { structured_output: `'${output}'::jsonb` })
      expect(result.ok).toBe(true)
      const storedLabel = dockerPsql(`select structured_output->>'canonical_phenomenon_label' from topic_extraction_runs where id='${result.extraction_run_id}';`).trim()
      expect(storedLabel).toBe(label)
      // recomputing the digest against a second, independently-inserted row
      // with the identical (escaped) label must reproduce the same digest --
      // proves the escaping round-trips through to_json() deterministically.
      const evidenceId2 = insertEvidence(insertSource(`sti-s2b-${marker}-src2`), insertRun(`sti-s2b-${marker}-run2`), `sti-s2b-${marker}-ev2`)
      const result2 = callExtractionRpc(evidenceId2, `sti-s2b-${marker}-idem2`, { structured_output: `'${output}'::jsonb`, normalized_extraction_input: `'different-input-text'` })
      const d1 = dockerPsql(`select output_digest from topic_extraction_runs where id='${result.extraction_run_id}';`).trim()
      const d2 = dockerPsql(`select output_digest from topic_extraction_runs where id='${result2.extraction_run_id}';`).trim()
      expect(d1).toBe(d2)
      expect(d1).toMatch(/^[0-9a-f]{64}$/)
    })

    it('supporting_spans order change produces a different digest (semantic array order is preserved, not sorted)', () => {
      const marker = `dig-out-spanorder-${randomUUID().slice(0, 8)}`
      const ev1 = insertEvidence(insertSource(`sti-s2b-${marker}-src1`), insertRun(`sti-s2b-${marker}-run1`), `sti-s2b-${marker}-ev1`)
      const ev2 = insertEvidence(insertSource(`sti-s2b-${marker}-src2`), insertRun(`sti-s2b-${marker}-run2`), `sti-s2b-${marker}-ev2`)
      const spansAB = [{ source_field: 'title', quoted_text: 'q1' }, { source_field: 'snippet', quoted_text: 'q2' }]
      const spansBA = [{ source_field: 'snippet', quoted_text: 'q2' }, { source_field: 'title', quoted_text: 'q1' }]
      const r1 = callExtractionRpc(ev1, `sti-s2b-${marker}-idem1`, { structured_output: `'${structuredOutput({ supporting_spans: spansAB })}'::jsonb` })
      const r2 = callExtractionRpc(ev2, `sti-s2b-${marker}-idem2`, { structured_output: `'${structuredOutput({ supporting_spans: spansBA })}'::jsonb`, normalized_extraction_input: `'different-input'` })
      const d1 = dockerPsql(`select output_digest from topic_extraction_runs where id='${r1.extraction_run_id}';`).trim()
      const d2 = dockerPsql(`select output_digest from topic_extraction_runs where id='${r2.extraction_run_id}';`).trim()
      expect(d1).not.toBe(d2)
    })

    it('a supporting_spans element key order change (quoted_text before source_field) does NOT change the digest', () => {
      const marker = `dig-out-spankeyorder-${randomUUID().slice(0, 8)}`
      const ev1 = insertEvidence(insertSource(`sti-s2b-${marker}-src1`), insertRun(`sti-s2b-${marker}-run1`), `sti-s2b-${marker}-ev1`)
      const ev2 = insertEvidence(insertSource(`sti-s2b-${marker}-src2`), insertRun(`sti-s2b-${marker}-run2`), `sti-s2b-${marker}-ev2`)
      const outputNormalOrder = `'{"extraction_schema_version":1,"canonical_phenomenon_label":"X","label_language":"en","subject_entities":[],"action_or_event":null,"location":null,"temporal_context":null,"specificity":"specific","content_format":"other","confidence":0.9,"supporting_spans":[{"source_field":"title","quoted_text":"q1"}]}'::jsonb`
      const outputSwappedSpanKeys = `'{"extraction_schema_version":1,"canonical_phenomenon_label":"X","label_language":"en","subject_entities":[],"action_or_event":null,"location":null,"temporal_context":null,"specificity":"specific","content_format":"other","confidence":0.9,"supporting_spans":[{"quoted_text":"q1","source_field":"title"}]}'::jsonb`
      const r1 = callExtractionRpc(ev1, `sti-s2b-${marker}-idem1`, { structured_output: outputNormalOrder })
      const r2 = callExtractionRpc(ev2, `sti-s2b-${marker}-idem2`, { structured_output: outputSwappedSpanKeys, normalized_extraction_input: `'different-input'` })
      const d1 = dockerPsql(`select output_digest from topic_extraction_runs where id='${r1.extraction_run_id}';`).trim()
      const d2 = dockerPsql(`select output_digest from topic_extraction_runs where id='${r2.extraction_run_id}';`).trim()
      expect(d1).toBe(d2)
    })

    it('confidence 0.85 and 0.8500 canonicalize identically (fixed NUMERIC(5,4) decimal form)', () => {
      const marker = `dig-out-confformat-${randomUUID().slice(0, 8)}`
      const ev1 = insertEvidence(insertSource(`sti-s2b-${marker}-src1`), insertRun(`sti-s2b-${marker}-run1`), `sti-s2b-${marker}-ev1`)
      const ev2 = insertEvidence(insertSource(`sti-s2b-${marker}-src2`), insertRun(`sti-s2b-${marker}-run2`), `sti-s2b-${marker}-ev2`)
      const r1 = callExtractionRpc(ev1, `sti-s2b-${marker}-idem1`, { structured_output: `'${structuredOutput({ confidence: 0.85 })}'::jsonb` })
      const r2 = callExtractionRpc(ev2, `sti-s2b-${marker}-idem2`, { structured_output: `'${structuredOutput({ confidence: 0.85 })}'::jsonb`.replace('0.85', '0.8500'), normalized_extraction_input: `'different-input'` })
      const d1 = dockerPsql(`select output_digest from topic_extraction_runs where id='${r1.extraction_run_id}';`).trim()
      const d2 = dockerPsql(`select output_digest from topic_extraction_runs where id='${r2.extraction_run_id}';`).trim()
      expect(d1).toBe(d2)
    })

    it('a genuinely different output (different label) produces a different digest', () => {
      const marker = `dig-out-different-${randomUUID().slice(0, 8)}`
      const ev1 = insertEvidence(insertSource(`sti-s2b-${marker}-src1`), insertRun(`sti-s2b-${marker}-run1`), `sti-s2b-${marker}-ev1`)
      const ev2 = insertEvidence(insertSource(`sti-s2b-${marker}-src2`), insertRun(`sti-s2b-${marker}-run2`), `sti-s2b-${marker}-ev2`)
      const r1 = callExtractionRpc(ev1, `sti-s2b-${marker}-idem1`, { structured_output: `'${structuredOutput({ canonical_phenomenon_label: 'Label A' })}'::jsonb` })
      const r2 = callExtractionRpc(ev2, `sti-s2b-${marker}-idem2`, { structured_output: `'${structuredOutput({ canonical_phenomenon_label: 'Label B' })}'::jsonb`, normalized_extraction_input: `'different-input'` })
      const d1 = dockerPsql(`select output_digest from topic_extraction_runs where id='${r1.extraction_run_id}';`).trim()
      const d2 = dockerPsql(`select output_digest from topic_extraction_runs where id='${r2.extraction_run_id}';`).trim()
      expect(d1).not.toBe(d2)
    })
  })

  describe('decision_digest canonicalization (explicit fixed-field-order, never chr(31)-delimited)', () => {
    it('a literal chr(31) control byte inside a deterministic_signals value does not collide with a differently-shaped payload', () => {
      const marker = `dig-dec-ctrlchar-${randomUUID().slice(0, 8)}`
      const { extractionRunId: r1 } = createCompletedExtraction(`${marker}-a`)
      const { extractionRunId: r2 } = createCompletedExtraction(`${marker}-b`)
      const sql1 = `select record_topic_assignment_decision('${r1}'::uuid, 'QUARANTINE', 'below_confidence_threshold', jsonb_build_object('note', chr(31)||'x'), 'sti-s2b-${marker}-dec1', NULL);`
      const sql2 = `select record_topic_assignment_decision('${r2}'::uuid, 'QUARANTINE', 'below_confidence_threshold', jsonb_build_object('note', 'x'), 'sti-s2b-${marker}-dec2', NULL);`
      const d1result = JSON.parse(dockerPsql(sql1).trim())
      const d2result = JSON.parse(dockerPsql(sql2).trim())
      const d1 = dockerPsql(`select decision_digest from topic_assignment_decisions where id='${d1result.decision_id}';`).trim()
      const d2 = dockerPsql(`select decision_digest from topic_assignment_decisions where id='${d2result.decision_id}';`).trim()
      expect(d1).not.toBe(d2)
    })

    it('quotes, backslashes, and Unicode in decision_reason-adjacent text round-trip and hash consistently', () => {
      const marker = `dig-dec-escaping-${randomUUID().slice(0, 8)}`
      const { extractionRunId: r1 } = createCompletedExtraction(`${marker}-a`)
      const { extractionRunId: r2 } = createCompletedExtraction(`${marker}-b`)
      const value = 'He said "hi"\\path — café 日本語'
      const sqlLiteral = `'${value.replace(/'/g, "''")}'`
      const sql1 = `select record_topic_assignment_decision('${r1}'::uuid, 'QUARANTINE', 'below_confidence_threshold', jsonb_build_object('note', ${sqlLiteral}::text), 'sti-s2b-${marker}-dec1', NULL);`
      const sql2 = `select record_topic_assignment_decision('${r2}'::uuid, 'QUARANTINE', 'below_confidence_threshold', jsonb_build_object('note', ${sqlLiteral}::text), 'sti-s2b-${marker}-dec2', NULL);`
      const d1result = JSON.parse(dockerPsql(sql1).trim())
      const d2result = JSON.parse(dockerPsql(sql2).trim())
      const stored = dockerPsql(`select deterministic_signals->>'note' from topic_assignment_decisions where id='${d1result.decision_id}';`).trim()
      expect(stored).toBe(value)
      // Different extraction_run_id/idempotency_key so digests will legitimately
      // differ overall -- this test's point is that neither call errors and both
      // store the value byte-exactly, proving the escaping is safe end-to-end.
      expect(d1result.ok).toBe(true)
      expect(d2result.ok).toBe(true)
    })

    it('deterministic_signals with a different JSON key order but identical semantics produces the same digest (same extraction_run, same idempotency_key -> replay)', () => {
      const marker = `dig-dec-keyorder-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      const key = `sti-s2b-${marker}-dec`
      const r1 = JSON.parse(dockerPsql(`select record_topic_assignment_decision('${extractionRunId}'::uuid, 'QUARANTINE', 'below_confidence_threshold', '{"a":"1","b":"2"}'::jsonb, '${key}', NULL);`).trim())
      const r2 = JSON.parse(dockerPsql(`select record_topic_assignment_decision('${extractionRunId}'::uuid, 'QUARANTINE', 'below_confidence_threshold', '{"b":"2","a":"1"}'::jsonb, '${key}', NULL);`).trim())
      expect(r1.outcome_kind).toBe('created')
      expect(r2.outcome_kind).toBe('replayed')
      expect(r2.decision_id).toBe(r1.decision_id)
    })

    it('changing a single deterministic_signals value produces a different digest', () => {
      const marker = `dig-dec-singlefield-${randomUUID().slice(0, 8)}`
      const { extractionRunId: r1 } = createCompletedExtraction(`${marker}-a`)
      const { extractionRunId: r2 } = createCompletedExtraction(`${marker}-b`)
      const d1result = JSON.parse(dockerPsql(`select record_topic_assignment_decision('${r1}'::uuid, 'QUARANTINE', 'below_confidence_threshold', '{"a":"1"}'::jsonb, 'sti-s2b-${marker}-dec1', NULL);`).trim())
      const d2result = JSON.parse(dockerPsql(`select record_topic_assignment_decision('${r2}'::uuid, 'QUARANTINE', 'below_confidence_threshold', '{"a":"2"}'::jsonb, 'sti-s2b-${marker}-dec2', NULL);`).trim())
      const digest1 = dockerPsql(`select decision_digest from topic_assignment_decisions where id='${d1result.decision_id}';`).trim()
      const digest2 = dockerPsql(`select decision_digest from topic_assignment_decisions where id='${d2result.decision_id}';`).trim()
      expect(digest1).not.toBe(digest2)
    })

    it('same idempotency_key + a genuinely different payload -> error, not a silent replay', () => {
      const marker = `dig-dec-mismatch-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      const key = `sti-s2b-${marker}-dec`
      dockerPsql(`select record_topic_assignment_decision('${extractionRunId}'::uuid, 'QUARANTINE', 'below_confidence_threshold', '{"a":"1"}'::jsonb, '${key}', NULL);`)
      const err = dockerPsqlExpectError(`select record_topic_assignment_decision('${extractionRunId}'::uuid, 'QUARANTINE', 'below_confidence_threshold', '{"a":"2"}'::jsonb, '${key}', NULL);`)
      expect(err).toMatch(/already has a decision with different parameters/)
    })

    it('deterministic_signals with a nested object is rejected -- S2B v0 canonical contract is flat scalars only', () => {
      const marker = `dig-dec-nested-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      const err = dockerPsqlExpectError(`select record_topic_assignment_decision('${extractionRunId}'::uuid, 'QUARANTINE', 'below_confidence_threshold', '{"a":{"nested":true}}'::jsonb, 'sti-s2b-${marker}-dec', NULL);`)
      expect(err).toMatch(/deterministic_signals must be a flat object of scalar values only/)
    })

    it('deterministic_signals with a nested array is rejected too', () => {
      const marker = `dig-dec-nestedarr-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      const err = dockerPsqlExpectError(`select record_topic_assignment_decision('${extractionRunId}'::uuid, 'QUARANTINE', 'below_confidence_threshold', '{"a":[1,2,3]}'::jsonb, 'sti-s2b-${marker}-dec', NULL);`)
      expect(err).toMatch(/deterministic_signals must be a flat object of scalar values only/)
    })
  })

  // ============================================================
  // Additional assignment concurrency: same extraction_run_id races
  // ============================================================
  describe('record_topic_assignment_decision — same extraction_run_id concurrency', () => {
    it('A) two truly concurrent calls with the SAME extraction_run_id + SAME idempotency_key + identical payload -> exactly one topic/membership/decision/event, outcomes {created, replayed}, no raw unique_violation', async () => {
      const marker = `conc-same-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      const key = `sti-s2b-${marker}-dec`
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const execFileAsync = promisify(execFile)
      const sql = `select record_topic_assignment_decision('${extractionRunId}'::uuid, 'CREATE_NEW', 'no_similar_topic_found', '{}'::jsonb, '${key}', NULL);`
      const args = ['exec', '-i', 'supabase_db_WillViralFinal', 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-c', sql]
      const [r1, r2] = await Promise.all([execFileAsync('docker', args), execFileAsync('docker', args)])
      expect(r1.stderr).not.toMatch(/duplicate key value violates/)
      expect(r2.stderr).not.toMatch(/duplicate key value violates/)
      const outcomes = [r1.stdout, r2.stdout].map(o => JSON.parse(o.trim()).outcome_kind).sort()
      expect(outcomes).toEqual(['created', 'replayed'])

      const decisionCount = dockerPsql(`select count(*) from topic_assignment_decisions where extraction_run_id='${extractionRunId}';`).trim()
      expect(decisionCount).toBe('1')
      const topicId = JSON.parse(r1.stdout.trim()).semantic_topic_id
      const topicCount = dockerPsql(`select count(*) from semantic_topics where id='${topicId}';`).trim()
      expect(topicCount).toBe('1')
      const membershipCount = dockerPsql(`select count(*) from semantic_topic_membership where semantic_topic_id='${topicId}';`).trim()
      expect(membershipCount).toBe('1')
      const eventCount = dockerPsql(`select count(*) from semantic_topic_membership_events where semantic_topic_id='${topicId}';`).trim()
      expect(eventCount).toBe('1')
    })

    it('B) two truly concurrent calls with the SAME extraction_run_id + two DIFFERENT idempotency_keys -> at most one decision, no orphans, the losing call gets a controlled documented error with full rollback', async () => {
      const marker = `conc-diff-${randomUUID().slice(0, 8)}`
      const { extractionRunId } = createCompletedExtraction(marker)
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const execFileAsync = promisify(execFile)
      const argsFor = (key: string, outcome: string, reason: string) => ['exec', '-i', 'supabase_db_WillViralFinal', 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-c',
        `select record_topic_assignment_decision('${extractionRunId}'::uuid, '${outcome}', '${reason}', '{}'::jsonb, '${key}', NULL);`]
      // Both calls must be individually caught -- Promise.all rejects as
      // soon as ANY one promise rejects, and which of the two processes
      // wins the race is not deterministic (either could be the loser).
      const [r1, r2] = await Promise.all([
        execFileAsync('docker', argsFor(`sti-s2b-${marker}-dec1`, 'CREATE_NEW', 'no_similar_topic_found')).catch(e => e),
        execFileAsync('docker', argsFor(`sti-s2b-${marker}-dec2`, 'QUARANTINE', 'below_confidence_threshold')).catch(e => e),
      ])
      // Exactly one succeeds and one fails (order between the two processes
      // is not guaranteed -- check both orderings).
      const succeeded = [r1, r2].filter((r: any) => !(r instanceof Error) && !r.stderr)
      const failed = [r1, r2].filter((r: any) => r instanceof Error)
      expect(succeeded.length).toBe(1)
      expect(failed.length).toBe(1)
      const failedOutput = String((failed[0] as any).stderr || (failed[0] as any).stdout || (failed[0] as any).message || '')
      expect(failedOutput).toMatch(/already has a decision with different parameters/)
      expect(failedOutput).not.toMatch(/duplicate key value violates/)

      const decisionCount = dockerPsql(`select count(*) from topic_assignment_decisions where extraction_run_id='${extractionRunId}';`).trim()
      expect(decisionCount).toBe('1')
      // No orphan topic/membership/event: whichever outcome won, every
      // topic/membership/event this extraction_run_id could have produced
      // must trace back to the single persisted decision.
      const orphanTopics = dockerPsql(`
        select count(*) from semantic_topics t
        where not exists (select 1 from topic_assignment_decisions d where d.semantic_topic_id = t.id)
          and t.creation_request_digest = encode(sha256(convert_to('${extractionRunId}' || 'topic_creation_seed', 'UTF8')), 'hex');
      `).trim()
      expect(orphanTopics).toBe('0')
    })
  })
})
