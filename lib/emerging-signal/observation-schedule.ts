// Due-observation selection and deterministic batch preparation for the
// Premium Emerging Signal collector. No provider is called from this module.

import { createAdminClient } from '@/lib/supabase-server'
import { ensureCollectionBatch, type SignalCollectionBatchRow } from './batches'
import {
  isUuid,
  toSignalDatabaseError,
  type OperationFailure,
  type SignalAdminClient,
} from './collection-types'

export type ObservationCadence = 'early8h' | 'daily' | 'weekly'

export interface DueObservationTarget {
  scheduleId: string
  evidenceId: string
  videoId: string
  cadence: ObservationCadence
  nextDueAt: string
  lastObservedAt: string | null
  consecutiveStagnantChecks: number
  consecutiveMissChecks: number
}

export interface ObservationBatchPlan {
  quotaDate: string
  selectedTargets: DueObservationTarget[]
  batches: string[][]
  uniqueVideoCount: number
  deferredUniqueVideoCount: number
  invalidTargetCount: number
}

export type LoadObservationTargetsResult =
  | { outcome: 'success'; targets: DueObservationTarget[] }
  | OperationFailure

export type PrepareObservationBatchesResult =
  | { outcome: 'success'; plan: ObservationBatchPlan; batches: SignalCollectionBatchRow[] }
  | OperationFailure

const TARGET_COLUMNS =
  'id,signal_evidence_id,cadence,next_due_at,last_observed_at,consecutive_stagnant_checks,consecutive_miss_checks,active,signal_evidence!inner(id,evidence_type,external_ref,youtube_videos_ref)'

function admin(client?: SignalAdminClient): SignalAdminClient {
  return client ?? createAdminClient()
}

function invalid(message: string): Extract<OperationFailure, { outcome: 'invalid_request' }> {
  return { outcome: 'invalid_request', message }
}

function databaseFailure(operation: string, error: unknown): OperationFailure {
  return { outcome: 'database_error', operation, error: toSignalDatabaseError(error) }
}

function evidenceObject(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return value.length === 1 && value[0] && typeof value[0] === 'object'
    ? value[0] as Record<string, unknown>
    : null
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

export function canonicalObservationVideoId(
  youtubeVideosRef: unknown,
  externalRef: unknown,
): string | null {
  const preferred = typeof youtubeVideosRef === 'string' ? youtubeVideosRef.trim() : ''
  const fallback = typeof externalRef === 'string' ? externalRef.trim() : ''
  const videoId = preferred || fallback
  // YouTube video IDs are URL-safe tokens. The upper bound also prevents an
  // untrusted DB value from inflating a PostgREST filter later in the worker.
  return /^[A-Za-z0-9_-]{1,100}$/.test(videoId) ? videoId : null
}

function canonicalVideoId(evidence: Record<string, unknown>): string | null {
  return canonicalObservationVideoId(evidence.youtube_videos_ref, evidence.external_ref)
}

function parseTarget(row: unknown): DueObservationTarget | null {
  if (!row || typeof row !== 'object') return null
  const value = row as Record<string, unknown>
  const evidence = evidenceObject(value.signal_evidence)
  if (!evidence || evidence.evidence_type !== 'youtube_video') return null
  const videoId = canonicalVideoId(evidence)
  if (
    !videoId ||
    typeof value.id !== 'string' || !isUuid(value.id) ||
    typeof value.signal_evidence_id !== 'string' || !isUuid(value.signal_evidence_id) ||
    !['early8h', 'daily', 'weekly'].includes(String(value.cadence)) ||
    typeof value.next_due_at !== 'string' ||
    (value.last_observed_at !== null && typeof value.last_observed_at !== 'string') ||
    !Number.isInteger(value.consecutive_stagnant_checks) || Number(value.consecutive_stagnant_checks) < 0 ||
    !Number.isInteger(value.consecutive_miss_checks) || Number(value.consecutive_miss_checks) < 0
  ) return null

  return {
    scheduleId: value.id,
    evidenceId: value.signal_evidence_id,
    videoId,
    cadence: value.cadence as ObservationCadence,
    nextDueAt: value.next_due_at,
    lastObservedAt: value.last_observed_at as string | null,
    consecutiveStagnantChecks: Number(value.consecutive_stagnant_checks),
    consecutiveMissChecks: Number(value.consecutive_miss_checks),
  }
}

export function pacificQuotaDate(now: Date): string | null {
  if (!Number.isFinite(now.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now)
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value
  const year = pick('year')
  const month = pick('month')
  const day = pick('day')
  return year && month && day ? `${year}-${month}-${day}` : null
}

export function buildObservationBatchPlan(
  targets: DueObservationTarget[],
  input: { now: Date; maxUniqueVideoIds?: number; batchSize?: number },
): ObservationBatchPlan | null {
  const quotaDate = pacificQuotaDate(input.now)
  const maxUniqueVideoIds = input.maxUniqueVideoIds ?? 200
  const batchSize = input.batchSize ?? 50
  if (
    !quotaDate ||
    !Number.isInteger(maxUniqueVideoIds) || maxUniqueVideoIds < 1 || maxUniqueVideoIds > 200 ||
    !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50
  ) return null

  const valid = targets
    .filter(target =>
      isUuid(target.scheduleId) && isUuid(target.evidenceId) &&
      /^[A-Za-z0-9_-]{1,100}$/.test(target.videoId) &&
      ['early8h', 'daily', 'weekly'].includes(target.cadence) &&
      Number.isFinite(Date.parse(target.nextDueAt)),
    )
    .sort((left, right) => {
      const due = Date.parse(left.nextDueAt) - Date.parse(right.nextDueAt)
      return due || left.videoId.localeCompare(right.videoId) || left.evidenceId.localeCompare(right.evidenceId)
    })

  const allVideoIds: string[] = []
  const seen = new Set<string>()
  for (const target of valid) {
    if (!seen.has(target.videoId)) {
      seen.add(target.videoId)
      allVideoIds.push(target.videoId)
    }
  }
  const selectedVideoIds = allVideoIds.slice(0, maxUniqueVideoIds)
  const selected = new Set(selectedVideoIds)
  const batches: string[][] = []
  for (let index = 0; index < selectedVideoIds.length; index += batchSize) {
    batches.push(selectedVideoIds.slice(index, index + batchSize))
  }

  return {
    quotaDate,
    selectedTargets: valid.filter(target => selected.has(target.videoId)),
    batches,
    uniqueVideoCount: selectedVideoIds.length,
    deferredUniqueVideoCount: Math.max(0, allVideoIds.length - selectedVideoIds.length),
    invalidTargetCount: targets.length - valid.length,
  }
}

export async function loadDueObservationTargets(
  input: { now?: Date; rowLimit?: number } = {},
  client?: SignalAdminClient,
): Promise<LoadObservationTargetsResult> {
  const now = input.now ?? new Date()
  const rowLimit = input.rowLimit ?? 1000
  if (!Number.isFinite(now.getTime())) return invalid('now must be a valid date.')
  if (!Number.isInteger(rowLimit) || rowLimit < 1 || rowLimit > 5000) {
    return invalid('rowLimit must be an integer between 1 and 5000.')
  }
  const operation = 'load_due_signal_observation_targets'
  try {
    const { data, error } = await admin(client)
      .from('signal_observation_schedule')
      .select(TARGET_COLUMNS)
      .eq('active', true)
      .lte('next_due_at', now.toISOString())
      .eq('signal_evidence.evidence_type', 'youtube_video')
      .order('next_due_at', { ascending: true })
      .limit(rowLimit)
    if (error) return databaseFailure(operation, error)
    if (!Array.isArray(data)) return { outcome: 'invalid_rpc_response', operation }
    const targets = data.map(parseTarget).filter((target): target is DueObservationTarget => target !== null)
    return { outcome: 'success', targets }
  } catch (error) {
    return databaseFailure(operation, error)
  }
}

export async function prepareObservationBatches(
  input: {
    runPhaseId: string
    now?: Date
    maxUniqueVideoIds?: number
    batchSize?: number
    rowLimit?: number
    maxAttempts?: number
    algorithmVersion?: number
  },
  client?: SignalAdminClient,
): Promise<PrepareObservationBatchesResult> {
  if (!isUuid(input.runPhaseId)) return invalid('runPhaseId must be a UUID.')
  const now = input.now ?? new Date()
  const loaded = await loadDueObservationTargets({ now, rowLimit: input.rowLimit }, client)
  if (loaded.outcome !== 'success') return loaded
  const plan = buildObservationBatchPlan(loaded.targets, {
    now,
    maxUniqueVideoIds: input.maxUniqueVideoIds,
    batchSize: input.batchSize,
  })
  if (!plan) return invalid('Observation batch plan options are invalid.')

  const batches: SignalCollectionBatchRow[] = []
  for (const itemIds of plan.batches) {
    const ensured = await ensureCollectionBatch({
      runPhaseId: input.runPhaseId,
      phase: 'observation',
      bucket: plan.quotaDate,
      provider: 'youtube',
      operation: 'youtube.videos.list',
      itemIds,
      algorithmVersion: input.algorithmVersion,
      maxAttempts: input.maxAttempts,
    }, client)
    if (ensured.outcome !== 'success') return ensured
    batches.push(ensured.batch)
  }
  return { outcome: 'success', plan, batches }
}

export async function loadObservationTargetsForVideoIds(
  input: { videoIds: string[]; dueAt?: Date },
  client?: SignalAdminClient,
): Promise<LoadObservationTargetsResult> {
  if (
    input.videoIds.length < 1 || input.videoIds.length > 50 ||
    new Set(input.videoIds).size !== input.videoIds.length ||
    input.videoIds.some(id => !/^[A-Za-z0-9_-]{1,100}$/.test(id))
  ) return invalid('videoIds must contain 1 to 50 unique URL-safe IDs.')
  const dueAt = input.dueAt ?? new Date()
  if (!Number.isFinite(dueAt.getTime())) return invalid('dueAt must be a valid date.')
  const operation = 'load_signal_observation_targets_for_batch'
  const db = admin(client)
  try {
    const filterValues = input.videoIds.join(',')
    const { data: evidenceRows, error: evidenceError } = await db
      .from('signal_evidence')
      .select('id,evidence_type,external_ref,youtube_videos_ref')
      .eq('evidence_type', 'youtube_video')
      .or(`youtube_videos_ref.in.(${filterValues}),external_ref.in.(${filterValues})`)
    if (evidenceError) return databaseFailure(operation, evidenceError)
    if (!Array.isArray(evidenceRows)) return { outcome: 'invalid_rpc_response', operation }

    const requested = new Set(input.videoIds)
    const evidenceToVideo = new Map<string, string>()
    for (const row of evidenceRows as Array<Record<string, unknown>>) {
      if (typeof row.id !== 'string' || !isUuid(row.id)) return { outcome: 'invalid_rpc_response', operation }
      const videoId = canonicalVideoId(row)
      if (videoId && requested.has(videoId)) evidenceToVideo.set(row.id, videoId)
    }
    if (evidenceToVideo.size === 0) return { outcome: 'success', targets: [] }

    const { data, error } = await db
      .from('signal_observation_schedule')
      .select('id,signal_evidence_id,cadence,next_due_at,last_observed_at,consecutive_stagnant_checks,consecutive_miss_checks,active')
      .in('signal_evidence_id', [...evidenceToVideo.keys()])
      .eq('active', true)
      .lte('next_due_at', dueAt.toISOString())
    if (error) return databaseFailure(operation, error)
    if (!Array.isArray(data)) return { outcome: 'invalid_rpc_response', operation }

    const targets: DueObservationTarget[] = []
    for (const row of data as Array<Record<string, unknown>>) {
      const evidenceId = typeof row.signal_evidence_id === 'string' ? row.signal_evidence_id : ''
      const videoId = evidenceToVideo.get(evidenceId)
      if (!videoId) continue
      const synthetic = parseTarget({ ...row, signal_evidence: {
        id: evidenceId, evidence_type: 'youtube_video', external_ref: videoId, youtube_videos_ref: videoId,
      } })
      if (!synthetic) return { outcome: 'invalid_rpc_response', operation }
      targets.push(synthetic)
    }
    return { outcome: 'success', targets }
  } catch (error) {
    return databaseFailure(operation, error)
  }
}

export function observationBucketStart(observedAt: Date, cadence: ObservationCadence): string | null {
  if (!Number.isFinite(observedAt.getTime())) return null
  const date = new Date(observedAt)
  if (cadence === 'early8h') date.setUTCHours(Math.floor(date.getUTCHours() / 8) * 8, 0, 0, 0)
  if (cadence === 'daily') date.setUTCHours(0, 0, 0, 0)
  if (cadence === 'weekly') {
    date.setUTCHours(0, 0, 0, 0)
    const daysSinceMonday = (date.getUTCDay() + 6) % 7
    date.setUTCDate(date.getUTCDate() - daysSinceMonday)
  }
  return date.toISOString()
}

export function nextObservationDueAt(observedAt: Date, cadence: ObservationCadence): string | null {
  const bucket = observationBucketStart(observedAt, cadence)
  if (!bucket) return null
  const next = new Date(bucket)
  next.setUTCHours(next.getUTCHours() + (cadence === 'early8h' ? 8 : cadence === 'daily' ? 24 : 24 * 7))
  return next.toISOString()
}
