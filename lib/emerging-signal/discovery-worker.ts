// One-seed discovery worker for the Premium Emerging Signal collector.
// The YouTube search provider is mandatory and injected. This module has no
// fetch, YouTube client, Serper client or AI client import/call site.

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
import { captureScheduledDiscovery, type ScheduledDiscoveryVideo } from './capture'
import {
  bindProviderReservationToBatch,
  commitProviderUnits,
  markProviderAttemptStarted,
  markProviderOutcomeUnknown,
  releaseProviderUnits,
  reserveProviderUnits,
} from './provider-budget'
import {
  loadDiscoverySeedByFingerprint,
  markDiscoverySeedFailure,
  markDiscoverySeedSuccess,
  type SignalSeedLanguage,
  type SignalSeedRegion,
  type SignalSeedRow,
} from './seed-selection'
import {
  isUuid,
  type OperationFailure,
  type SignalAdminClient,
} from './collection-types'

export interface DiscoverySearchRequest {
  query: string
  region: SignalSeedRegion
  language: SignalSeedLanguage
  maxResults: 25
}

export type DiscoveryProviderResult =
  | { outcome: 'success'; videos: ScheduledDiscoveryVideo[] }
  | { outcome: 'outcome_unknown'; errorClass: 'timeout' | 'connection_lost' | 'ambiguous_response' }
  | { outcome: 'quota_exhausted' }
  | { outcome: 'failure'; errorClass: 'provider_rejected' | 'invalid_response' }

export interface DiscoveryProvider {
  search(request: DiscoverySearchRequest): Promise<DiscoveryProviderResult>
}

export type DiscoveryWorkerResult =
  | { outcome: 'completed'; batch: SignalCollectionBatchRow; seed: SignalSeedRow; evidenceCount: number; scheduledCount: number }
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

function parseSearchVideos(videos: ScheduledDiscoveryVideo[]): ScheduledDiscoveryVideo[] | null {
  if (!Array.isArray(videos) || videos.length > 25) return null
  const ids = new Set<string>()
  const parsed: ScheduledDiscoveryVideo[] = []
  for (const video of videos) {
    if (
      !video || typeof video.videoId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(video.videoId) ||
      ids.has(video.videoId) || typeof video.title !== 'string' || !video.title.trim() || video.title.length > 500 ||
      typeof video.channelId !== 'string' || !video.channelId.trim() || video.channelId.length > 200 ||
      typeof video.channelTitle !== 'string' || !video.channelTitle.trim() || video.channelTitle.length > 500 ||
      typeof video.publishedAt !== 'string' || !Number.isFinite(Date.parse(video.publishedAt)) ||
      (video.description !== undefined && (typeof video.description !== 'string' || video.description.length > 5_000))
    ) return null
    ids.add(video.videoId)
    parsed.push({
      videoId: video.videoId,
      title: video.title.trim(),
      description: video.description?.trim(),
      channelId: video.channelId.trim(),
      channelTitle: video.channelTitle.trim(),
      publishedAt: new Date(video.publishedAt).toISOString(),
    })
  }
  return parsed
}

async function closeRetryOrFail(
  batch: SignalCollectionBatchRow,
  seed: SignalSeedRow | null,
  leaseOwner: string,
  errorClass: string,
  now: Date,
  client?: SignalAdminClient,
): Promise<DiscoveryWorkerResult> {
  if (batch.attempt < batch.max_attempts) {
    const retried = await retryCollectionBatch(batch.id, leaseOwner, 0, client)
    if (retried.outcome === 'success') return { outcome: 'retryable', batch: retried.batch, errorClass }
    return retried
  }
  const failed = await failCollectionBatch(batch.id, leaseOwner, errorClass, 0, client)
  if (failed.outcome !== 'success') return failed
  if (seed) {
    const seedResult = await markDiscoverySeedFailure(seed.id, now, client)
    if (seedResult.outcome !== 'success') return seedResult
  }
  return { outcome: 'failed', batch: failed.batch, errorClass }
}

export async function processDiscoveryBatch(
  input: {
    batchId: string
    runId: string
    leaseOwner: string
    provider: DiscoveryProvider
    leaseSeconds?: number
    now?: Date
  },
  client?: SignalAdminClient,
): Promise<DiscoveryWorkerResult> {
  if (!isUuid(input.batchId)) return invalid('batchId must be a UUID.')
  if (!isUuid(input.runId)) return invalid('runId must be a UUID.')
  if (!input.leaseOwner.trim() || input.leaseOwner.length > 200) return invalid('leaseOwner is required and must be at most 200 characters.')
  if (!input.provider || typeof input.provider.search !== 'function') return invalid('provider is required.')
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
  if (batch.batch_type !== 'discovery' || batch.item_ids.length !== 1) {
    return closeRetryOrFail(batch, null, input.leaseOwner, 'wrong_batch_shape', observedAt, client)
  }

  const seedResult = await loadDiscoverySeedByFingerprint(batch.item_ids[0], client)
  if (seedResult.outcome !== 'success') {
    const closed = await closeRetryOrFail(batch, null, input.leaseOwner, 'seed_load_failed', observedAt, client)
    return closed.outcome === 'retryable' || closed.outcome === 'failed' ? closed : seedResult
  }
  const seed = seedResult.seed
  if (!seed) return closeRetryOrFail(batch, null, input.leaseOwner, 'seed_missing_or_inactive', observedAt, client)

  const idempotencyKey = buildProviderReservationIdempotencyKey(batch.id, batch.attempt)
  if (!idempotencyKey) return closeRetryOrFail(batch, seed, input.leaseOwner, 'invalid_attempt_identity', observedAt, client)
  const reserved = await reserveProviderUnits({
    provider: 'youtube', usageScope: 'background', usageType: 'discovery_search',
    runId: input.runId, phase: 'discovery', idempotencyKey, units: 100,
    leaseSeconds: input.leaseSeconds ?? 120,
  }, client)
  if (reserved.outcome === 'budget_exhausted') {
    const failed = await failCollectionBatch(batch.id, input.leaseOwner, 'provider_budget_exhausted', 0, client)
    if (failed.outcome !== 'success') return failed
    const seedUpdated = await markDiscoverySeedFailure(seed.id, observedAt, client)
    return seedUpdated.outcome === 'success' ? { outcome: 'budget_exhausted', batch: failed.batch } : seedUpdated
  }
  if (reserved.outcome !== 'reserved') {
    const closed = await closeRetryOrFail(batch, seed, input.leaseOwner, 'reservation_failed', observedAt, client)
    return closed.outcome === 'retryable' || closed.outcome === 'failed' ? closed : reserved
  }
  const reservationId = reserved.reservationId

  const bound = await bindProviderReservationToBatch(reservationId, batch.id, input.leaseOwner, client)
  if (bound.outcome !== 'success') {
    await releaseProviderUnits(reservationId, client)
    const closed = await closeRetryOrFail(batch, seed, input.leaseOwner, 'reservation_bind_failed', observedAt, client)
    return closed.outcome === 'retryable' || closed.outcome === 'failed' ? closed : bound
  }
  const started = await markProviderAttemptStarted(reservationId, client)
  if (started.outcome !== 'success') {
    await releaseProviderUnits(reservationId, client)
    const closed = await closeRetryOrFail(batch, seed, input.leaseOwner, 'attempt_start_failed', observedAt, client)
    return closed.outcome === 'retryable' || closed.outcome === 'failed' ? closed : started
  }

  let providerResult: unknown
  try {
    providerResult = await input.provider.search({
      query: seed.seed_text,
      region: seed.region,
      language: seed.language,
      maxResults: 25,
    })
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
    if (unknown.outcome !== 'success') return unknown
    if (batch.attempt >= batch.max_attempts) {
      const seedUpdated = await markDiscoverySeedFailure(seed.id, observedAt, client)
      if (seedUpdated.outcome !== 'success') return seedUpdated
    }
    return { outcome: 'outcome_unknown', batch: unknown.batch, errorClass }
  }

  if (
    providerResult && typeof providerResult === 'object' &&
    (providerResult as { outcome?: unknown }).outcome === 'quota_exhausted'
  ) {
    const committed = await commitProviderUnits(reservationId, 100, client)
    if (committed.outcome !== 'success') return committed
    const failed = await failCollectionBatch(batch.id, input.leaseOwner, 'provider_quota_exhausted', 0, client)
    if (failed.outcome !== 'success') return failed
    const seedUpdated = await markDiscoverySeedFailure(seed.id, observedAt, client)
    return seedUpdated.outcome === 'success'
      ? { outcome: 'provider_quota_exhausted', batch: failed.batch }
      : seedUpdated
  }

  if (
    providerResult && typeof providerResult === 'object' &&
    (providerResult as { outcome?: unknown }).outcome === 'failure' &&
    ['provider_rejected', 'invalid_response'].includes(String((providerResult as { errorClass?: unknown }).errorClass))
  ) {
    const committed = await commitProviderUnits(reservationId, 100, client)
    if (committed.outcome !== 'success') return committed
    return closeRetryOrFail(
      batch, seed, input.leaseOwner,
      String((providerResult as { errorClass: unknown }).errorClass), observedAt, client,
    )
  }

  // A successful provider response consumed the exact search.list cost even
  // if its payload later proves invalid or a local capture write fails.
  const videos = providerResult && typeof providerResult === 'object' &&
    (providerResult as { outcome?: unknown }).outcome === 'success'
    ? (providerResult as { videos?: unknown }).videos
    : null
  const parsedVideos = Array.isArray(videos) ? parseSearchVideos(videos as ScheduledDiscoveryVideo[]) : null
  const committed = await commitProviderUnits(reservationId, 100, client)
  if (committed.outcome !== 'success') return committed
  if (!parsedVideos) return closeRetryOrFail(batch, seed, input.leaseOwner, 'invalid_provider_response', observedAt, client)

  const captured = await captureScheduledDiscovery({
    runId: input.runId,
    seedFingerprint: seed.seed_fingerprint,
    seedText: seed.seed_text,
    category: seed.category,
    videos: parsedVideos,
    observedAt,
  }, admin(client))
  if (captured.outcome !== 'success') {
    const closed = await closeRetryOrFail(batch, seed, input.leaseOwner, 'discovery_capture_failed', observedAt, client)
    return closed.outcome === 'retryable' || closed.outcome === 'failed' ? closed : captured
  }

  const seedUpdated = await markDiscoverySeedSuccess(seed.id, observedAt, client)
  if (seedUpdated.outcome !== 'success') {
    const closed = await closeRetryOrFail(batch, seed, input.leaseOwner, 'seed_update_failed', observedAt, client)
    return closed.outcome === 'retryable' || closed.outcome === 'failed' ? closed : seedUpdated
  }
  const completed = await completeCollectionBatch(batch.id, input.leaseOwner, client)
  if (completed.outcome !== 'success') return completed
  return {
    outcome: 'completed',
    batch: completed.batch,
    seed,
    evidenceCount: captured.evidenceCount,
    scheduledCount: captured.scheduledCount,
  }
}
