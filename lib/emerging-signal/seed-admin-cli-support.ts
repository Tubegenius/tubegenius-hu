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

export type RegisterSeedRpcOutcome =
  | { kind: 'created'; seedId: string }
  | { kind: 'already_exists'; seedId: string; active: boolean }
  | { kind: 'rejected'; errorMessage: string }
  | { kind: 'database_error'; errorMessage: string }

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
    return /FINGERPRINT_PAYLOAD_CONFLICT|IDEMPOTENCY_KEY_REUSE|INVALID_/.test(message)
      ? { kind: 'rejected', errorMessage: message }
      : { kind: 'database_error', errorMessage: message }
  }
  const row = data as { ok?: boolean; outcome?: string; seed_id?: string; active?: boolean } | null
  if (!row || row.ok !== true || typeof row.seed_id !== 'string') {
    return { kind: 'database_error', errorMessage: 'invalid_rpc_response' }
  }
  if (row.outcome === 'created') return { kind: 'created', seedId: row.seed_id }
  if (row.outcome === 'already_exists') return { kind: 'already_exists', seedId: row.seed_id, active: row.active === true }
  return { kind: 'database_error', errorMessage: `invalid_rpc_response: unrecognized outcome ${String(row.outcome)}` }
}

export type DeactivateSeedRpcOutcome =
  | { kind: 'deactivated'; seedId: string }
  | { kind: 'already_inactive_replay'; seedId: string }
  | { kind: 'rejected'; errorMessage: string }
  | { kind: 'database_error'; errorMessage: string }

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
    return /SEED_NOT_FOUND|ALREADY_INACTIVE_DIFFERENT_REQUEST|IDEMPOTENCY_KEY_REUSE|INVALID_/.test(message)
      ? { kind: 'rejected', errorMessage: message }
      : { kind: 'database_error', errorMessage: message }
  }
  const row = data as { ok?: boolean; outcome?: string; seed_id?: string } | null
  if (!row || row.ok !== true || typeof row.seed_id !== 'string') {
    return { kind: 'database_error', errorMessage: 'invalid_rpc_response' }
  }
  if (row.outcome === 'deactivated') return { kind: 'deactivated', seedId: row.seed_id }
  if (row.outcome === 'already_inactive_replay') return { kind: 'already_inactive_replay', seedId: row.seed_id }
  return { kind: 'database_error', errorMessage: `invalid_rpc_response: unrecognized outcome ${String(row.outcome)}` }
}
