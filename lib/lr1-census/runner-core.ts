// LR-1 census runner -- pure core (no I/O of its own). Operator tooling only:
// never imported by any route, page, component or other lib module (a source
// policy test enforces that). Every side effect (clock, files, prompts, probe,
// psql) is injected, so the whole gate sequence is testable with fakes and this
// file never opens a database connection by itself.
//
// What it does, in this fixed order (see docs/operations/paid-operations-d1-d2-state-model.md,
// "Celazonosag-ellenorzes a futtatas elott"):
//   1. validate the approval record (phase, label, expiry, single use, shapes)
//   2. compare the SHA-256 of the census SQL with the approval (and refuse the
//      known obsolete hashes)
//   3. read the connection target interactively (hidden prompts), derive its
//      fingerprint in memory, compare it with the approval -- BEFORE any
//      connection exists; on a mismatch burn the record
//   4. persist "used" BEFORE the first connection (a crash cannot re-enable it)
//   5. second factor (DB-side fingerprint or recorded human confirmation)
//   6. run the census, discard the output on ANY error, whitelist-validate it,
//      redact everything else
// It prints (emits) only labels, hashes, times and whitelisted bucket output --
// never a host, project ref, database name or role.
import { createHash, timingSafeEqual } from 'node:crypto'

export const CENSUS_SQL_RELATIVE_PATH = 'docs/operations/paid-operations-lr1-census-phase0.sql'

/** v1 gave exact counts; v2 had comment-only guards and printed raw tool_type/status. Never approvable again. */
export const OBSOLETE_CENSUS_SQL_SHA256: ReadonlySet<string> = new Set([
  '365a14e16170e246d507309fd98ff859a675803a6c7050310d44fb8b33ac16b7',
  '63c822aa3bf7e7fb2ec857927982171e3406207cc6962c69a8afba367f7ce09f',
])

export type Phase = 'staging_dryrun' | 'production'
export type TargetLabel = 'staging' | 'production'
export const PHASE_LABEL: Readonly<Record<Phase, TargetLabel>> = {
  staging_dryrun: 'staging',
  production: 'production',
}

// The DB-side second factor reads this constant; the runner never sends any
// other SQL than this probe and the approved census file.
export const SYSTEM_IDENTIFIER_PROBE_SQL =
  "SELECT encode(sha256(convert_to(system_identifier::text, 'UTF8')), 'hex') AS f FROM pg_control_system()"

export type ApprovalStatus = 'unused' | 'used' | 'burned'
export type SecondFactor =
  | { kind: 'system_identifier_sha256'; value: string }
  | { kind: 'human_dashboard_confirmation'; confirmed_by: string; confirmed_at: string }

export interface ApprovalRecord {
  phase: Phase
  target_label: TargetLabel
  target_fingerprint: string
  /** SHA-256 of canonicalRoleString(executing role): the approval names WHO may run it. */
  role_fingerprint: string
  sql_sha256: string
  approver: string
  expires_at: string
  /** Informational only: the authoritative single-use state is the exclusive claim file, never this field. */
  status: ApprovalStatus
  second_factor: SecondFactor
}

export interface ConnectionTarget {
  projectRef: string
  host: string
  port: string
  database: string
}

export class TargetInputError extends Error {
  readonly code = 'target_input_invalid'
  constructor() {
    super('target_input_invalid')
  }
}

const HEX64 = /^[0-9a-f]{64}$/

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function equalHex(a: string, b: string): boolean {
  if (!HEX64.test(a) || !HEX64.test(b)) return false
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}

function cleanComponent(value: string, lower: boolean): string {
  const trimmed = value.trim()
  const v = lower ? trimmed.toLowerCase() : trimmed
  if (v.length === 0 || /[|\s\u0000-\u001f\u007f]/.test(v)) throw new TargetInputError()
  return v
}

/**
 * v1|<project ref>|<host>|<port>|<database> -- the TARGET fingerprint. The executing role is NOT part of it:
 * it has its own fingerprint (roleFingerprint) and its own field in the approval, so that a role mismatch
 * is a separate, named failure and the approved admin read cannot run under another role.
 */
export function canonicalTargetString(target: ConnectionTarget): string {
  const ref = cleanComponent(target.projectRef, true)
  const host = cleanComponent(target.host.replace(/\.$/, ''), true)
  const port = cleanComponent(target.port.trim() === '' ? '5432' : target.port, false)
  if (!/^\d{1,5}$/.test(port)) throw new TargetInputError()
  const database = cleanComponent(target.database, false)
  return `v1|${ref}|${host}|${port}|${database}`
}

export function targetFingerprint(target: ConnectionTarget): string {
  return sha256Hex(canonicalTargetString(target))
}

/** The role name is case-sensitive in PostgreSQL, so it is compared exactly (only surrounding whitespace is trimmed). */
export function canonicalRoleString(role: string): string {
  return `v1|role|${cleanComponent(role, false)}`
}

export function roleFingerprint(role: string): string {
  return sha256Hex(canonicalRoleString(role))
}

export type ApprovalRejectCode =
  | 'approval_invalid'
  | 'approval_phase_invalid'
  | 'approval_label_phase_mismatch'
  | 'approval_sql_hash_malformed'
  | 'approval_fingerprint_malformed'
  | 'approval_role_fingerprint_malformed'
  | 'approval_expired'
  | 'approval_already_used'
  | 'approval_burned'
  | 'approval_second_factor_invalid'

function isIso(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 20 && !Number.isNaN(Date.parse(value))
}

export function validateApprovalRecord(
  raw: unknown,
  now: Date,
): { ok: true; record: ApprovalRecord } | { ok: false; code: ApprovalRejectCode } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, code: 'approval_invalid' }
  const r = raw as Record<string, unknown>
  if (r.phase !== 'staging_dryrun' && r.phase !== 'production') return { ok: false, code: 'approval_phase_invalid' }
  const phase = r.phase as Phase
  if (r.target_label !== PHASE_LABEL[phase]) return { ok: false, code: 'approval_label_phase_mismatch' }
  if (typeof r.sql_sha256 !== 'string' || !HEX64.test(r.sql_sha256)) return { ok: false, code: 'approval_sql_hash_malformed' }
  if (typeof r.target_fingerprint !== 'string' || !HEX64.test(r.target_fingerprint)) {
    return { ok: false, code: 'approval_fingerprint_malformed' }
  }
  if (typeof r.role_fingerprint !== 'string' || !HEX64.test(r.role_fingerprint)) {
    return { ok: false, code: 'approval_role_fingerprint_malformed' }
  }
  if (typeof r.approver !== 'string' || r.approver.trim() === '') return { ok: false, code: 'approval_invalid' }
  if (!isIso(r.expires_at)) return { ok: false, code: 'approval_invalid' }
  if (r.status === 'burned') return { ok: false, code: 'approval_burned' }
  if (r.status === 'used') return { ok: false, code: 'approval_already_used' }
  if (r.status !== 'unused') return { ok: false, code: 'approval_invalid' }
  if (Date.parse(r.expires_at) <= now.getTime()) return { ok: false, code: 'approval_expired' }
  const sf = r.second_factor as Record<string, unknown> | null | undefined
  if (typeof sf !== 'object' || sf === null) return { ok: false, code: 'approval_second_factor_invalid' }
  if (sf.kind === 'system_identifier_sha256') {
    if (typeof sf.value !== 'string' || !HEX64.test(sf.value)) return { ok: false, code: 'approval_second_factor_invalid' }
  } else if (sf.kind === 'human_dashboard_confirmation') {
    if (typeof sf.confirmed_by !== 'string' || sf.confirmed_by.trim() === '' || !isIso(sf.confirmed_at)) {
      return { ok: false, code: 'approval_second_factor_invalid' }
    }
  } else {
    return { ok: false, code: 'approval_second_factor_invalid' }
  }
  return { ok: true, record: raw as ApprovalRecord }
}

/** The actual file hash must neither be a known obsolete version nor differ from the approved one. */
export function checkSqlHash(actualSha256: string, approvedSha256: string): 'ok' | 'obsolete' | 'mismatch' {
  if (OBSOLETE_CENSUS_SQL_SHA256.has(actualSha256)) return 'obsolete'
  return equalHex(actualSha256, approvedSha256) ? 'ok' : 'mismatch'
}

/** Record assembly sanity: a staging record and a production record must never share a target fingerprint. */
export function recordsAreDistinct(a: ApprovalRecord, b: ApprovalRecord): boolean {
  if (a.phase === b.phase) return false
  return !equalHex(a.target_fingerprint, b.target_fingerprint)
}

// ---------------------------------------------------------------------------
// Output whitelist validation + redaction
// ---------------------------------------------------------------------------
export const TOOL_VOCAB: readonly string[] = [
  'viral_score', 'similar_videos', 'opportunity_engine', 'video_audit', 'video_package', 'script_extract',
  'transcript_extract', 'content_gap', 'analyzer', 'keyword_research', 'competitor_tracker', 'outlier_detector',
  'title_studio', 'thumbnail_studio', 'seo_optimizer', 'opportunity_explain', 'channel_audit',
]
export const STATUS_VOCAB: readonly string[] = ['completed', 'failed', 'refreshed', 'archived']
export const BUCKET_LABELS: readonly string[] = [
  '0', '<5', '5-9', '10-49', '50-99', '100-499', '500-999', '1000-9999', '10000-99999', '100000+',
]

type Domain = (value: string) => boolean
const oneOf = (values: readonly string[]): Domain => (v) => values.includes(v)
const bucket: Domain = oneOf(BUCKET_LABELS)
const tool: Domain = oneOf([...TOOL_VOCAB, '(other)'])
const toolWithUnmapped: Domain = oneOf([...TOOL_VOCAB, '(other)', '(unmapped)'])
const status: Domain = oneOf([...STATUS_VOCAB, '(other)', '(null)'])
const period: Domain = (v) => v === '(suppressed)' || /^\d{4}-(01|04|07|10)-01$/.test(v)
const relname: Domain = oneOf(['paid_results', 'credit_ledger'])
const timestamp: Domain = (v) => /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}(:?\d{2})?|Z)?$/.test(v)

interface SegmentSpec {
  name: string
  header: readonly string[]
  domains: readonly Domain[]
  minRows: number
  maxRows: number
  allowEmptyRow?: boolean
  uniqueFirstColumn?: boolean
}

const SEGMENTS: readonly SegmentSpec[] = [
  { name: 'session_guard', header: ['session_guard_status', 'server_version_num'], domains: [oneOf(['ok']), (v) => /^\d{5,7}$/.test(v)], minRows: 1, maxRows: 1 },
  { name: 'schema_guard', header: ['schema_guard_status'], domains: [oneOf(['ok'])], minRows: 1, maxRows: 1 },
  { name: 'q1', header: ['tool_type', 'status', 'n_rows_bucket'], domains: [tool, status, bucket], minRows: 0, maxRows: 200 },
  { name: 'q2', header: ['tool_type', 'status', 'period', 'n_rows_bucket'], domains: [tool, status, period, bucket], minRows: 0, maxRows: 400 },
  {
    name: 'q3',
    header: ['relname', 'n_tup_ins_bucket', 'n_tup_upd_bucket', 'n_tup_del_bucket'],
    domains: [relname, bucket, bucket, bucket],
    minRows: 0,
    maxRows: 2,
    uniqueFirstColumn: true,
  },
  { name: 'q3b', header: ['stats_reset'], domains: [timestamp], minRows: 0, maxRows: 1, allowEmptyRow: true },
  {
    name: 'q4',
    header: ['tool_type', 'n_spends_not_refunded_bucket', 'n_completed_cost_pos_bucket', 'n_completed_cost_zero_bucket'],
    domains: [toolWithUnmapped, bucket, bucket, bucket],
    minRows: 0,
    maxRows: 40,
  },
  { name: 'q5', header: ['n_users_with_mapped_spends_and_no_paid_results_bucket'], domains: [bucket], minRows: 1, maxRows: 1 },
]

/** The declared output shape of the census file (a test compares it with the OUTPUT: lines of the SQL). */
export const CENSUS_SEGMENT_HEADERS: ReadonlyArray<{ name: string; header: readonly string[] }> = SEGMENTS.map((s) => ({
  name: s.name,
  header: s.header,
}))

export type OutputRejectCode =
  | 'secret_in_output'
  | 'unexpected_quote'
  | 'too_many_lines'
  | 'segment_order'
  | 'row_shape'
  | 'value_outside_domain'
  | 'duplicate_key'
  | 'row_count'

const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, // uuid
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, // e-mail
  /eyJ[A-Za-z0-9_-]{10,}/, // jwt-like
  /\bsk-[A-Za-z0-9_-]{8,}/, // api-key-like
  /\bsb_[a-z]+_[A-Za-z0-9_-]{8,}/, // supabase key-like
  /postgres(?:ql)?:\/\//i, // connection url
  /\b[0-9a-fA-F]{32,}\b/, // long hex
]

function containsSecret(text: string, secrets: readonly string[]): boolean {
  const lower = text.toLowerCase()
  for (const s of secrets) {
    if (s.length >= 3 && lower.includes(s.toLowerCase())) return true
  }
  return SENSITIVE_PATTERNS.some((re) => re.test(text))
}

export type CensusTables = Record<string, string[][]>

/** Whitelist validation of the psql --csv stdout. Anything unexpected -> rejected, nothing is kept. */
export function validateCensusOutput(
  stdout: string,
  secrets: readonly string[],
): { ok: true; tables: CensusTables } | { ok: false; code: OutputRejectCode } {
  if (containsSecret(stdout, secrets)) return { ok: false, code: 'secret_in_output' }
  if (stdout.includes('"')) return { ok: false, code: 'unexpected_quote' }
  const lines = stdout.replace(/\r\n/g, '\n').split('\n')
  if (lines.length > 2000) return { ok: false, code: 'too_many_lines' }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const tables: CensusTables = {}
  let index = -1
  for (const line of lines) {
    const nextSpec = SEGMENTS[index + 1]
    if (nextSpec && line === nextSpec.header.join(',')) {
      index += 1
      tables[nextSpec.name] = []
      continue
    }
    if (index < 0) return { ok: false, code: 'segment_order' }
    const spec = SEGMENTS[index]
    const rows = tables[spec.name]
    if (line === '' && spec.allowEmptyRow) {
      rows.push([''])
      continue
    }
    const cells = line.split(',')
    if (cells.length !== spec.header.length) return { ok: false, code: 'row_shape' }
    for (let i = 0; i < cells.length; i += 1) {
      if (!spec.domains[i](cells[i])) return { ok: false, code: 'value_outside_domain' }
    }
    if (spec.uniqueFirstColumn && rows.some((r) => r[0] === cells[0])) return { ok: false, code: 'duplicate_key' }
    rows.push(cells)
  }
  if (index !== SEGMENTS.length - 1) return { ok: false, code: 'segment_order' }
  for (const spec of SEGMENTS) {
    const n = tables[spec.name].length
    if (n < spec.minRows || n > spec.maxRows) return { ok: false, code: 'row_count' }
  }
  return { ok: true, tables }
}

/** Redacts the supplied secrets and the generic sensitive patterns, then truncates. */
export function redactText(text: string, secrets: readonly string[], maxLength = 300): string {
  let out = text
  for (const s of secrets) {
    if (s.length < 3) continue
    const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(escaped, 'gi'), '<redacted>')
  }
  for (const re of SENSITIVE_PATTERNS) out = out.replace(new RegExp(re.source, `${re.flags.replace('g', '')}g`), '<redacted>')
  out = out.replace(/\s+/g, ' ').trim()
  return out.length > maxLength ? `${out.slice(0, maxLength)}...` : out
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
export type PromptField = 'project_ref' | 'host' | 'port' | 'database' | 'role'

export interface PsqlResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export type ClaimState = 'used' | 'burned'
export type ClaimResult = { ok: true } | { ok: false; reason: 'exists' | 'io_error' }

export interface RunnerDeps {
  now(): Date
  /** Called exactly ONCE. The bytes that come back are the bytes that are hashed AND the bytes that run. */
  readSqlBytes(): Uint8Array
  /** Test seam only (the CLI never sets it): lets a test present an obsolete hash without having obsolete bytes. */
  hashBytes?: (bytes: Uint8Array) => string
  readApproval(): unknown
  /** The authoritative single-use state: null only when no claim exists. */
  readClaim(): { state: ClaimState } | null
  /** Atomic, exclusive create-once claim (see approval-claim.ts): exactly one concurrent caller gets ok. Crash / power-loss survival is NOT verified. */
  claim(state: ClaimState, info: Record<string, string>): ClaimResult
  promptHidden(field: PromptField): Promise<string>
  /** The operator types an explicit confirmation naming the label and the first characters of the SQL hash. */
  confirmExecute(label: TargetLabel, sqlShaPrefix: string): Promise<boolean>
  probeSecondFactor(target: ConnectionTarget, role: string): Promise<{ ok: true; value: string } | { ok: false }>
  /** Receives the verified bytes; it must feed exactly these to psql (stdin), never re-open a path. */
  runPsql(target: ConnectionTarget, role: string, sqlBytes: Uint8Array): Promise<PsqlResult>
  emit(line: string): void
}

export type AbortCode =
  | ApprovalRejectCode
  | 'phase_mismatch'
  | 'sql_hash_obsolete'
  | 'sql_hash_mismatch'
  | 'target_input_invalid'
  | 'target_mismatch'
  | 'role_mismatch'
  | 'burn_failed'
  | 'claim_state_unreadable'
  | 'approval_claim_lost'
  | 'approval_claim_failed'
  | 'operator_declined'
  | 'second_factor_unavailable'
  | 'second_factor_mismatch'

export interface Evidence {
  status: 'ok' | 'aborted' | 'gate_passed_no_run' | 'sql_failed' | 'output_blocked'
  code: string | null
  phase: Phase
  label: TargetLabel | null
  sql_sha256: string | null
  started_at: string
  finished_at: string
  exit_code: number | null
  error_class: 'guard_failed' | 'other' | null
  error_summary: string | null
  census: CensusTables | null
}

export interface RunInput {
  phase: Phase
  /** false = run only the gates (no connection, no psql, the approval is not consumed). */
  execute: boolean
}

export async function runCensus(deps: RunnerDeps, input: RunInput): Promise<Evidence> {
  const startedAt = deps.now().toISOString()
  const base = (over: Partial<Evidence>): Evidence => ({
    status: 'aborted',
    code: null,
    phase: input.phase,
    label: null,
    sql_sha256: null,
    started_at: startedAt,
    finished_at: deps.now().toISOString(),
    exit_code: null,
    error_class: null,
    error_summary: null,
    census: null,
    ...over,
  })
  const finish = (ev: Evidence): Evidence => {
    deps.emit(JSON.stringify(ev))
    return ev
  }
  const abort = (code: AbortCode, extra: Partial<Evidence> = {}): Evidence => {
    deps.emit(code === 'target_mismatch' ? 'TARGET MISMATCH' : code === 'role_mismatch' ? 'ROLE MISMATCH' : `RUN_ABORTED ${code}`)
    return finish(base({ status: 'aborted', code, ...extra }))
  }
  const tryClaim = (state: ClaimState, info: Record<string, string>): ClaimResult => {
    try {
      return deps.claim(state, info)
    } catch {
      return { ok: false, reason: 'io_error' }
    }
  }

  // 0. the authoritative single-use state (a claim file), before anything else
  let existing: ReturnType<RunnerDeps['readClaim']>
  try {
    existing = deps.readClaim()
  } catch {
    return abort('claim_state_unreadable')
  }
  if (existing) return abort(existing.state === 'burned' ? 'approval_burned' : 'approval_already_used')

  // 1. approval record
  let validated: ReturnType<typeof validateApprovalRecord>
  try {
    validated = validateApprovalRecord(deps.readApproval(), deps.now())
  } catch {
    return abort('approval_invalid')
  }
  if (!validated.ok) return abort(validated.code)
  const record = validated.record
  if (record.phase !== input.phase) return abort('phase_mismatch')
  const label = PHASE_LABEL[record.phase]

  // 2. the SQL bytes: read ONCE, copied, hashed, and the very same copy is what runs
  const sqlBytes = Uint8Array.from(deps.readSqlBytes())
  const sqlSha = (deps.hashBytes ?? sha256Hex)(sqlBytes)
  const hashCheck = checkSqlHash(sqlSha, record.sql_sha256)
  if (hashCheck !== 'ok') {
    return abort(hashCheck === 'obsolete' ? 'sql_hash_obsolete' : 'sql_hash_mismatch', { label, sql_sha256: sqlSha })
  }

  // 3. the target AND the executing role, BEFORE any connection exists and before the approval is consumed
  let target: ConnectionTarget
  let role: string
  let targetFp: string
  let roleFp: string
  try {
    target = {
      projectRef: await deps.promptHidden('project_ref'),
      host: await deps.promptHidden('host'),
      port: await deps.promptHidden('port'),
      database: await deps.promptHidden('database'),
    }
    role = await deps.promptHidden('role')
    targetFp = targetFingerprint(target) // validates the input shape
    roleFp = roleFingerprint(role)
  } catch (error) {
    if (error instanceof TargetInputError) return abort('target_input_invalid', { label, sql_sha256: sqlSha })
    throw error
  }
  const secrets = [target.projectRef, target.host, target.database, role]
  const targetOk = equalHex(targetFp, record.target_fingerprint)
  const roleOk = equalHex(roleFp, record.role_fingerprint)
  if (!targetOk || !roleOk) {
    const reason: AbortCode = targetOk ? 'role_mismatch' : 'target_mismatch'
    // a mismatch burns the approval (create-once claim); if the burn cannot be recorded it is a SEPARATE, loud failure
    const burned = tryClaim('burned', { reason, at: deps.now().toISOString(), phase: record.phase, label, sql_sha256: sqlSha })
    if (!burned.ok && burned.reason === 'io_error') {
      deps.emit('MISMATCH -- BURN FAILED: the approval may still be unused; do not retry; revoke the approval file manually')
      return finish(base({ status: 'aborted', code: 'burn_failed', label, sql_sha256: sqlSha }))
    }
    return abort(reason, { label, sql_sha256: sqlSha })
  }
  deps.emit(`TARGET OK ${label}`)
  deps.emit('ROLE OK')

  if (!input.execute) {
    deps.emit('GATE_ONLY_COMPLETE')
    return finish(base({ status: 'gate_passed_no_run', label, sql_sha256: sqlSha }))
  }

  // 3b. explicit, typed operator confirmation (nothing is consumed or connected yet)
  if (!(await deps.confirmExecute(label, sqlSha.slice(0, 12)))) {
    return abort('operator_declined', { label, sql_sha256: sqlSha })
  }

  // 4. single use: an atomic, exclusive create-once claim BEFORE the first connection; a lost race stops here
  const claimed = tryClaim('used', { at: deps.now().toISOString(), phase: record.phase, label, sql_sha256: sqlSha })
  if (!claimed.ok) {
    return abort(claimed.reason === 'exists' ? 'approval_claim_lost' : 'approval_claim_failed', { label, sql_sha256: sqlSha })
  }

  // 5. second factor
  if (record.second_factor.kind === 'system_identifier_sha256') {
    const probe = await deps.probeSecondFactor(target, role)
    if (!probe.ok) return abort('second_factor_unavailable', { label, sql_sha256: sqlSha })
    if (!equalHex(probe.value, record.second_factor.value)) return abort('second_factor_mismatch', { label, sql_sha256: sqlSha })
    deps.emit('SECOND_FACTOR system_identifier_ok')
  } else {
    deps.emit('SECOND_FACTOR human_confirmation_recorded (single technical factor)')
  }

  // 6. the census: exactly the verified bytes
  const result = await deps.runPsql(target, role, sqlBytes)
  if (result.timedOut || result.exitCode !== 0) {
    const guard = /lr1_census_guard_failed/.test(result.stderr)
    return finish(
      base({
        status: 'sql_failed',
        code: result.timedOut ? 'timeout' : 'psql_nonzero_exit',
        label,
        sql_sha256: sqlSha,
        exit_code: result.exitCode,
        error_class: guard ? 'guard_failed' : 'other',
        error_summary: redactText(result.stderr, secrets),
      }),
    )
  }
  const checked = validateCensusOutput(result.stdout, secrets)
  if (!checked.ok) {
    return finish(base({ status: 'output_blocked', code: checked.code, label, sql_sha256: sqlSha, exit_code: result.exitCode }))
  }
  return finish(base({ status: 'ok', label, sql_sha256: sqlSha, exit_code: result.exitCode, census: checked.tables }))
}
