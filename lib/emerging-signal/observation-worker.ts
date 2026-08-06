// One-batch observation worker for the Premium Emerging Signal collector.
// The provider is mandatory and injected: tests can prove every state change
// with a mock, while this module itself has zero implicit external calls.

import { createAdminClient } from '@/lib/supabase-server'
import {
  buildProviderReservationIdempotencyKey,
  claimCollectionBatch,
  completeCollectionBatch,
  failCollectionBatch,
  markCollectionBatchOutcomeUnknown,
  retryCollectionBatch,
  type SignalCollectionBatchRow,
} from './batches'
import {
  bindProviderReservationToBatch,
  commitProviderUnits,
  markProviderAttemptStarted,
  markProviderOutcomeUnknown,
  releaseProviderUnits,
  reserveProviderUnits,
} from './provider-budget'
import {
  loadObservationTargetsForVideoIds,
  type DueObservationTarget,
} from './observation-schedule'
import {
  isUuid,
  toSignalDatabaseError,
  type OperationFailure,
  type SignalAdminClient,
} from './collection-types'

export interface ObservationVideoStats {
  videoId: string
  viewCount: number
  likeCount?: number
  commentCount?: number
}

export type ObservationProviderResult =
  | { outcome: 'success'; videos: ObservationVideoStats[] }
  | { outcome: 'outcome_unknown'; errorClass: 'timeout' | 'connection_lost' | 'ambiguous_response' }
  | { outcome: 'quota_exhausted' }
  | { outcome: 'failure'; errorClass: 'provider_rejected' | 'invalid_response' }

export interface ObservationProvider {
  fetchVideoStats(videoIds: readonly string[]): Promise<ObservationProviderResult>
}

export type ObservationWorkerResult =
  | { outcome: 'completed'; batch: SignalCollectionBatchRow; observedVideoCount: number; missingVideoCount: number; observationCount: number }
  | { outcome: 'no_targets'; batch: SignalCollectionBatchRow }
  | { outcome: 'budget_exhausted'; batch: SignalCollectionBatchRow | null }
  | { outcome: 'provider_quota_exhausted'; batch: SignalCollectionBatchRow }
  | { outcome: 'outcome_unknown'; batch: SignalCollectionBatchRow; errorClass: string }
  | { outcome: 'not_claimed'; reason: 'missing' | 'terminal' | 'lease_active' | 'attempts_exhausted' | 'race_lost' }
  | { outcome: 'not_applied'; reason: 'missing' | 'attempts_exhausted' | 'race_lost' }
  | { outcome: 'retryable' | 'failed'; batch: SignalCollectionBatchRow; errorClass: string }
  | OperationFailure

function admin(client?: SignalAdminClient): SignalAdminClient {
  return client ?? createAdminClient()
}

function invalid(message: string): Extract<OperationFailure, { outcome: 'invalid_request' }> {
  return { outcome: 'invalid_request', message }
}

function databaseFailure(operation: string, error: unknown): OperationFailure {
  return { outcome: 'database_error', operation, error: toSignalDatabaseError(error) }
}

function validCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function parseProviderVideos(
  videos: ObservationVideoStats[],
  requestedIds: string[],
): { ok: true; byId: Map<string, ObservationVideoStats> } | { ok: false } {
  if (!Array.isArray(videos)) return { ok: false }
  const requested = new Set(requestedIds)
  const byId = new Map<string, ObservationVideoStats>()
  for (const video of videos) {
    if (
      !video || typeof video.videoId !== 'string' || !requested.has(video.videoId) || byId.has(video.videoId) ||
      !validCount(video.viewCount) ||
      (video.likeCount !== undefined && !validCount(video.likeCount)) ||
      (video.commentCount !== undefined && !validCount(video.commentCount))
    ) return { ok: false }
    byId.set(video.videoId, video)
  }
  return { ok: true, byId }
}

async function closeRetryOrFail(
  batch: SignalCollectionBatchRow,
  leaseOwner: string,
  errorClass: string,
  client?: SignalAdminClient,
): Promise<ObservationWorkerResult> {
  if (batch.attempt < batch.max_attempts) {
    const retried = await retryCollectionBatch(batch.id, leaseOwner, 0, client)
    if (retried.outcome === 'success') return { outcome: 'retryable', batch: retried.batch, errorClass }
    return retried
  }
  const failed = await failCollectionBatch(batch.id, leaseOwner, errorClass, 0, client)
  if (failed.outcome === 'success') return { outcome: 'failed', batch: failed.batch, errorClass }
  return failed
}

interface ObservationBatchRpcRow {
  schedule_id: string
  new_cadence: string
  new_active: boolean
  observation_rows_written: number
}

// Egyetlen SECURITY DEFINER RPC-hivas (066) — az observation-sorok es a
// schedule-atmenet (cadence/stagnant/miss/active/next_due_at, a teljes
// allapotgep szerint) EGY DB-tranzakcioban irodik. Nincs evidence-enkenti
// kulon RPC-hivas: a teljes batch (legfeljebb 50 egyedi videoId, a fan-
// out miatt tobb evidence-sor is lehet) egyetlen JSONB tombkent megy at.
async function persistObservationResults(
  input: {
    targets: DueObservationTarget[]
    videosById: Map<string, ObservationVideoStats>
    runId: string
    batchId: string
    leaseOwner: string
    observedAt: Date
  },
  client?: SignalAdminClient,
): Promise<{ outcome: 'success'; observationCount: number } | OperationFailure> {
  const operation = 'apply_signal_observation_batch'
  const db = admin(client)
  const observedAt = input.observedAt.toISOString()

  const results = input.targets.map(target => {
    const video = input.videosById.get(target.videoId)
    return {
      schedule_id: target.scheduleId,
      evidence_id: target.evidenceId,
      video_id: target.videoId,
      found: Boolean(video),
      view_count: video ? video.viewCount : null,
      like_count: video?.likeCount ?? null,
      comment_count: video?.commentCount ?? null,
    }
  })

  try {
    const { data, error } = await db.rpc(operation, {
      p_run_id: input.runId,
      p_batch_id: input.batchId,
      p_lease_owner: input.leaseOwner,
      p_observed_at: observedAt,
      p_results: results,
    })
    if (error) return databaseFailure(operation, error)
    if (!Array.isArray(data)) return { outcome: 'invalid_rpc_response', operation }
    let observationCount = 0
    for (const row of data as ObservationBatchRpcRow[]) {
      if (
        typeof row.schedule_id !== 'string' || !isUuid(row.schedule_id) ||
        !['daily', 'weekly', 'early8h'].includes(row.new_cadence) ||
        typeof row.new_active !== 'boolean' ||
        !Number.isInteger(row.observation_rows_written) || row.observation_rows_written < 0
      ) return { outcome: 'invalid_rpc_response', operation }
      observationCount += row.observation_rows_written
    }
    if (data.length !== input.targets.length) return { outcome: 'invalid_rpc_response', operation }
    return { outcome: 'success', observationCount }
  } catch (error) {
    return databaseFailure(operation, error)
  }
}

export async function processObservationBatch(
  input: {
    batchId: string
    runId: string
    leaseOwner: string
    provider: ObservationProvider
    leaseSeconds?: number
    now?: Date
  },
  client?: SignalAdminClient,
): Promise<ObservationWorkerResult> {
  if (!isUuid(input.batchId)) return invalid('batchId must be a UUID.')
  if (!isUuid(input.runId)) return invalid('runId must be a UUID.')
  if (!input.leaseOwner.trim() || input.leaseOwner.length > 200) return invalid('leaseOwner is required and must be at most 200 characters.')
  if (!input.provider || typeof input.provider.fetchVideoStats !== 'function') return invalid('provider is required.')
  const observedAt = input.now ?? new Date()
  if (!Number.isFinite(observedAt.getTime())) return invalid('now must be a valid date.')

  const claimed = await claimCollectionBatch({
    batchId: input.batchId,
    leaseOwner: input.leaseOwner,
    leaseSeconds: input.leaseSeconds ?? 120,
    now: observedAt,
  }, client)
  if (claimed.outcome === 'not_claimable') return { outcome: 'not_claimed', reason: claimed.reason }
  if (claimed.outcome !== 'claimed') return claimed
  const batch = claimed.batch
  if (batch.batch_type !== 'observation') return closeRetryOrFail(batch, input.leaseOwner, 'wrong_batch_type', client)

  const targetsResult = await loadObservationTargetsForVideoIds({ videoIds: batch.item_ids, dueAt: observedAt }, client)
  if (targetsResult.outcome !== 'success') {
    const closed = await closeRetryOrFail(batch, input.leaseOwner, 'target_load_failed', client)
    return closed.outcome === 'retryable' || closed.outcome === 'failed' ? closed : targetsResult
  }
  if (targetsResult.targets.length === 0) {
    const completed = await completeCollectionBatch(batch.id, input.leaseOwner, client)
    return completed.outcome === 'success' ? { outcome: 'no_targets', batch: completed.batch } : completed
  }

  const idempotencyKey = buildProviderReservationIdempotencyKey(batch.id, batch.attempt)
  if (!idempotencyKey) return closeRetryOrFail(batch, input.leaseOwner, 'invalid_attempt_identity', client)
  const reserved = await reserveProviderUnits({
    provider: 'youtube', usageScope: 'background', usageType: 'observation_stats',
    runId: input.runId, phase: 'observation', idempotencyKey, units: 1,
    leaseSeconds: input.leaseSeconds ?? 120,
  }, client)
  if (reserved.outcome === 'budget_exhausted') {
    const failed = await failCollectionBatch(batch.id, input.leaseOwner, 'provider_budget_exhausted', 0, client)
    return failed.outcome === 'success' ? { outcome: 'budget_exhausted', batch: failed.batch } : failed
  }
  if (reserved.outcome !== 'reserved') {
    const closed = await closeRetryOrFail(batch, input.leaseOwner, 'reservation_failed', client)
    return closed.outcome === 'retryable' || closed.outcome === 'failed' ? closed : reserved
  }
  const reservationId = reserved.reservationId

  const bound = await bindProviderReservationToBatch(reservationId, batch.id, input.leaseOwner, client)
  if (bound.outcome !== 'success') {
    await releaseProviderUnits(reservationId, client)
    const closed = await closeRetryOrFail(batch, input.leaseOwner, 'reservation_bind_failed', client)
    return closed.outcome === 'retryable' || closed.outcome === 'failed' ? closed : bound
  }
  const started = await markProviderAttemptStarted(reservationId, client)
  if (started.outcome !== 'success') {
    await releaseProviderUnits(reservationId, client)
    const closed = await closeRetryOrFail(batch, input.leaseOwner, 'attempt_start_failed', client)
    return closed.outcome === 'retryable' || closed.outcome === 'failed' ? closed : started
  }

  let providerResult: unknown
  try {
    providerResult = await input.provider.fetchVideoStats(batch.item_ids)
  } catch {
    providerResult = { outcome: 'outcome_unknown', errorClass: 'connection_lost' }
  }
  if (
    providerResult && typeof providerResult === 'object' &&
    (providerResult as { outcome?: unknown }).outcome === 'outcome_unknown' &&
    ['timeout', 'connection_lost', 'ambiguous_response'].includes(
      String((providerResult as { errorClass?: unknown }).errorClass),
    )
  ) {
    const errorClass = String((providerResult as { errorClass: unknown }).errorClass)
    const settled = await markProviderOutcomeUnknown(reservationId, client)
    if (settled.outcome !== 'success') return settled
    const unknown = await markCollectionBatchOutcomeUnknown(batch.id, input.leaseOwner, 0, client)
    return unknown.outcome === 'success'
      ? { outcome: 'outcome_unknown', batch: unknown.batch, errorClass }
      : unknown
  }


  if (
    providerResult && typeof providerResult === 'object' &&
    (providerResult as { outcome?: unknown }).outcome === 'quota_exhausted'
  ) {
    const committed = await commitProviderUnits(reservationId, 1, client)
    if (committed.outcome !== 'success') return committed
    const failed = await failCollectionBatch(batch.id, input.leaseOwner, 'provider_quota_exhausted', 0, client)
    return failed.outcome === 'success' ? { outcome: 'provider_quota_exhausted', batch: failed.batch } : failed
  }

  if (
    providerResult && typeof providerResult === 'object' &&
    (providerResult as { outcome?: unknown }).outcome === 'failure' &&
    ['provider_rejected', 'invalid_response'].includes(String((providerResult as { errorClass?: unknown }).errorClass))
  ) {
    const committed = await commitProviderUnits(reservationId, 1, client)
    if (committed.outcome !== 'success') return committed
    return closeRetryOrFail(batch, input.leaseOwner, String((providerResult as { errorClass: unknown }).errorClass), client)
  }

  const videos = providerResult && typeof providerResult === 'object' &&
    (providerResult as { outcome?: unknown }).outcome === 'success'
    ? (providerResult as { videos?: unknown }).videos
    : null
  const parsed = parseProviderVideos(Array.isArray(videos) ? videos as ObservationVideoStats[] : [], batch.item_ids)
  const committed = await commitProviderUnits(reservationId, 1, client)
  if (committed.outcome !== 'success') return committed
  if (!Array.isArray(videos) || !parsed.ok) return closeRetryOrFail(batch, input.leaseOwner, 'invalid_provider_response', client)

  const persisted = await persistObservationResults({
    targets: targetsResult.targets,
    videosById: parsed.byId,
    runId: input.runId,
    batchId: batch.id,
    leaseOwner: input.leaseOwner,
    observedAt,
  }, client)
  if (persisted.outcome !== 'success') {
    const closed = await closeRetryOrFail(batch, input.leaseOwner, 'observation_persist_failed', client)
    return closed.outcome === 'retryable' || closed.outcome === 'failed' ? closed : persisted
  }
  const completed = await completeCollectionBatch(batch.id, input.leaseOwner, client)
  if (completed.outcome !== 'success') return completed
  const observedVideoCount = new Set(targetsResult.targets.filter(target => parsed.byId.has(target.videoId)).map(target => target.videoId)).size
  const targetVideoCount = new Set(targetsResult.targets.map(target => target.videoId)).size
  return {
    outcome: 'completed',
    batch: completed.batch,
    observedVideoCount,
    missingVideoCount: targetVideoCount - observedVideoCount,
    observationCount: persisted.observationCount,
  }
}
