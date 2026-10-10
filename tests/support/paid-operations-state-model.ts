// Executable STATE MODEL of the D1/D2 design (paid operations + generations + paid_results projection + old-writer fence).
//
// DB-FREE, PROVIDER-FREE, PURE, IN-MEMORY. This is a SPECIFICATION that the contract tests run against; it is NOT production code, nothing imports it
// from app/ or lib/, and it proves nothing about a real PostgreSQL (advisory locks, READ COMMITTED re-reads after a lock, triggers, CHECKs and
// function privileges are MODELLED here and must be re-proven on a real database before any claim about it).
//
// How it models the database:
//   * every RPC (commit / seal / businessCredit / ...) is ONE transaction: a structuredClone snapshot, restored on any throw (ModelCrash or
//     ModelConstraintViolation). Concurrency is modelled as the ORDER of whole RPC calls, because the advisory locks serialise them (the tests walk
//     every permutation); the lock acquisition order is recorded in `lockLog` so a guard test can pin it. The order is FIXED: tool lock, then operation
//     lock, then scope lock. The TOOL lock is what serialises a commit with enableCutover / rollbackCutover: every decision about the cut-over state is
//     taken AFTER that lock, never from a read made before it.
//   * the catalog snapshot is labelled with its PROVENANCE. Only a snapshot read from a real pg_catalog counts as database evidence; the snapshots in
//     this file are authored in a test or derived from the migrations, so a cut-over enabled with them is reported as evidence 'simulated'.
//   * NO FENCE HERE RESTS ON A CALLER IDENTITY. spend_credits (037) is itself SECURITY DEFINER with owner postgres, so `current_user` inside it is the
//     owner for EVERY caller, the commit function included -- it cannot tell a direct caller from the commit transaction. The two fences are instead:
//       - spend: a legacy-facing WRAPPER whose decision depends only on its arguments and the cut-over registry (never on who calls), and a CORE
//         that service_role has no EXECUTE privilege on (a PRIVILEGE property, checked on a catalog snapshot by checkSpendFenceCatalog());
//       - paid_results: a DATA INVARIANT (on a cut-over tool_type a row may only be the content of the max generation), checked for every writer alike,
//         the commit transaction included.
//     A cut-over is BLOCKED until the catalog snapshot satisfies the spend fence (enableCutover()).
//   * paid_results keeps its EXISTING columns only -- there is deliberately NO generation column. The projection generation is DERIVED from the
//     generation table (see projectionStatus()).
import { createHash } from 'node:crypto'

// ───────────────────────────── types ─────────────────────────────
export type ToolType = string
export type OperationState = 'committed' | 'sealed'
export type ChargeLink = 'linked' | 'unlinked_legacy'
export type OperationOrigin = 'atomic' | 'legacy_backfill'

export interface Binding { userId: string; deviceDigest: string; toolType: ToolType; inputHash: string }
export interface IntentToken extends Binding { nonce: string; expectedGeneration: number; issuedAt: number; deadline: number }

export interface LedgerRow {
  id: string
  userId: string
  feature: string
  externalRef: string
  reason: 'credit_spend' | 'credit_refund' | 'business_credit' | 'operator_credit_uncertain'
  delta: number
  relatedTransactionId: string | null
  note: string | null
}
// EVERY real paid_results column (019 + 021), classified EXACTLY ONCE (decision 1b). There is NO generation column, and none may be added (decision 1).
//   IDENTITY_FIELDS               fixed at creation: no write may change them.
//   GENERATION_CARRIED_FIELDS     what a generation row stores. On a cut-over tool_type they change ONLY through a new generation (the commit), never
//                                 through a legacy write -- not even one that leaves result_json identical.
//   DELIBERATELY_MUTABLE_FIELDS   written by something other than a generation, ON PURPOSE:
//                                   last_opened_at        openPaidResult() (lib/paid-results/paid-results-service.ts) on every cache hit
//                                   updated_at            bumped by every write
//                                   linked_video_idea_id  the FK ON DELETE SET NULL (021) is itself an UPDATE; the link is set by the video-package save
export const IDENTITY_FIELDS = ['id', 'user_id', 'tool_type', 'input_hash', 'created_at'] as const
export const GENERATION_CARRIED_FIELDS = [
  'normalized_input', 'original_input', 'main_category', 'specific_focus', 'region', 'language', 'platform',
  'result_json', 'summary_json', 'credit_cost', 'status', 'last_refreshed_at', 'fresh_until', 'source_run_id',
  'provider', 'model', 'prompt_template_id', 'prompt_version', 'estimated_cost',
] as const
export const DELIBERATELY_MUTABLE_FIELDS = ['updated_at', 'last_opened_at', 'linked_video_idea_id'] as const
export const GENERATION_BOUND_FIELDS = [...IDENTITY_FIELDS, ...GENERATION_CARRIED_FIELDS] as const
export const ALL_PAID_RESULT_COLUMNS = [...GENERATION_BOUND_FIELDS, ...DELIBERATELY_MUTABLE_FIELDS] as const
export type CarriedField = (typeof GENERATION_CARRIED_FIELDS)[number]
export type PaidResultColumn = (typeof ALL_PAID_RESULT_COLUMNS)[number]
export type PaidResultStatus = 'completed' | 'failed' | 'refreshed' | 'archived'
export type PaidResultRow = Record<PaidResultColumn, unknown> & { id: string; user_id: string; tool_type: ToolType; input_hash: string; status: PaidResultStatus }
export type CarriedFields = Record<CarriedField, unknown> & { status: PaidResultStatus }
/**
 * G-REOPEN: a reopen that FAILS CLOSED for a row that is not the max generation. NOT IMPLEMENTED -- nothing in the repository does it today, a source
 * test pins that, and the model's reopenPaidResult() models TODAY's path, which does not. Whether it is a requirement is a decision (D-g).
 */
export const FAIL_CLOSED_REOPEN_GATE = {
  id: 'G-REOPEN',
  implemented: false,
  covers: ['GET ?paidResultId=', 'PATCH / POST paid_result_id', 'the opportunity-* fallback by id'],
  options: [
    'route gate: after getPaidResultById, verify the row against the max generation (carried-field digest) before serving or patching it',
    'db gate: a STABLE open function that returns the row only when it equals the max generation; the routes call it instead of selecting the table',
  ],
} as const
/** What a caller may pass besides result_json when it writes a generation's content (a commit, or a legacy upsert). */
export type CarriedExtras = Partial<Omit<CarriedFields, 'result_json'>>
/** An older point in time than any model clock, so a legacy upsert's `last_refreshed_at: now` is a REAL change to a seeded row. */
export const LEGACY_SEED_TIME = '1999-12-31T00:00:00.000Z'
export interface GenerationRow {
  id: string
  userId: string
  toolType: ToolType
  inputHash: string
  generation: number
  operationId: string
  resultJson: unknown
  resultDigest: string
  carried: CarriedFields
  carriedDigest: string
  chargeLink: ChargeLink
  creditTransactionId: string | null
  origin: OperationOrigin
}
export interface OperationRow {
  operationId: string
  userId: string
  toolType: ToolType
  inputHash: string
  generation: number | null
  bindingDigest: string
  keyDigest: string
  state: OperationState
  creditTransactionId: string | null
  generationId: string | null
  origin: OperationOrigin
  sealedBy: 'user' | 'operator' | null
}
export interface ModelState {
  balances: Record<string, number>
  ledger: LedgerRow[]
  paidResults: PaidResultRow[]
  generations: GenerationRow[]
  operations: OperationRow[]
  cutover: Record<ToolType, true> // the cut-over registry: presence = the tool_type is atomic-only
  cutoverEvidence: Record<ToolType, CutoverEvidence> // what the cut-over was enabled on: 'simulated' unless the catalog came from a real pg_catalog query
}
export type CutoverEvidence = 'simulated' | 'database'

export class ModelCrash extends Error { constructor(readonly step: string) { super(`crash at ${step}`) } }
export class ModelConstraintViolation extends Error {}

// ───────────────────────────── identifiers, digests ─────────────────────────────
const NS_OPERATION = '6f1c5f0e-2b7a-4d3e-9c41-0a5d8e7b1f10'
const NS_LEGACY = '9d2e7a41-5c3b-4f68-8a07-3b6c1d9e4f21'

export function uuidV5(namespace: string, name: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex')
  const h = createHash('sha1').update(ns).update(name, 'utf8').digest()
  h[6] = (h[6] & 0x0f) | 0x50
  h[8] = (h[8] & 0x3f) | 0x80
  const hex = h.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}
// length-prefixed, so no field boundary can be forged by moving characters between fields
const encode = (...parts: string[]) => parts.map(p => `${Buffer.byteLength(p)}:${p}`).join('|')

/** The operation id is DERIVED from user, device, tool, input hash and the client key -- a caller never supplies it. */
export const deriveOperationId = (t: Pick<IntentToken, 'userId' | 'deviceDigest' | 'toolType' | 'inputHash' | 'nonce'>) =>
  uuidV5(NS_OPERATION, encode(t.userId, t.deviceDigest, t.toolType, t.inputHash, t.nonce))
/** The deterministic id of the materialised legacy generation 1: derived from the existing paid_results row id, in its OWN namespace. */
export const legacyOperationId = (paidResultId: string) => uuidV5(NS_LEGACY, paidResultId)
export const scopeKey = (b: Pick<Binding, 'userId' | 'toolType' | 'inputHash'>) => encode(b.userId, b.toolType, b.inputHash)

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`
}
export const digestOf = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex')
export const isoAt = (ms: number) => new Date(ms).toISOString()
export const carriedOf = (row: PaidResultRow): CarriedFields => Object.fromEntries(GENERATION_CARRIED_FIELDS.map(f => [f, structuredClone(row[f])])) as CarriedFields
/** Digest over the carried fields in a fixed order (an absent field counts as null). */
export const carriedDigestOf = (c: Partial<CarriedFields>) => digestOf(GENERATION_CARRIED_FIELDS.map(f => c[f] ?? null))

export const TOKEN_TTL_MS = 10 * 60 * 1000
export const MIN_NONCE_LENGTH = 16
export function makeToken(b: Binding, o: { nonce: string; expectedGeneration: number; issuedAt?: number; ttlMs?: number }): IntentToken {
  const issuedAt = o.issuedAt ?? 0
  return { ...b, nonce: o.nonce, expectedGeneration: o.expectedGeneration, issuedAt, deadline: issuedAt + (o.ttlMs ?? TOKEN_TTL_MS) }
}

// ───────────────────────────── results ─────────────────────────────
export type RejectCode =
  | 'binding_mismatch' | 'idempotency_key_required' | 'tool_not_cutover' | 'operation_sealed' | 'intent_expired'
  | 'generation_conflict' | 'insufficient_credits' | 'projection_diverged' | 'unknown_user'
export type SpendRejection = 'cutover_spend_forbidden' | 'reserved_external_ref' | 'duplicate_external_ref' | 'insufficient_credits' | 'unknown_user'
/**
 * The RESPONSE IDENTIFIER CONTRACT. A committed operation is answered with TWO identifiers that are never the same thing:
 *   generationId          the id of the GENERATION row (this operation's own result, immutable). It names history; the existing reopen path does NOT accept it.
 *   paidResultId          the id of the paid_results ROW of this (user, tool_type, input_hash) scope: the key the existing reopen path takes
 *                         (GET ?paidResultId= -> getPaidResultById(userId, id), PATCH paid_result_id, the response field paid_result_id). The row id is
 *                         the same for every generation of the scope and keeps its value across refreshes (a client holding it stays valid).
 *   paidResultGeneration  the generation that opening paidResultId yields NOW (the row always shows the max generation). It equals `generation` only
 *                         while this operation's generation is the current one; for an older operation it is the newer one.
 * paidResultId is null (and paidResultGeneration null) when the row is missing or does not equal the max generation (diverged, or no longer
 * completed): the RESPONSE does not hand out a reopen key for it. THAT IS ALL IT DOES. It does NOT make reopening fail closed: the existing reopen
 * path (getPaidResultById: id + owner + status 'completed', nothing else -- 21 call sites in the route files) still accepts a PREVIOUSLY KNOWN id and
 * serves whatever the row holds. A client knows an id from an earlier answer (kept in sessionStorage), from a link (?paidResultId=) or from the
 * dashboard summary list (it selects `id`). A fail-closed reopen is a separate route/DB gate, FAIL_CLOSED_REOPEN_GATE (G-REOPEN): NOT implemented.
 * generationId is always present for a committed operation.
 */
export interface ResultIdentifiers { generationId: string; paidResultId: string | null; paidResultGeneration: number | null }
export type CommitResult =
  | ({ ok: true; duplicate: boolean; operationId: string; generation: number } & ResultIdentifiers)
  | { ok: false; code: RejectCode; currentGeneration?: number }
export type SealResult =
  | { ok: true; state: 'sealed' | 'committed'; alreadySealed?: boolean }
  | { ok: false; code: 'binding_mismatch' | 'idempotency_key_required' | 'seal_too_early'; sealNotBefore?: number }
export type StatusResult =
  | ({ state: 'committed'; generation: number } & ResultIdentifiers)
  | { state: 'sealed' }
  | { state: 'not_visible'; sealNotBefore: number }
  | { state: 'rejected'; code: 'binding_mismatch' | 'idempotency_key_required' }

export const COMMIT_STEPS = ['after_locks', 'after_debit', 'after_materialize', 'after_generation', 'after_projection', 'after_operation_row'] as const
export type CommitStep = (typeof COMMIT_STEPS)[number]
export const SEAL_STEPS = ['after_locks', 'after_tombstone'] as const
export type SealStep = (typeof SEAL_STEPS)[number]

export interface ModelOptions {
  balances: Record<string, number>
  price?: (tool: ToolType) => number
  /** feature name -> tool_type, for the spend guard (a shared feature, e.g. one charged by two routes, maps to the SAME cut-over unit) */
  featureTool?: Record<string, ToolType>
  sealMarginMs?: number
  /** the optional guard of refund_credit_spend against `op:` spends (a decision, default ON) */
  guardRefundOfOpSpends?: boolean
  /** the function-privilege catalog the cut-over is checked against; none = the spend fence is unverified and no cut-over is allowed */
  spendFence?: CatalogSnapshot | null
}

export class PaidOperationsModel {
  state: ModelState
  readonly initialBalances: Record<string, number>
  readonly lockLog: string[][] = []
  nowMs = 0
  private seq = 0
  private readonly priceOf: (tool: ToolType) => number
  private readonly featureTool: Record<string, ToolType>
  private readonly sealMarginMs: number
  private readonly guardRefundOfOpSpends: boolean
  private readonly spendFence: CatalogSnapshot | null

  constructor(o: ModelOptions) {
    this.initialBalances = { ...o.balances }
    this.state = { balances: { ...o.balances }, ledger: [], paidResults: [], generations: [], operations: [], cutover: {}, cutoverEvidence: {} }
    this.priceOf = o.price ?? (() => 2)
    this.featureTool = o.featureTool ?? {}
    this.sealMarginMs = o.sealMarginMs ?? 60_000
    this.guardRefundOfOpSpends = o.guardRefundOfOpSpends ?? true
    this.spendFence = o.spendFence ?? null
  }

  advance(ms: number) { this.nowMs += ms }
  snapshot(): ModelState { return structuredClone(this.state) }
  private nextId(prefix: string) { return `${prefix}-${++this.seq}` }
  private tx<T>(fn: () => T): T {
    const snap = structuredClone(this.state)
    const seq = this.seq
    try { return fn() } catch (e) { this.state = snap; this.seq = seq; throw e }
  }

  // ─────────── reads used by tests ───────────
  operation(operationId: string) { return this.state.operations.find(o => o.operationId === operationId) }
  generationsOf(b: Pick<Binding, 'userId' | 'toolType' | 'inputHash'>) {
    return this.state.generations.filter(g => g.userId === b.userId && g.toolType === b.toolType && g.inputHash === b.inputHash).sort((a, c) => a.generation - c.generation)
  }
  paidResultOf(b: Pick<Binding, 'userId' | 'toolType' | 'inputHash'>) {
    return this.state.paidResults.find(r => r.user_id === b.userId && r.tool_type === b.toolType && r.input_hash === b.inputHash)
  }
  ledgerByRef(ref: string) { return this.state.ledger.filter(l => l.externalRef === ref) }

  /** Test seeding of PRE-EXISTING data (what is in paid_results today); bypasses every guard on purpose. */
  seedLegacyRow(o: { userId: string; toolType: ToolType; inputHash: string; status?: PaidResultStatus; resultJson: unknown; fields?: Partial<PaidResultRow> }): PaidResultRow {
    const row = this.newRow(o, { created_at: LEGACY_SEED_TIME, updated_at: LEGACY_SEED_TIME, last_opened_at: LEGACY_SEED_TIME, last_refreshed_at: LEGACY_SEED_TIME, status: o.status ?? 'completed', result_json: structuredClone(o.resultJson), ...(o.fields ?? {}) })
    this.state.paidResults.push(row)
    return row
  }
  /** A paid_results row with EVERY real column (the DB defaults), then the overlay. */
  private newRow(scope: Pick<Binding, 'userId' | 'toolType' | 'inputHash'>, overlay: Partial<PaidResultRow> = {}): PaidResultRow {
    const now = isoAt(this.nowMs)
    return {
      id: this.nextId('paid_results'), user_id: scope.userId, tool_type: scope.toolType, input_hash: scope.inputHash, created_at: now,
      normalized_input: scope.inputHash, original_input: scope.inputHash, main_category: null, specific_focus: null, region: null, language: null, platform: null,
      result_json: null, summary_json: {}, credit_cost: 0, status: 'completed', last_refreshed_at: now, fresh_until: null, source_run_id: null,
      provider: null, model: null, prompt_template_id: null, prompt_version: null, estimated_cost: null,
      updated_at: now, last_opened_at: now, linked_video_idea_id: null,
      ...overlay,
    }
  }
  /** Test seeding of a legacy ledger spend (random ref, no link to any result): what chargeFeature / chargeProtectedFeature wrote before the cutover. */
  seedLegacySpend(o: { userId: string; feature: string; cost: number; externalRef?: string }): LedgerRow {
    const row: LedgerRow = { id: this.nextId('ledger'), userId: o.userId, feature: o.feature, externalRef: o.externalRef ?? `spend:${this.nextId('rnd')}`, reason: 'credit_spend', delta: -o.cost, relatedTransactionId: null, note: null }
    this.state.ledger.push(row)
    this.state.balances[o.userId] = (this.state.balances[o.userId] ?? 0) - o.cost
    return row
  }

  // ─────────── cut-over registry ───────────
  /**
   * BLOCKED until the catalog snapshot satisfies the spend fence: without it a direct spend_credits caller could still charge a cut-over feature.
   * Takes the TOOL lock. The evidence is 'database' ONLY for a snapshot whose provenance is a real pg_catalog query; every snapshot built in this
   * file is 'simulated', and so is the cut-over enabled on it -- it is never reported as database evidence.
   */
  enableCutover(tool: ToolType, opts: { afterStartBeforeLock?: () => void } = {}): { ok: true; evidence: CutoverEvidence } | { ok: false; code: 'cutover_blocked_spend_fence_unverified'; violations: string[] } {
    opts.afterStartBeforeLock?.()
    return this.tx<{ ok: true; evidence: CutoverEvidence } | { ok: false; code: 'cutover_blocked_spend_fence_unverified'; violations: string[] }>(() => {
      this.lockLog.push([`tool:${tool}`])
      const violations = this.spendFence ? checkSpendFenceCatalog(this.spendFence) : ['no catalog snapshot: the spend fence is unverified']
      if (violations.length) return { ok: false, code: 'cutover_blocked_spend_fence_unverified', violations }
      const evidence: CutoverEvidence = this.spendFence?.provenance === 'pg_catalog_query' ? 'database' : 'simulated'
      this.state.cutover[tool] = true
      this.state.cutoverEvidence[tool] = evidence
      return { ok: true, evidence }
    })
  }
  /**
   * Back-step only while NO committed, charge-linked atomic generation exists for the tool_type -- the first one included. From that moment a real debit
   * is tied to a result, and a legacy upsert after the back-step could overwrite the content that debit paid for (and diverge from the generation table).
   * After that the only way back is forward: stop the tool, never re-enable the legacy writer.
   */
  rollbackCutover(tool: ToolType, opts: { afterStartBeforeLock?: () => void } = {}): { ok: true } | { ok: false; code: 'atomic_generation_exists' } {
    opts.afterStartBeforeLock?.() // the call has STARTED; a commit that runs in this window must not be missed, so the decision below is taken AFTER the tool lock
    return this.tx<{ ok: true } | { ok: false; code: 'atomic_generation_exists' }>(() => {
      this.lockLog.push([`tool:${tool}`]) // the SAME lock every commit of this tool_type takes first
      if (this.state.generations.some(g => g.toolType === tool && g.chargeLink === 'linked')) return { ok: false, code: 'atomic_generation_exists' }
      delete this.state.cutover[tool]
      delete this.state.cutoverEvidence[tool]
      return { ok: true }
    })
  }

  // ─────────── the old-writer fence ───────────
  private toolOfFeature(feature: string): ToolType { return this.featureTool[feature] ?? feature }
  /**
   * Modelled BEFORE INSERT/UPDATE/DELETE trigger on paid_results, IDENTITY-FREE, decided on the OLD and the NEW row. On a cut-over tool_type:
   *   - a DELETE is never allowed;
   *   - an UPDATE may never change an IDENTITY field;
   *   - an UPDATE that changes NO generation-carried field (only deliberately mutable ones: last_opened_at, updated_at, linked_video_idea_id) is allowed;
   *   - any other write -- an INSERT or an UPDATE that changes a carried field -- is allowed ONLY if EVERY carried field of the new row equals the max
   *     generation's snapshot. result_json alone is not enough: summary_json, credit_cost, status, source_run_id, freshness and the provenance
   *     columns are protected as well.
   * Every writer faces the same check. The commit passes it because it inserts the generation row first (its snapshot IS the new row).
   */
  private paidResultWriteAllowed(old: PaidResultRow | undefined, next: PaidResultRow): boolean {
    // the fence applies when the row is, or WAS, on a cut-over tool_type: an UPDATE must not be able to move a row OUT of it by rewriting tool_type
    if (!this.state.cutover[next.tool_type] && !(old && this.state.cutover[old.tool_type])) return true
    if (old && IDENTITY_FIELDS.some(f => canonicalJson(old[f]) !== canonicalJson(next[f]))) return false
    const nextDigest = carriedDigestOf(carriedOf(next))
    if (old && carriedDigestOf(carriedOf(old)) === nextDigest) return true // only deliberately mutable fields changed
    const gens = this.generationsOf({ userId: next.user_id, toolType: next.tool_type, inputHash: next.input_hash })
    return gens.length > 0 && gens[gens.length - 1].carriedDigest === nextDigest
  }
  private paidResultDeleteAllowed(tool: ToolType) { return !this.state.cutover[tool] }

  /** One write to paid_results: NEW = OLD overlaid by the payload (an upsert / update only sets the columns it names), then the trigger decides. */
  private writePaidResult(scope: Pick<Binding, 'userId' | 'toolType' | 'inputHash'>, payload: Partial<PaidResultRow>, kind: 'upsert' | 'update'): boolean {
    const old = this.paidResultOf(scope)
    if (kind === 'update' && !old) return true // an UPDATE that matches no row changes nothing
    const next: PaidResultRow = old ? { ...structuredClone(old), ...structuredClone(payload) } : this.newRow(scope, structuredClone(payload))
    if (!this.paidResultWriteAllowed(old, next)) return false
    if (old) Object.assign(old, next)
    else this.state.paidResults.push(next)
    return true
  }

  /**
   * Model of the real savePaidResult upsert: it always names result_json, summary_json, credit_cost, status, updated_at, last_opened_at,
   * last_refreshed_at, fresh_until and source_run_id (with its defaults), so a "same result, fresh timestamps" call changes protected fields.
   * `fields` lets a test name any carried field explicitly.
   */
  legacySavePaidResult(input: { userId: string; toolType: ToolType; inputHash: string; resultJson: unknown; fields?: CarriedExtras }): { ok: true; fenced: false } | { ok: false; code: 'cutover_write_forbidden' } {
    const now = isoAt(this.nowMs)
    const payload: Partial<PaidResultRow> = {
      normalized_input: input.inputHash, original_input: input.inputHash, main_category: null, specific_focus: null, region: null, language: null, platform: null,
      result_json: input.resultJson, summary_json: {}, credit_cost: 0, status: 'completed', updated_at: now, last_opened_at: now, last_refreshed_at: now, fresh_until: null, source_run_id: null,
      ...(input.fields ?? {}),
    }
    if (!this.writePaidResult(input, payload, 'upsert')) return { ok: false, code: 'cutover_write_forbidden' }
    return { ok: true, fenced: false } // a tool_type that is not cut over has NO fence against a late legacy writer (the documented, unprovable residual)
  }
  /** Any other UPDATE of paid_results (openPaidResult sets last_opened_at; an FK SET NULL sets linked_video_idea_id; a hypothetical writer could set anything). */
  legacyUpdatePaidResult(input: { userId: string; toolType: ToolType; inputHash: string; patch: Partial<PaidResultRow> }): { ok: true; fenced: false } | { ok: false; code: 'cutover_write_forbidden' } {
    if (!this.writePaidResult(input, input.patch, 'update')) return { ok: false, code: 'cutover_write_forbidden' }
    return { ok: true, fenced: false }
  }
  legacyDeletePaidResult(input: { userId: string; toolType: ToolType; inputHash: string }): { ok: true; fenced: false } | { ok: false; code: 'cutover_write_forbidden' } {
    if (!this.paidResultDeleteAllowed(input.toolType)) return { ok: false, code: 'cutover_write_forbidden' }
    this.state.paidResults = this.state.paidResults.filter(r => !(r.user_id === input.userId && r.tool_type === input.toolType && r.input_hash === input.inputHash))
    return { ok: true, fenced: false }
  }

  /**
   * Model of the legacy-facing spend_credits WRAPPER (a proposed split of the current spend_credits, same signature, identical behaviour for every
   * feature that is not cut over). Its decision depends ONLY on its arguments and the cut-over registry, NEVER on who calls it: a cut-over feature and
   * the reserved `op:` namespace are refused for every caller. It does not and cannot know whether the caller is the commit function.
   */
  legacySpend(input: { userId: string; feature: string; cost: number; externalRef: string }): { ok: true; ledgerId: string; fenced: false } | { ok: false; code: SpendRejection } {
    if (input.externalRef.startsWith('op:')) return { ok: false, code: 'reserved_external_ref' } // the `op:` namespace belongs to the commit transaction
    if (this.state.cutover[this.toolOfFeature(input.feature)]) return { ok: false, code: 'cutover_spend_forbidden' }
    const r = this.spendCore(input)
    return r.ok ? { ok: true, ledgerId: r.ledgerId, fenced: false } : r
  }
  /**
   * Model of spend_credits_core (the current spend_credits body). Only the commit function reaches it: service_role has no EXECUTE privilege on it.
   * That is a PRIVILEGE property the model cannot prove; checkSpendFenceCatalog() states it as a rule over a catalog snapshot. There is no identity
   * parameter, because inside SECURITY DEFINER functions the caller is not visible.
   */
  private spendCore(i: { userId: string; feature: string; cost: number; externalRef: string }): { ok: true; ledgerId: string } | { ok: false; code: SpendRejection } {
    if (this.state.ledger.some(l => l.externalRef === i.externalRef)) return { ok: false, code: 'duplicate_external_ref' }
    const bal = this.state.balances[i.userId]
    if (bal === undefined) return { ok: false, code: 'unknown_user' }
    if (bal < i.cost) return { ok: false, code: 'insufficient_credits' }
    const row: LedgerRow = { id: this.nextId('ledger'), userId: i.userId, feature: i.feature, externalRef: i.externalRef, reason: 'credit_spend', delta: -i.cost, relatedTransactionId: null, note: null }
    this.state.ledger.push(row)
    this.state.balances[i.userId] = bal - i.cost
    return { ok: true, ledgerId: row.id }
  }

  // ─────────── the projection: DERIVED from the generation table, no column ───────────
  /**
   * generation: the max generation row; with no generation rows, a COMPLETED legacy row counts as an implicit generation 1 (anything else is 0).
   * consistent: the paid_results row is the content of the max generation (digest equality) and is completed. A legacy writer or a manual edit
   * breaks this, and the commit then FAILS CLOSED instead of charging on top of an unknown projection.
   */
  projectionStatus(b: Pick<Binding, 'userId' | 'toolType' | 'inputHash'>): { generation: number; consistent: boolean } {
    const gens = this.generationsOf(b)
    const row = this.paidResultOf(b)
    if (gens.length === 0) return { generation: row?.status === 'completed' ? 1 : 0, consistent: true }
    const top = gens[gens.length - 1]
    return { generation: top.generation, consistent: !!row && row.status === 'completed' && carriedDigestOf(carriedOf(row)) === top.carriedDigest }
  }

  // ─────────── D1/D2 RPCs ───────────
  private verifyToken(token: IntentToken, request: Binding): 'binding_mismatch' | 'idempotency_key_required' | null {
    if (token.userId !== request.userId || token.deviceDigest !== request.deviceDigest || token.toolType !== request.toolType || token.inputHash !== request.inputHash) return 'binding_mismatch'
    if (typeof token.nonce !== 'string' || token.nonce.length < MIN_NONCE_LENGTH) return 'idempotency_key_required'
    return null
  }
  private crashIf(at: string | undefined, step: string) { if (at === step) throw new ModelCrash(step) }

  /** C class: the only call that can start a charge. ONE transaction: lock, tombstone/duplicate check, deadline, CAS, debit, generation, projection, operation row. */
  commit(req: { token: IntentToken; request: Binding; resultJson: unknown; fields?: CarriedExtras }, opts: { crashAt?: CommitStep; afterStartBeforeLock?: () => void } = {}): CommitResult {
    const { token, request, resultJson } = req
    const bad = this.verifyToken(token, request) // stateless: reads nothing from the database
    if (bad) return { ok: false, code: bad }
    opts.afterStartBeforeLock?.() // the call has STARTED; whatever runs in this window must not change a decision below, because every decision is taken after the locks
    const operationId = deriveOperationId(token)
    const scope = scopeKey(request)
    return this.tx<CommitResult>(() => {
      this.lockLog.push([`tool:${token.toolType}`, `op:${operationId}`, `scope:${scope}`]) // FIXED ORDER: tool lock, operation lock, scope lock
      this.crashIf(opts.crashAt, 'after_locks')
      // the cut-over state is read AFTER the tool lock that enableCutover / rollbackCutover take too, never from a read made before it
      if (!this.state.cutover[token.toolType]) return { ok: false, code: 'tool_not_cutover' }
      const existing = this.operation(operationId) // read AFTER the locks (READ COMMITTED re-read), never before
      if (existing?.state === 'sealed') return { ok: false, code: 'operation_sealed' }
      if (existing) return { ok: true, duplicate: true, operationId, generation: existing.generation!, ...this.identifiersFor(existing, existing.generationId!) }
      if (this.nowMs > token.deadline) return { ok: false, code: 'intent_expired' }
      const proj = this.projectionStatus(request)
      if (!proj.consistent) return { ok: false, code: 'projection_diverged' }
      if (proj.generation !== token.expectedGeneration) return { ok: false, code: 'generation_conflict', currentGeneration: proj.generation }
      const price = this.priceOf(token.toolType)
      const bal = this.state.balances[request.userId]
      if (bal === undefined) return { ok: false, code: 'unknown_user' }
      if (bal < price) return { ok: false, code: 'insufficient_credits' }
      // ── writes (every one rolls back with the transaction) ──
      const carried = this.carriedForCommit(request, resultJson, price, req.fields)
      const spent = this.spendCore({ userId: request.userId, feature: token.toolType, cost: price, externalRef: `op:${operationId}` })
      if (!spent.ok) throw new ModelConstraintViolation(`debit refused: ${spent.code}`)
      this.crashIf(opts.crashAt, 'after_debit')
      const legacy = this.generationsOf(request).length === 0 ? this.paidResultOf(request) : undefined
      if (legacy && legacy.status === 'completed') this.materializeLegacyGeneration(legacy)
      this.crashIf(opts.crashAt, 'after_materialize')
      const generation = proj.generation + 1
      if (this.generationsOf(request).some(g => g.generation === generation)) throw new ModelConstraintViolation('unique (user, tool, input_hash, generation)')
      const gen: GenerationRow = { id: this.nextId('gen'), userId: request.userId, toolType: request.toolType, inputHash: request.inputHash, generation, operationId, resultJson: structuredClone(resultJson), resultDigest: digestOf(resultJson), carried, carriedDigest: carriedDigestOf(carried), chargeLink: 'linked', creditTransactionId: spent.ledgerId, origin: 'atomic' }
      this.state.generations.push(gen)
      this.crashIf(opts.crashAt, 'after_generation')
      // the projection advances by EXACTLY one, through the SAME identity-free check every writer faces: the generation row above justifies the write
      const now = isoAt(this.nowMs)
      if (!this.writePaidResult(request, { ...structuredClone(carried), updated_at: now, last_opened_at: now }, 'upsert')) throw new ModelConstraintViolation('projection write refused: not the snapshot of the max generation')
      this.crashIf(opts.crashAt, 'after_projection')
      if (this.operation(operationId)) throw new ModelConstraintViolation('operation_id primary key')
      this.state.operations.push({ operationId, userId: request.userId, toolType: request.toolType, inputHash: request.inputHash, generation, bindingDigest: digestOf([request.userId, request.deviceDigest, request.toolType, request.inputHash]), keyDigest: digestOf(token.nonce), state: 'committed', creditTransactionId: spent.ledgerId, generationId: gen.id, origin: 'atomic', sealedBy: null })
      this.crashIf(opts.crashAt, 'after_operation_row')
      return { ok: true, duplicate: false, operationId, generation, ...this.identifiersFor(request, gen.id) }
    })
  }

  /** The two identifiers of a committed operation's answer (see ResultIdentifiers). paidResultId is returned only for a row that IS the max generation. */
  private identifiersFor(scope: Pick<Binding, 'userId' | 'toolType' | 'inputHash'>, generationId: string): ResultIdentifiers {
    const row = this.paidResultOf(scope)
    const projection = this.projectionStatus(scope)
    if (!row || !projection.consistent) return { generationId, paidResultId: null, paidResultGeneration: null }
    return { generationId, paidResultId: row.id, paidResultGeneration: projection.generation }
  }

  /** The carried fields a commit writes: the real savePaidResult defaults, the price as credit_cost, then the caller's extras; result_json is never an extra. */
  private carriedForCommit(request: Binding, resultJson: unknown, price: number, extras: CarriedExtras = {}): CarriedFields {
    return {
      normalized_input: request.inputHash, original_input: request.inputHash, main_category: null, specific_focus: null, region: null, language: null, platform: null,
      summary_json: {}, credit_cost: price, status: 'completed', last_refreshed_at: isoAt(this.nowMs), fresh_until: null, source_run_id: null,
      provider: null, model: null, prompt_template_id: null, prompt_version: null, estimated_cost: null,
      ...structuredClone(extras),
      result_json: structuredClone(resultJson),
    }
  }

  /**
   * Model of the EXISTING reopen path (getPaidResultById): by paid_results.id, for the owner, only a COMPLETED row; it yields the CURRENT content.
   * It does not know generation ids: a generationId is not found here. IT IS NOT FAIL-CLOSED: it never compares the row with the max generation, so a
   * previously known id of a DIVERGED row (content edited out of band) is still opened and its content served -- the answer of a commit would have
   * withheld that id, this path does not care. That gap is G-REOPEN (FAIL_CLOSED_REOPEN_GATE), not implemented.
   */
  reopenPaidResult(i: { userId: string; paidResultId: string }): { ok: true; paidResultId: string; generation: number; resultJson: unknown } | { ok: false; code: 'not_found' } {
    const row = this.state.paidResults.find(r => r.id === i.paidResultId && r.user_id === i.userId && r.status === 'completed')
    if (!row) return { ok: false, code: 'not_found' }
    return { ok: true, paidResultId: row.id, generation: this.projectionStatus({ userId: row.user_id, toolType: row.tool_type, inputHash: row.input_hash }).generation, resultJson: structuredClone(row.result_json) }
  }
  /**
   * PROPOSED, NOT IMPLEMENTED (G-REOPEN): the reopen that fails closed. Same lookup as today's path (id, owner, completed), plus: the row must equal the
   * max generation, otherwise 'projection_unverified'. It exists in the model only to state the requirement and to show where it differs from today.
   */
  reopenPaidResultFailClosed(i: { userId: string; paidResultId: string }): { ok: true; paidResultId: string; generation: number; resultJson: unknown } | { ok: false; code: 'not_found' | 'projection_unverified' } {
    const opened = this.reopenPaidResult(i)
    if (!opened.ok) return opened
    const row = this.state.paidResults.find(r => r.id === i.paidResultId)!
    if (!this.projectionStatus({ userId: row.user_id, toolType: row.tool_type, inputHash: row.input_hash }).consistent) return { ok: false, code: 'projection_unverified' }
    return opened
  }
  /**
   * PROPOSED history read (it does NOT exist today): one generation by generationId, for its owner, read-only. The only way to reach an OLDER generation;
   * a paidResultId is not found here.
   */
  readGeneration(i: { userId: string; generationId: string }): { ok: true; generation: number; resultJson: unknown; chargeLink: ChargeLink } | { ok: false; code: 'not_found' } {
    const g = this.state.generations.find(x => x.id === i.generationId && x.userId === i.userId)
    return g ? { ok: true, generation: g.generation, resultJson: structuredClone(g.resultJson), chargeLink: g.chargeLink } : { ok: false, code: 'not_found' }
  }

  /** The explicit terminal fence: a tombstone. Money-free. A user may seal only after deadline + margin; an operator any time. */
  seal(req: { token: IntentToken; request: Binding }, as: 'user' | 'operator', opts: { crashAt?: SealStep } = {}): SealResult {
    const bad = this.verifyToken(req.token, req.request)
    if (bad) return { ok: false, code: bad }
    const operationId = deriveOperationId(req.token)
    const sealNotBefore = req.token.deadline + this.sealMarginMs
    return this.tx<SealResult>(() => {
      this.lockLog.push([`op:${operationId}`, `scope:${scopeKey(req.request)}`])
      this.crashIf(opts.crashAt, 'after_locks')
      const existing = this.operation(operationId)
      if (existing?.state === 'committed') return { ok: true, state: 'committed' }
      if (existing?.state === 'sealed') return { ok: true, state: 'sealed', alreadySealed: true }
      if (as === 'user' && this.nowMs < sealNotBefore) return { ok: false, code: 'seal_too_early', sealNotBefore }
      this.state.operations.push({ operationId, userId: req.request.userId, toolType: req.request.toolType, inputHash: req.request.inputHash, generation: null, bindingDigest: digestOf([req.request.userId, req.request.deviceDigest, req.request.toolType, req.request.inputHash]), keyDigest: digestOf(req.token.nonce), state: 'sealed', creditTransactionId: null, generationId: null, origin: 'atomic', sealedBy: as })
      this.crashIf(opts.crashAt, 'after_tombstone')
      return { ok: true, state: 'sealed' }
    })
  }

  /** R class: read-only reconcile. Takes NO lock, writes NOTHING, returns NO token. `not_visible` is NOT proof of "no charge". */
  status(token: IntentToken, request: Binding): StatusResult {
    const bad = this.verifyToken(token, request)
    if (bad) return { state: 'rejected', code: bad }
    const op = this.operation(deriveOperationId(token))
    if (op?.state === 'committed') return { state: 'committed', generation: op.generation!, ...this.identifiersFor(op, op.generationId!) }
    if (op?.state === 'sealed') return { state: 'sealed' }
    return { state: 'not_visible', sealNotBefore: token.deadline + this.sealMarginMs }
  }

  private materializeLegacyGeneration(row: PaidResultRow) {
    const operationId = legacyOperationId(row.id)
    if (this.operation(operationId)) throw new ModelConstraintViolation('legacy operation already materialised')
    const gen: GenerationRow = { id: this.nextId('gen'), userId: row.user_id, toolType: row.tool_type, inputHash: row.input_hash, generation: 1, operationId, resultJson: structuredClone(row.result_json), resultDigest: digestOf(row.result_json), carried: carriedOf(row), carriedDigest: carriedDigestOf(carriedOf(row)), chargeLink: 'unlinked_legacy', creditTransactionId: null, origin: 'legacy_backfill' }
    this.state.generations.push(gen)
    this.state.operations.push({ operationId, userId: row.user_id, toolType: row.tool_type, inputHash: row.input_hash, generation: 1, bindingDigest: 'legacy_backfill', keyDigest: 'legacy_backfill', state: 'committed', creditTransactionId: null, generationId: gen.id, origin: 'legacy_backfill', sealedBy: null })
  }

  // ─────────── money after the fact: three DIFFERENT instruments ───────────
  /** Business credit: after a COMPLETED result whose charge is LINKED. Separate reason and reference; the result and the operation row stay untouched. */
  businessCredit(i: { operationId: string; amount: number; operatorId: string }): { ok: true; ledgerId: string } | { ok: false; code: 'operation_not_committed' | 'charge_not_linkable' | 'already_credited' | 'invalid_amount' | 'operator_required' } {
    if (!i.operatorId) return { ok: false, code: 'operator_required' }
    return this.tx(() => {
      this.lockLog.push([`op:${i.operationId}`])
      const op = this.operation(i.operationId)
      if (!op || op.state !== 'committed') return { ok: false, code: 'operation_not_committed' } as const
      if (op.origin !== 'atomic' || !op.creditTransactionId) return { ok: false, code: 'charge_not_linkable' } as const
      if (this.ledgerByRef(`bc:${i.operationId}`).length > 0) return { ok: false, code: 'already_credited' } as const
      if (!(i.amount > 0) || i.amount > this.priceOf(op.toolType)) return { ok: false, code: 'invalid_amount' } as const
      const row: LedgerRow = { id: this.nextId('ledger'), userId: op.userId, feature: op.toolType, externalRef: `bc:${i.operationId}`, reason: 'business_credit', delta: i.amount, relatedTransactionId: op.creditTransactionId, note: `operator:${i.operatorId}` }
      this.state.ledger.push(row)
      this.state.balances[op.userId] += i.amount
      return { ok: true, ledgerId: row.id } as const
    })
  }

  /**
   * A HUMAN decision taken under UNCERTAINTY about a LEGACY spend with no linked result. Not a refund of a proven failure, no automatic caller,
   * and it changes nothing about generations, the projection or any operation: a later legacy save stays possible (reported, never clawed back).
   */
  operatorCreditUncertain(i: { spendLedgerId: string; amount: number; operatorId: string; evidence: string[] }): { ok: true; ledgerId: string } | { ok: false; code: 'operator_required' | 'evidence_required' | 'spend_not_found' | 'atomic_spend_not_orphanable' | 'already_decided' | 'invalid_amount' } {
    if (!i.operatorId) return { ok: false, code: 'operator_required' }
    if (!i.evidence.length) return { ok: false, code: 'evidence_required' }
    const spend = this.state.ledger.find(l => l.id === i.spendLedgerId && l.reason === 'credit_spend')
    if (!spend) return { ok: false, code: 'spend_not_found' }
    if (spend.externalRef.startsWith('op:')) return { ok: false, code: 'atomic_spend_not_orphanable' }
    if (this.ledgerByRef(`opc:${spend.id}`).length > 0 || this.ledgerByRef(`refund:${spend.id}`).length > 0) return { ok: false, code: 'already_decided' }
    if (!(i.amount > 0) || i.amount > -spend.delta) return { ok: false, code: 'invalid_amount' }
    const row: LedgerRow = { id: this.nextId('ledger'), userId: spend.userId, feature: spend.feature, externalRef: `opc:${spend.id}`, reason: 'operator_credit_uncertain', delta: i.amount, relatedTransactionId: spend.id, note: `uncertain; operator:${i.operatorId}; evidence:${i.evidence.join(',')}` }
    this.state.ledger.push(row)
    this.state.balances[spend.userId] += i.amount
    return { ok: true, ledgerId: row.id }
  }

  /** Model of the existing refund_credit_spend (idempotent per spend) plus the PROPOSED guards (a decision, change to an existing RPC): refuse `op:` spends (an atomic spend is never orphaned) and refuse a spend a human already decided on. */
  refundCreditSpend(spendLedgerId: string): { ok: true; ledgerId: string } | { ok: false; code: 'spend_not_found' | 'op_spend_not_refundable' | 'already_refunded' | 'already_decided' } {
    const spend = this.state.ledger.find(l => l.id === spendLedgerId && l.reason === 'credit_spend')
    if (!spend) return { ok: false, code: 'spend_not_found' }
    if (this.guardRefundOfOpSpends && spend.externalRef.startsWith('op:')) return { ok: false, code: 'op_spend_not_refundable' }
    if (this.ledgerByRef(`refund:${spend.id}`).length > 0) return { ok: false, code: 'already_refunded' }
    if (this.ledgerByRef(`opc:${spend.id}`).length > 0) return { ok: false, code: 'already_decided' } // the two instruments exclude each other (proposed guard, same family as the op-spend guard)
    const row: LedgerRow = { id: this.nextId('ledger'), userId: spend.userId, feature: spend.feature, externalRef: `refund:${spend.id}`, reason: 'credit_refund', delta: -spend.delta, relatedTransactionId: spend.id, note: null }
    this.state.ledger.push(row)
    this.state.balances[spend.userId] += row.delta
    return { ok: true, ledgerId: row.id }
  }
}

// ───────────────────────────── the spend fence as a PRIVILEGE rule over a catalog snapshot ─────────────────────────────
// The snapshot is what a real database would answer to: pg_proc (proname, proowner, prosecdef, proacl / has_function_privilege) and pg_auth_members.
// Here it is AUTHORED in tests, so the rules are verifiable but NOT yet verified: a DB integration test must fill it from the real catalog.
export interface CatalogFunction { name: string; owner: string; securityDefiner: boolean; executeGrantees: string[] } // 'PUBLIC' is the pseudo-grantee
export interface CatalogRole { name: string; memberOf: string[] }
/** WHERE a snapshot came from. Only 'pg_catalog_query' is database evidence; the two others are NOT. */
export type CatalogProvenance = 'authored_in_test' | 'derived_from_migrations' | 'pg_catalog_query'
export interface CatalogSnapshot { provenance: CatalogProvenance; functions: CatalogFunction[]; roles: CatalogRole[] }
export const SPEND_FENCE_FUNCTIONS = { wrapper: 'spend_credits', core: 'spend_credits_core', commit: 'paid_operation_commit' } as const
const REQUEST_ROLES = ['service_role', 'anon', 'authenticated', 'authenticator'] // the roles a request can run as (PostgREST: authenticator -> SET ROLE)

function roleClosure(roles: CatalogRole[], start: string): Set<string> {
  const seen = new Set<string>([start])
  const queue = [start]
  while (queue.length) {
    const role = queue.shift()
    for (const parent of roles.find(r => r.name === role)?.memberOf ?? []) if (!seen.has(parent)) { seen.add(parent); queue.push(parent) }
  }
  return seen
}

/**
 * The rules that make "a direct caller cannot charge a cut-over feature" a statement about PRIVILEGES, not about `current_user`:
 *   1. the CORE is executable by nobody but its owner (so service_role, anon, authenticated and PUBLIC cannot call it);
 *   2. the legacy WRAPPER keeps EXECUTE for service_role (the legacy callers keep working) and is closed to anon, authenticated and PUBLIC;
 *   3. the COMMIT function is SECURITY DEFINER (it runs with its owner's rights, so it can reach the core) and is executable by service_role only;
 *   4. the commit owner can execute the core;
 *   5. no request role can become the owner of the core (directly or through a chain of role memberships).
 * Returns the violations; empty = the rules hold for this snapshot.
 */
export function checkSpendFenceCatalog(c: CatalogSnapshot): string[] {
  const v: string[] = []
  const find = (n: string) => c.functions.find(f => f.name === n)
  const wrapper = find(SPEND_FENCE_FUNCTIONS.wrapper)
  const core = find(SPEND_FENCE_FUNCTIONS.core)
  const commit = find(SPEND_FENCE_FUNCTIONS.commit)
  if (!wrapper) v.push('spend_credits missing')
  else {
    if (!wrapper.executeGrantees.includes('service_role')) v.push('legacy spend_credits not executable by service_role (legacy callers would break)')
    for (const bad of ['PUBLIC', 'anon', 'authenticated']) if (wrapper.executeGrantees.includes(bad)) v.push(`spend_credits executable by ${bad}`)
  }
  if (!core) v.push('spend_credits_core missing')
  else for (const g of core.executeGrantees) if (g !== core.owner) v.push(`spend_credits_core executable by ${g}`)
  if (!commit) v.push('paid_operation_commit missing')
  else {
    if (!commit.securityDefiner) v.push('paid_operation_commit is not SECURITY DEFINER')
    if (!commit.executeGrantees.includes('service_role')) v.push('paid_operation_commit not executable by service_role')
    for (const bad of ['PUBLIC', 'anon', 'authenticated']) if (commit.executeGrantees.includes(bad)) v.push(`paid_operation_commit executable by ${bad}`)
    if (core && commit.owner !== core.owner && !core.executeGrantees.includes(commit.owner)) v.push('commit owner cannot execute spend_credits_core')
  }
  if (core) for (const r of REQUEST_ROLES) if (roleClosure(c.roles, r).has(core.owner)) v.push(`${r} can become ${core.owner}, the owner of spend_credits_core`)
  return v
}

const BASE_ROLES = (): CatalogRole[] => [
  { name: 'postgres', memberOf: [] }, { name: 'service_role', memberOf: [] }, { name: 'anon', memberOf: [] }, { name: 'authenticated', memberOf: [] },
  { name: 'authenticator', memberOf: ['anon', 'authenticated', 'service_role'] },
]
/** What the migrations pin TODAY (090:159): spend_credits owner postgres, SECURITY DEFINER, EXECUTE for postgres and service_role; no core, no commit function. DERIVED FROM SOURCE, not read from a database. */
export const catalogToday = (): CatalogSnapshot => ({
  provenance: 'derived_from_migrations',
  functions: [{ name: 'spend_credits', owner: 'postgres', securityDefiner: true, executeGrantees: ['postgres', 'service_role'] }],
  roles: BASE_ROLES(),
})
/** The PROPOSED state after a wrapper/core split: AUTHORED IN A TEST, SIMULATED -- not built, not read from, and not verified on any database. */
export const referenceCatalogAfterSplit = (): CatalogSnapshot => ({
  provenance: 'authored_in_test',
  functions: [
    { name: 'spend_credits', owner: 'postgres', securityDefiner: true, executeGrantees: ['postgres', 'service_role'] },
    { name: 'spend_credits_core', owner: 'postgres', securityDefiner: true, executeGrantees: ['postgres'] },
    { name: 'paid_operation_commit', owner: 'postgres', securityDefiner: true, executeGrantees: ['postgres', 'service_role'] },
  ],
  roles: BASE_ROLES(),
})

// ───────────────────────────── lock-order guard + deadlock simulation ─────────────────────────────
/** The mandatory acquisition order inside one transaction: tool lock(s) first, then operation lock(s), then scope lock(s). */
const LOCK_RANK: Record<string, number> = { tool: 0, op: 1, scope: 2 }
export function assertLockOrder(sequence: string[]): void {
  let last = -1
  for (const lock of sequence) {
    const rank = LOCK_RANK[lock.split(':')[0]]
    if (rank === undefined) throw new Error(`unknown lock kind: ${lock}`)
    if (rank < last) throw new Error(`lock order violated: ${sequence.join(' -> ')}`)
    last = rank
  }
}

/** Round-robin acquisition of advisory locks that are released only when the whole transaction ends. 'deadlock' = nobody can proceed. */
export function simulateLockAcquisition(seqs: string[][]): 'ok' | 'deadlock' {
  const pos = seqs.map(() => 0)
  const holder = new Map<string, number>()
  const done = seqs.map(s => s.length === 0)
  while (done.some(d => !d)) {
    let progressed = false
    for (let i = 0; i < seqs.length; i++) {
      if (done[i]) continue
      const want = seqs[i][pos[i]]
      const h = holder.get(want)
      if (h === undefined || h === i) {
        holder.set(want, i)
        pos[i]++
        progressed = true
        if (pos[i] === seqs[i].length) { done[i] = true; for (const [k, v] of [...holder]) if (v === i) holder.delete(k) }
      }
    }
    if (!progressed) return 'deadlock'
  }
  return 'ok'
}

// ───────────────────────────── invariants ─────────────────────────────
/** Every violation of the D1/D2 invariants in a state (empty = consistent). Used after every permutation, crash and rollback. */
export function checkInvariants(m: PaidOperationsModel): string[] {
  const s = m.state
  const v: string[] = []
  const refs = s.ledger.map(l => l.externalRef)
  if (new Set(refs).size !== refs.length) v.push('ledger external_ref not unique')
  const users = new Set([...Object.keys(m.initialBalances), ...Object.keys(s.balances)])
  for (const u of users) {
    const expected = (m.initialBalances[u] ?? 0) + s.ledger.filter(l => l.userId === u).reduce((a, l) => a + l.delta, 0)
    if (s.balances[u] !== expected) v.push(`balance of ${u} is ${s.balances[u]}, ledger says ${expected}`)
  }
  const opIds = s.operations.map(o => o.operationId)
  if (new Set(opIds).size !== opIds.length) v.push('operation_id not unique')
  for (const l of s.ledger.filter(l => l.reason === 'credit_spend' && l.externalRef.startsWith('op:'))) {
    const ops = s.operations.filter(o => o.creditTransactionId === l.id)
    if (ops.length !== 1 || ops[0].state !== 'committed' || `op:${ops[0].operationId}` !== l.externalRef) v.push(`op spend ${l.externalRef} has no single committed operation`)
  }
  for (const o of s.operations) {
    const debits = s.ledger.filter(l => l.reason === 'credit_spend' && l.externalRef === `op:${o.operationId}`)
    const gens = s.generations.filter(g => g.operationId === o.operationId)
    if (o.state === 'sealed') {
      if (o.creditTransactionId || o.generationId || o.generation !== null || debits.length || gens.length) v.push(`sealed ${o.operationId} carries a debit or a generation`)
    } else if (o.origin === 'atomic') {
      if (debits.length !== 1 || !o.creditTransactionId || debits[0].id !== o.creditTransactionId) v.push(`committed ${o.operationId} lacks exactly one linked debit`)
      if (gens.length !== 1 || gens[0].id !== o.generationId || gens[0].chargeLink !== 'linked' || gens[0].creditTransactionId !== o.creditTransactionId) v.push(`committed ${o.operationId} lacks its linked generation`)
    } else {
      if (o.creditTransactionId || debits.length) v.push(`legacy ${o.operationId} is linked to a charge`)
      if (gens.length !== 1 || gens[0].chargeLink !== 'unlinked_legacy' || gens[0].creditTransactionId !== null || gens[0].generation !== 1) v.push(`legacy ${o.operationId} generation is not the unlinked generation 1`)
    }
  }
  const scopes = new Set(s.generations.map(g => scopeKey({ userId: g.userId, toolType: g.toolType, inputHash: g.inputHash })))
  for (const key of scopes) {
    const gens = s.generations.filter(g => scopeKey({ userId: g.userId, toolType: g.toolType, inputHash: g.inputHash }) === key).sort((a, b) => a.generation - b.generation)
    if (gens.some((g, i) => g.generation !== i + 1)) v.push(`generations of ${key} are not 1..n`)
    const p = m.projectionStatus(gens[0])
    if (!p.consistent) v.push(`projection_diverged ${key}`)
  }
  for (const g of s.generations) if (g.chargeLink === 'linked' && !s.cutover[g.toolType]) v.push(`linked generation on a tool_type that is not cut over: ${g.toolType}`)
  for (const l of s.ledger.filter(l => l.reason === 'business_credit')) {
    const op = s.operations.find(o => `bc:${o.operationId}` === l.externalRef)
    if (!op || op.state !== 'committed' || op.origin !== 'atomic') v.push(`business credit ${l.externalRef} is not on a committed linked operation`)
  }
  for (const l of s.ledger.filter(l => l.reason === 'credit_refund' || l.reason === 'operator_credit_uncertain')) {
    const spend = s.ledger.find(x => x.id === l.relatedTransactionId)
    if (spend?.externalRef.startsWith('op:')) v.push(`refund_of_op_spend ${l.externalRef}`)
  }
  return v
}
