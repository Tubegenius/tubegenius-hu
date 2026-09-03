// PFM Collector Seed Admin v0 -- shared, testable CLI-support logic.
//
// Kept separate from scripts/signal-seed-admin.ts (a thin argument-parsing/
// wiring shell) so the actual decision logic is unit-testable without
// spawning a real subprocess, matching the established pattern in
// execute-approved-review-cli-support.ts / post-completion-review-recovery.ts.
//
// The seed fingerprint is ALWAYS computed here via the real, single-source
// computeFingerprint() (fingerprint.ts) -- never re-implemented, never a
// hand-typed hash. This module never reads .env/.env.local; the caller
// (scripts/signal-seed-admin.ts) is responsible for supplying an already-
// configured admin client from the real process environment.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { computeFingerprint } from './fingerprint'
import type { SignalAdminClient } from './collection-types'

export const SEED_MANIFEST_CONTRACT_VERSION = 'v1'

export const SUPPORTED_CATEGORIES = [
  'news_current', 'tech_ai', 'science_medical', 'space_discovery', 'psychology',
  'health_wellness', 'finance_crypto', 'history_strange', 'gaming', 'entertainment', 'default',
] as const
export type SupportedCategory = (typeof SUPPORTED_CATEGORIES)[number]

export const SUPPORTED_REGIONS = ['HU', 'US', 'BOTH'] as const
export type SupportedRegion = (typeof SUPPORTED_REGIONS)[number]

export const SUPPORTED_LANGUAGES = ['hu', 'en'] as const
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

export const SUPPORTED_SEED_TYPES = ['curated_global', 'user_niche_aggregate', 'tracked_candidate', 'cluster_reseed'] as const
export type SupportedSeedType = (typeof SUPPORTED_SEED_TYPES)[number]

export const DEACTIVATE_REASON_CODES = [
  'LOW_QUALITY_YIELD', 'DUPLICATE_COVERAGE', 'QUOTA_REDUCTION', 'OPERATOR_REQUESTED', 'PHASE_ROLLBACK',
] as const
export type DeactivateReasonCode = (typeof DEACTIVATE_REASON_CODES)[number]

export interface SeedManifestEntry {
  id: string
  seedText: string
  category: SupportedCategory
  region: SupportedRegion
  language: SupportedLanguage
  seedType: SupportedSeedType
}

export interface SeedManifest {
  manifestVersion: string
  contractVersion: string
  seeds: SeedManifestEntry[]
}

export type LoadManifestResult =
  | { ok: true; manifest: SeedManifest }
  | { ok: false; message: string }

function isSupportedCategory(v: unknown): v is SupportedCategory {
  return typeof v === 'string' && (SUPPORTED_CATEGORIES as readonly string[]).includes(v)
}
function isSupportedRegion(v: unknown): v is SupportedRegion {
  return typeof v === 'string' && (SUPPORTED_REGIONS as readonly string[]).includes(v)
}
function isSupportedLanguage(v: unknown): v is SupportedLanguage {
  return typeof v === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(v)
}
function isSupportedSeedType(v: unknown): v is SupportedSeedType {
  return typeof v === 'string' && (SUPPORTED_SEED_TYPES as readonly string[]).includes(v)
}

// Pure parsing -- never touches the filesystem itself, so it is directly
// unit-testable with an in-memory string. loadManifestFromPath() below is
// the thin I/O wrapper.
export function parseManifest(raw: string): LoadManifestResult {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return { ok: false, message: 'manifest is not valid JSON' }
  }
  if (!data || typeof data !== 'object') return { ok: false, message: 'manifest must be a JSON object' }
  const obj = data as Record<string, unknown>
  if (typeof obj.manifestVersion !== 'string' || !obj.manifestVersion.trim()) {
    return { ok: false, message: 'manifest.manifestVersion is required' }
  }
  if (obj.contractVersion !== SEED_MANIFEST_CONTRACT_VERSION) {
    return { ok: false, message: `manifest.contractVersion must be "${SEED_MANIFEST_CONTRACT_VERSION}"` }
  }
  if (!Array.isArray(obj.seeds) || obj.seeds.length === 0) {
    return { ok: false, message: 'manifest.seeds must be a non-empty array' }
  }
  const seenIds = new Set<string>()
  const seeds: SeedManifestEntry[] = []
  for (const raw of obj.seeds) {
    if (!raw || typeof raw !== 'object') return { ok: false, message: 'each manifest seed entry must be an object' }
    const entry = raw as Record<string, unknown>
    if (typeof entry.id !== 'string' || !/^[a-z0-9-]{3,80}$/.test(entry.id)) {
      return { ok: false, message: `manifest seed has an invalid id: ${String(entry.id)}` }
    }
    if (seenIds.has(entry.id)) return { ok: false, message: `duplicate manifest seed id: ${entry.id}` }
    seenIds.add(entry.id)
    if (typeof entry.seedText !== 'string' || !entry.seedText.trim() || entry.seedText.length > 300) {
      return { ok: false, message: `manifest seed ${entry.id} has an invalid seedText` }
    }
    if (!isSupportedCategory(entry.category)) return { ok: false, message: `manifest seed ${entry.id} has an unsupported category` }
    if (!isSupportedRegion(entry.region)) return { ok: false, message: `manifest seed ${entry.id} has an unsupported region` }
    if (!isSupportedLanguage(entry.language)) return { ok: false, message: `manifest seed ${entry.id} has an unsupported language` }
    if (!isSupportedSeedType(entry.seedType)) return { ok: false, message: `manifest seed ${entry.id} has an unsupported seedType` }
    seeds.push({
      id: entry.id, seedText: entry.seedText, category: entry.category,
      region: entry.region, language: entry.language, seedType: entry.seedType,
    })
  }
  return { ok: true, manifest: { manifestVersion: obj.manifestVersion, contractVersion: obj.contractVersion, seeds } }
}

export function loadManifestFromPath(path: string): LoadManifestResult {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    return { ok: false, message: `unable to read manifest file: ${error instanceof Error ? error.message : String(error)}` }
  }
  return parseManifest(raw)
}

export interface PreparedSeed extends SeedManifestEntry {
  fingerprint: string
}

export type PrepareSeedResult = { ok: true; seed: PreparedSeed } | { ok: false; message: string }

// Wraps computeFingerprint() with the EXACT parameter shape
// captureScheduledDiscovery() uses for scheduled-seed clusters (candidateTopicEn
// null, candidateTopic=seedText, seedKeyword=seedText) -- see fingerprint.ts /
// capture.ts. Never a second, hand-written formula.
export function prepareSeed(entry: SeedManifestEntry): PrepareSeedResult {
  const computed = computeFingerprint({
    category: entry.category, candidateTopicEn: null, candidateTopic: entry.seedText, seedKeyword: entry.seedText,
  })
  if (!computed) return { ok: false, message: `unable to compute a fingerprint for manifest seed ${entry.id}` }
  return { ok: true, seed: { ...entry, fingerprint: computed.fingerprint } }
}

// Deterministic per (manifestVersion, seed.id) -- re-running the CLI against
// the SAME manifest always replays instead of erroring; a genuinely edited
// manifest entry (different payload under the same id) is caught by the
// RPC's own IDEMPOTENCY_KEY_REUSE / FINGERPRINT_PAYLOAD_CONFLICT checks, not
// silently accepted here.
export function deriveRegisterIdempotencyKey(manifestVersion: string, seedId: string): string {
  return `signal-seed-admin:register:${manifestVersion}:${seedId}`
}

// Deterministic per (targetFingerprint, reasonCode, operatorReference) -- a
// retried identical deactivate command always replays; a genuinely different
// reason/operator gets a genuinely different key, which then correctly
// exercises the RPC's own ALREADY_INACTIVE_DIFFERENT_REQUEST fail-closed path
// if the seed was already deactivated for a different reason.
export function deriveDeactivateIdempotencyKey(targetFingerprint: string, reasonCode: string, operatorReference: string): string {
  const digest = createHash('sha256').update(`${targetFingerprint}:${reasonCode}:${operatorReference}`).digest('hex')
  return `signal-seed-admin:deactivate:${digest.slice(0, 32)}`
}

export const SEED_ADMIN_EXIT_CODE = {
  COMPLETED: 0,
  VALIDATION_OR_CONFIG_ERROR: 2,
  RPC_REJECTED: 3,
  DATABASE_ERROR: 4,
} as const
export type SeedAdminExitCode = (typeof SEED_ADMIN_EXIT_CODE)[keyof typeof SEED_ADMIN_EXIT_CODE]

// ===========================================================================
// Apply Fail-Fast and Project Identity Redaction Remediation gate.
//
// The pre-remediation version of this module logged the RPC's raw
// error.message verbatim on a 'rejected'/'database_error' outcome. That is
// unsafe: register_signal_seed's own FINGERPRINT_PAYLOAD_CONFLICT exception
// text interpolates the full 64-hex fingerprint (`RAISE EXCEPTION '...
// fingerprint % already exists ...', p_fingerprint` in the 083 migration) --
// so the raw message could leak a full fingerprint into a log line. Every
// RPC-outcome type below now carries only a CLOSED reasonCode extracted by
// classifyRpcErrorMessage() below, never the free-text message itself --
// structurally the same guarantee as summarizeHumanReviewForLog() elsewhere
// in this codebase (redact at the type level, not by convention).
// ===========================================================================

export const REGISTER_REJECT_REASON_CODES = [
  'FINGERPRINT_PAYLOAD_CONFLICT', 'IDEMPOTENCY_KEY_REUSE',
  'INVALID_FINGERPRINT_FORMAT', 'INVALID_OPERATOR_REFERENCE_FORMAT', 'INVALID_IDEMPOTENCY_KEY',
] as const
export const DEACTIVATE_REJECT_REASON_CODES = [
  'SEED_NOT_FOUND', 'ALREADY_INACTIVE_DIFFERENT_REQUEST', 'IDEMPOTENCY_KEY_REUSE',
  'INVALID_FINGERPRINT_FORMAT', 'INVALID_REASON_CODE', 'INVALID_OPERATOR_REFERENCE_FORMAT', 'INVALID_IDEMPOTENCY_KEY',
] as const
export type DatabaseErrorReasonCode = 'invalid_rpc_response' | 'unrecognized_outcome' | 'transport_or_unexpected_error'

// Matches ONLY a known, closed reason-code token as a whole word inside the
// raw RPC error text -- never returns (or logs) the surrounding free text,
// which is exactly where a fingerprint/UUID could appear.
function classifyRpcErrorMessage<T extends string>(rawMessage: string, knownCodes: readonly T[]): T | 'unrecognized_error' {
  for (const code of knownCodes) {
    if (new RegExp(`\\b${code}\\b`).test(rawMessage)) return code
  }
  return 'unrecognized_error'
}

export type RegisterSeedRpcOutcome =
  | { kind: 'created'; seedId: string }
  | { kind: 'already_exists'; seedId: string; active: boolean }
  | { kind: 'rejected'; reasonCode: (typeof REGISTER_REJECT_REASON_CODES)[number] | 'unrecognized_error' }
  | { kind: 'database_error'; reasonCode: DatabaseErrorReasonCode }

// Calls the REAL register_signal_seed RPC. `client` is a plain
// postgrest-js-shaped admin client (never created or configured here --
// always supplied by the caller, sourced from the real process environment).
export async function callRegisterSignalSeed(
  client: SignalAdminClient,
  input: { seed: PreparedSeed; operatorReference: string; idempotencyKey: string },
): Promise<RegisterSeedRpcOutcome> {
  const { data, error } = await client.rpc('register_signal_seed', {
    p_seed_text: input.seed.seedText,
    p_category: input.seed.category,
    p_region: input.seed.region,
    p_language: input.seed.language,
    p_seed_type: input.seed.seedType,
    p_fingerprint: input.seed.fingerprint,
    p_operator_reference: input.operatorReference,
    p_idempotency_key: input.idempotencyKey,
  })
  if (error) {
    const message = typeof error.message === 'string' ? error.message : 'unknown database error'
    const reasonCode = classifyRpcErrorMessage(message, REGISTER_REJECT_REASON_CODES)
    return reasonCode === 'unrecognized_error'
      ? { kind: 'database_error', reasonCode: 'transport_or_unexpected_error' }
      : { kind: 'rejected', reasonCode }
  }
  const row = data as { ok?: boolean; outcome?: string; seed_id?: string; active?: boolean } | null
  if (!row || row.ok !== true || typeof row.seed_id !== 'string') {
    return { kind: 'database_error', reasonCode: 'invalid_rpc_response' }
  }
  if (row.outcome === 'created') return { kind: 'created', seedId: row.seed_id }
  if (row.outcome === 'already_exists') return { kind: 'already_exists', seedId: row.seed_id, active: row.active === true }
  return { kind: 'database_error', reasonCode: 'unrecognized_outcome' }
}

export type DeactivateSeedRpcOutcome =
  | { kind: 'deactivated'; seedId: string }
  | { kind: 'already_inactive_replay'; seedId: string }
  | { kind: 'rejected'; reasonCode: (typeof DEACTIVATE_REJECT_REASON_CODES)[number] | 'unrecognized_error' }
  | { kind: 'database_error'; reasonCode: DatabaseErrorReasonCode }

export async function callDeactivateSignalSeed(
  client: SignalAdminClient,
  input: { targetFingerprint: string; reasonCode: DeactivateReasonCode; operatorReference: string; idempotencyKey: string },
): Promise<DeactivateSeedRpcOutcome> {
  const { data, error } = await client.rpc('deactivate_signal_seed', {
    p_target_seed_fingerprint: input.targetFingerprint,
    p_reason_code: input.reasonCode,
    p_operator_reference: input.operatorReference,
    p_idempotency_key: input.idempotencyKey,
  })
  if (error) {
    const message = typeof error.message === 'string' ? error.message : 'unknown database error'
    const reasonCode = classifyRpcErrorMessage(message, DEACTIVATE_REJECT_REASON_CODES)
    return reasonCode === 'unrecognized_error'
      ? { kind: 'database_error', reasonCode: 'transport_or_unexpected_error' }
      : { kind: 'rejected', reasonCode }
  }
  const row = data as { ok?: boolean; outcome?: string; seed_id?: string } | null
  if (!row || row.ok !== true || typeof row.seed_id !== 'string') {
    return { kind: 'database_error', reasonCode: 'invalid_rpc_response' }
  }
  if (row.outcome === 'deactivated') return { kind: 'deactivated', seedId: row.seed_id }
  if (row.outcome === 'already_inactive_replay') return { kind: 'already_inactive_replay', seedId: row.seed_id }
  return { kind: 'database_error', reasonCode: 'unrecognized_outcome' }
}

// ===========================================================================
// Full-manifest, pre-write validation (item 1) and the fail-fast apply loop
// (items 2-4). prepareAllSeeds() computes every seed's fingerprint BEFORE
// applyRegisterManifest() is ever called, so a manifest with a bad entry
// anywhere in it is rejected before any RPC -- not discovered mid-loop.
// ===========================================================================

export type PrepareAllSeedsResult = { ok: true; seeds: PreparedSeed[] } | { ok: false; message: string }

export function prepareAllSeeds(manifest: SeedManifest): PrepareAllSeedsResult {
  const seeds: PreparedSeed[] = []
  for (const entry of manifest.seeds) {
    const result = prepareSeed(entry)
    if (!result.ok) return { ok: false, message: result.message }
    seeds.push(result.seed)
  }
  return { ok: true, seeds }
}

export type ApplySeedProgressEvent =
  | { seedId: string; kind: 'created' }
  | { seedId: string; kind: 'already_exists'; active: boolean }

// Only 'rejected' | 'database_error' | 'exception' can stop the loop --
// deliberately not open-ended, so a future outcome kind neither this file
// nor its caller recognizes cannot silently be treated as success.
export type ApplyStopReason = 'rejected' | 'database_error' | 'exception'

export type ApplyManifestResult =
  | { outcome: 'completed'; succeededCount: number }
  | {
      outcome: 'partial_apply'
      totalSeeds: number
      succeededCount: number
      failedAtIndex: number
      remainingUncalledCount: number
      stopReason: ApplyStopReason
    }

// Applies an already-validated, already-fingerprinted manifest one seed at a
// time, in order. Stops on the FIRST outcome that is not exactly 'created'
// or 'already_exists' (a real RPC rejection, a database/transport error, an
// unrecognized outcome shape -- callRegisterSignalSeed() itself funnels all
// three into 'rejected'/'database_error' already -- or a thrown exception,
// caught here) -- the remaining seeds' RPCs are never called. Already-
// succeeded seeds are never touched, modified, or compensated here; the
// caller decides what to do next. onSeedResult, when supplied, fires only
// for a genuine success (never for the stopping failure), and only with a
// seedId (a manifest-authored label, never a secret) plus a closed outcome
// kind -- never a fingerprint, idempotency key, or raw RPC response.
export async function applyRegisterManifest(
  client: SignalAdminClient,
  input: {
    seeds: PreparedSeed[]
    operatorReference: string
    manifestVersion: string
    onSeedResult?: (event: ApplySeedProgressEvent) => void
  },
): Promise<ApplyManifestResult> {
  let succeededCount = 0
  for (let i = 0; i < input.seeds.length; i++) {
    const seed = input.seeds[i]
    const idempotencyKey = deriveRegisterIdempotencyKey(input.manifestVersion, seed.id)
    let outcome: RegisterSeedRpcOutcome
    try {
      outcome = await callRegisterSignalSeed(client, { seed, operatorReference: input.operatorReference, idempotencyKey })
    } catch {
      return {
        outcome: 'partial_apply', totalSeeds: input.seeds.length, succeededCount,
        failedAtIndex: i + 1, remainingUncalledCount: input.seeds.length - i - 1, stopReason: 'exception',
      }
    }
    if (outcome.kind === 'created') {
      succeededCount += 1
      input.onSeedResult?.({ seedId: seed.id, kind: 'created' })
      continue
    }
    if (outcome.kind === 'already_exists') {
      succeededCount += 1
      input.onSeedResult?.({ seedId: seed.id, kind: 'already_exists', active: outcome.active })
      continue
    }
    // outcome.kind is 'rejected' or 'database_error' -- stop immediately,
    // never call the RPC for any remaining seed.
    return {
      outcome: 'partial_apply', totalSeeds: input.seeds.length, succeededCount,
      failedAtIndex: i + 1, remainingUncalledCount: input.seeds.length - i - 1, stopReason: outcome.kind,
    }
  }
  return { outcome: 'completed', succeededCount }
}
