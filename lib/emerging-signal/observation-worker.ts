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
  nextObservationDueAt,
  observationBucketStart,
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

export interface ObservationProvider {
  fetchVideoStats(videoIds: readonly string[]): Promise<ObservationProviderResult>
}

export type ObservationWorkerResult =
  | { outcome: 'completed'; batch: SignalCollectionBatchRow; observedVideoCount: number; missingVideoCount: number; observationCount: number }
  | { outcome: 'no_targets'; batch: SignalCollectionBatchRow }
  | { outcome: 'budget_exhausted'; batch: SignalCollectionBatchRow | null }
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

async function persistObservationResults(
  input: {
    targets: DueObservationTarget[]
    videosById: Map<string, ObservationVideoStats>
    runId: string
    observedAt: Date
  },
  client?: SignalAdminClient,
): Promise<{ outcome: 'success'; observationCount: number } | OperationFailure> {
  const operation = 'persist_signal_observation_batch'
  const db = admin(client)
  const observedAt = input.observedAt.toISOString()
  const observationRows: Array<Record<string, unknown>> = []
  const scheduleRows: Array<Record<string, unknown>> = []

  for (const target of input.targets) {
    const video = input.videosById.get(target.videoId)
    const bucketStart = observationBucketStart(input.observedAt, target.cadence)
    const nextDueAt = nextObservationDueAt(input.observedAt, target.cadence)
    if (!bucketStart || !nextDueAt) return invalid('Unable to compute observation cadence boundaries.')
    if (video) {
      const metrics: Array<[string, number | undefined]> = [
        ['youtube_view_count', video.viewCount],
        ['youtube_like_count', video.likeCount],
        ['youtube_comment_count', video.commentCount],
      ]
      for (const [metricType, metricValue] of metrics) {
        if (metricValue !== undefined) observationRows.push({
          signal_evidence_id: target.evidenceId,
          signal_run_id: input.runId,
          metric_type: metricType,
          metric_value: metricValue,
          cadence: target.cadence,
          bucket_start: bucketStart,
          observed_at: observedAt,
        })
      }
    }
    scheduleRows.push({
      id: target.scheduleId,
      signal_evidence_id: target.evidenceId,
      cadence: target.cadence,
      next_due_at: nextDueAt,
      last_observed_at: video ? observedAt : target.lastObservedAt,
      consecutive_stagnant_checks: target.consecutiveStagnantChecks,
      consecutive_miss_checks: video ? 0 : target.consecutiveMissChecks + 1,
      active: true,
      updated_at: observedAt,
    })
  }

  try {
    if (observationRows.length > 0) {
      const { error } = await db.from('signal_observations').upsert(observationRows, {
        onConflict: 'signal_evidence_id,metric_type,cadence,bucket_start',
      })
      if (error) return databaseFailure(operation, error)
    }
    if (scheduleRows.length > 0) {
      const { error } = await db.from('signal_observation_schedule').upsert(scheduleRows, { onConflict: 'id' })
      if (error) return databaseFailure(operation, error)
    }
    return { outcome: 'success', observationCount: observationRows.length }
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

  let providerResult: ObservationProviderResult
  try {
    providerResult = await input.provider.fetchVideoStats(batch.item_ids)
  } catch {
    providerResult = { outcome: 'outcome_unknown', errorClass: 'connection_lost' }
  }
  if (providerResult.outcome === 'outcome_unknown') {
    const settled = await markProviderOutcomeUnknown(reservationId, client)
    if (settled.outcome !== 'success') return settled
    const unknown = await markCollectionBatchOutcomeUnknown(batch.id, input.leaseOwner, 0, client)
    return unknown.outcome === 'success'
      ? { outcome: 'outcome_unknown', batch: unknown.batch, errorClass: providerResult.errorClass }
      : unknown
  }

  const parsed = parseProviderVideos(providerResult.videos, batch.item_ids)
  const committed = await commitProviderUnits(reservationId, 1, client)
  if (committed.outcome !== 'success') return committed
  if (!parsed.ok) return closeRetryOrFail(batch, input.leaseOwner, 'invalid_provider_response', client)

  const persisted = await persistObservationResults({
    targets: targetsResult.targets,
    videosById: parsed.byId,
    runId: input.runId,
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
