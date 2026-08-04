// Deterministic, quota-capped seed selection for the Premium discovery lane.
// This module only reads/writes the seed queue and creates DB work batches.

import { createAdminClient } from '@/lib/supabase-server'
import { ensureCollectionBatch, type SignalCollectionBatchRow } from './batches'
import { pacificQuotaDate } from './observation-schedule'
import {
  isUuid,
  toSignalDatabaseError,
  type OperationFailure,
  type SignalAdminClient,
} from './collection-types'

export type SignalSeedType = 'curated_global' | 'user_niche_aggregate' | 'tracked_candidate' | 'cluster_reseed'
export type SignalSeedCategory =
  | 'news_current' | 'tech_ai' | 'science_medical' | 'space_discovery' | 'psychology'
  | 'health_wellness' | 'finance_crypto' | 'history_strange' | 'gaming' | 'entertainment' | 'default'
export type SignalSeedRegion = 'HU' | 'US' | 'BOTH'
export type SignalSeedLanguage = 'hu' | 'en'

export interface SignalSeedRow {
  id: string
  seed_fingerprint: string
  seed_type: SignalSeedType
  seed_text: string
  category: SignalSeedCategory
  region: SignalSeedRegion
  language: SignalSeedLanguage
  active: boolean
  next_due_at: string
  last_run_at: string | null
  consecutive_failure_count: number
  created_at: string
  updated_at: string
}

export type LoadSeedsResult =
  | { outcome: 'success'; seeds: SignalSeedRow[] }
  | OperationFailure

export type PrepareDiscoveryBatchesResult =
  | { outcome: 'success'; quotaDate: string; seeds: SignalSeedRow[]; batches: SignalCollectionBatchRow[] }
  | OperationFailure

const SEED_COLUMNS =
  'id,seed_fingerprint,seed_type,seed_text,category,region,language,active,next_due_at,last_run_at,consecutive_failure_count,created_at,updated_at'

function admin(client?: SignalAdminClient): SignalAdminClient {
  return client ?? createAdminClient()
}

function invalid(message: string): Extract<OperationFailure, { outcome: 'invalid_request' }> {
  return { outcome: 'invalid_request', message }
}

function databaseFailure(operation: string, error: unknown): OperationFailure {
  return { outcome: 'database_error', operation, error: toSignalDatabaseError(error) }
}

function parseSeeds(data: unknown): SignalSeedRow[] | null {
  if (!Array.isArray(data)) return null
  const types: SignalSeedType[] = ['curated_global', 'user_niche_aggregate', 'tracked_candidate', 'cluster_reseed']
  const categories: SignalSeedCategory[] = [
    'news_current', 'tech_ai', 'science_medical', 'space_discovery', 'psychology',
    'health_wellness', 'finance_crypto', 'history_strange', 'gaming', 'entertainment', 'default',
  ]
  const regions: SignalSeedRegion[] = ['HU', 'US', 'BOTH']
  const languages: SignalSeedLanguage[] = ['hu', 'en']
  const rows = data as SignalSeedRow[]
  if (rows.some(row =>
    !row || !isUuid(row.id) ||
    typeof row.seed_fingerprint !== 'string' || !row.seed_fingerprint.trim() ||
    typeof row.seed_text !== 'string' || !row.seed_text.trim() ||
    !types.includes(row.seed_type) || !categories.includes(row.category) ||
    !regions.includes(row.region) || !languages.includes(row.language) ||
    typeof row.active !== 'boolean' || typeof row.next_due_at !== 'string' ||
    (row.last_run_at !== null && typeof row.last_run_at !== 'string') ||
    !Number.isInteger(row.consecutive_failure_count) || row.consecutive_failure_count < 0 ||
    typeof row.created_at !== 'string' || typeof row.updated_at !== 'string'
  )) return null
  return rows
}

export function selectDiscoverySeeds(seeds: SignalSeedRow[], limit = 3): SignalSeedRow[] | null {
  if (!Number.isInteger(limit) || limit < 1 || limit > 3) return null
  return [...seeds]
    .filter(seed => seed.active)
    .sort((left, right) => {
      const due = Date.parse(left.next_due_at) - Date.parse(right.next_due_at)
      return due || left.seed_fingerprint.localeCompare(right.seed_fingerprint) || left.id.localeCompare(right.id)
    })
    .slice(0, limit)
}

export async function loadDueDiscoverySeeds(
  input: { now?: Date; limit?: number } = {},
  client?: SignalAdminClient,
): Promise<LoadSeedsResult> {
  const now = input.now ?? new Date()
  const limit = input.limit ?? 3
  if (!Number.isFinite(now.getTime())) return invalid('now must be a valid date.')
  if (!Number.isInteger(limit) || limit < 1 || limit > 3) return invalid('limit must be an integer between 1 and 3.')
  const operation = 'load_due_signal_discovery_seeds'
  try {
    const { data, error } = await admin(client)
      .from('signal_seed_queue')
      .select(SEED_COLUMNS)
      .eq('active', true)
      .lte('next_due_at', now.toISOString())
      .order('next_due_at', { ascending: true })
      .order('seed_fingerprint', { ascending: true })
      .limit(limit)
    if (error) return databaseFailure(operation, error)
    const seeds = parseSeeds(data)
    return seeds ? { outcome: 'success', seeds } : { outcome: 'invalid_rpc_response', operation }
  } catch (error) {
    return databaseFailure(operation, error)
  }
}

export async function loadDiscoverySeedByFingerprint(
  fingerprint: string,
  client?: SignalAdminClient,
): Promise<{ outcome: 'success'; seed: SignalSeedRow | null } | OperationFailure> {
  if (!fingerprint.trim() || fingerprint.length > 512) return invalid('fingerprint is required and must be at most 512 characters.')
  const operation = 'load_signal_discovery_seed'
  try {
    const { data, error } = await admin(client)
      .from('signal_seed_queue')
      .select(SEED_COLUMNS)
      .eq('seed_fingerprint', fingerprint.trim())
      .eq('active', true)
      .maybeSingle()
    if (error) return databaseFailure(operation, error)
    if (data === null) return { outcome: 'success', seed: null }
    const seeds = parseSeeds([data])
    return seeds ? { outcome: 'success', seed: seeds[0] } : { outcome: 'invalid_rpc_response', operation }
  } catch (error) {
    return databaseFailure(operation, error)
  }
}

export async function prepareDiscoveryBatches(
  input: { runPhaseId: string; now?: Date; limit?: number; maxAttempts?: number; algorithmVersion?: number },
  client?: SignalAdminClient,
): Promise<PrepareDiscoveryBatchesResult> {
  if (!isUuid(input.runPhaseId)) return invalid('runPhaseId must be a UUID.')
  const now = input.now ?? new Date()
  const quotaDate = pacificQuotaDate(now)
  if (!quotaDate) return invalid('now must be a valid date.')
  const loaded = await loadDueDiscoverySeeds({ now, limit: input.limit }, client)
  if (loaded.outcome !== 'success') return loaded
  const selected = selectDiscoverySeeds(loaded.seeds, input.limit ?? 3)
  if (!selected) return invalid('Discovery seed selection options are invalid.')

  const batches: SignalCollectionBatchRow[] = []
  for (const seed of selected) {
    const ensured = await ensureCollectionBatch({
      runPhaseId: input.runPhaseId,
      phase: 'discovery',
      bucket: quotaDate,
      provider: 'youtube',
      operation: 'youtube.search.list',
      itemIds: [seed.seed_fingerprint],
      algorithmVersion: input.algorithmVersion,
      maxAttempts: input.maxAttempts,
    }, client)
    if (ensured.outcome !== 'success') return ensured
    batches.push(ensured.batch)
  }
  return { outcome: 'success', quotaDate, seeds: selected, batches }
}

async function updateSeed(
  input: { seedId: string; success: boolean; now: Date },
  client?: SignalAdminClient,
): Promise<{ outcome: 'success' } | OperationFailure> {
  if (!isUuid(input.seedId)) return invalid('seedId must be a UUID.')
  if (!Number.isFinite(input.now.getTime())) return invalid('now must be a valid date.')
  const operation = input.success ? 'mark_signal_seed_success' : 'mark_signal_seed_failure'
  const db = admin(client)
  try {
    const { data: current, error: readError } = await db
      .from('signal_seed_queue')
      .select('consecutive_failure_count')
      .eq('id', input.seedId)
      .eq('active', true)
      .maybeSingle()
    if (readError) return databaseFailure(operation, readError)
    if (!current || !Number.isInteger(current.consecutive_failure_count)) {
      return { outcome: 'invalid_transition', message: 'Active seed was not found.' }
    }
    const nextDue = new Date(input.now.getTime() + (input.success ? 24 * 60 * 60_000 : 60 * 60_000)).toISOString()
    const { data, error } = await db
      .from('signal_seed_queue')
      .update({
        next_due_at: nextDue,
        last_run_at: input.now.toISOString(),
        consecutive_failure_count: input.success ? 0 : Number(current.consecutive_failure_count) + 1,
        updated_at: input.now.toISOString(),
      })
      .eq('id', input.seedId)
      .eq('active', true)
      .eq('consecutive_failure_count', current.consecutive_failure_count)
      .select('id')
      .maybeSingle()
    if (error) return databaseFailure(operation, error)
    return data ? { outcome: 'success' } : { outcome: 'invalid_transition', message: 'Seed update race was lost.' }
  } catch (error) {
    return databaseFailure(operation, error)
  }
}

export function markDiscoverySeedSuccess(seedId: string, now = new Date(), client?: SignalAdminClient) {
  return updateSeed({ seedId, success: true, now }, client)
}

export function markDiscoverySeedFailure(seedId: string, now = new Date(), client?: SignalAdminClient) {
  return updateSeed({ seedId, success: false, now }, client)
}
