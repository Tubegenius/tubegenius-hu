// Premium Emerging Signal cron orchestration. The function is dependency-
// injectable so auth/deadline/quota behavior is testable without external
// calls. Default dependencies use the real DB state machines and injected
// YouTube-only providers supplied by the route.

import { randomUUID } from 'node:crypto'
import {
  claimScheduledSignalRun,
  claimRunPhase,
  completeRunPhase,
  ensureRunPhases,
  failRunPhase,
  finalizeScheduledSignalRun,
  getCollectionControlState,
  partiallyCompleteRunPhase,
  releaseScheduledSignalRunClaim,
  retryRunPhase,
  skipRunPhase,
  type SignalRunPhaseRow,
} from './run-phases'
import { prepareObservationBatches, pacificQuotaDate } from './observation-schedule'
import { prepareDiscoveryBatches } from './seed-selection'
import { processObservationBatch, type ObservationProvider } from './observation-worker'
import { processDiscoveryBatch, type DiscoveryProvider } from './discovery-worker'
import type { SignalAdminClient, SignalCollectionPhase } from './collection-types'

export interface SignalCollectorProviders {
  observation: ObservationProvider
  discovery: DiscoveryProvider
}

export interface SignalCollectorPhaseSummary {
  phase: SignalCollectionPhase
  status: 'completed' | 'partially_completed' | 'skipped' | 'not_claimed'
  batchesPrepared: number
  batchesProcessed: number
  batchesCompleted: number
  budgetExhausted: boolean
  providerQuotaExhausted: boolean
}

export type SignalCollectorResult =
  | { outcome: 'skipped'; reason: 'disabled' | 'control_unavailable' | 'run_active' | 'run_terminal' }
  | { outcome: 'completed' | 'partially_completed'; runId: string; phases: SignalCollectorPhaseSummary[]; deadlineReached: boolean; providerQuotaExhausted: boolean }
  | { outcome: 'failed'; stage: string; runId: string | null }

export interface SignalCollectorDependencies {
  getControl: typeof getCollectionControlState
  claimRun: typeof claimScheduledSignalRun
  ensurePhases: typeof ensureRunPhases
  claimPhase: typeof claimRunPhase
  completePhase: typeof completeRunPhase
  partiallyCompletePhase: typeof partiallyCompleteRunPhase
  failPhase: typeof failRunPhase
  retryPhase: typeof retryRunPhase
  skipPhase: typeof skipRunPhase
  prepareObservation: typeof prepareObservationBatches
  prepareDiscovery: typeof prepareDiscoveryBatches
  processObservation: typeof processObservationBatch
  processDiscovery: typeof processDiscoveryBatch
  finalizeRun: typeof finalizeScheduledSignalRun
  releaseRun: typeof releaseScheduledSignalRunClaim
}

const DEFAULT_DEPENDENCIES: SignalCollectorDependencies = {
  getControl: getCollectionControlState,
  claimRun: claimScheduledSignalRun,
  ensurePhases: ensureRunPhases,
  claimPhase: claimRunPhase,
  completePhase: completeRunPhase,
  partiallyCompletePhase: partiallyCompleteRunPhase,
  failPhase: failRunPhase,
  retryPhase: retryRunPhase,
  skipPhase: skipRunPhase,
  prepareObservation: prepareObservationBatches,
  prepareDiscovery: prepareDiscoveryBatches,
  processObservation: processObservationBatch,
  processDiscovery: processDiscoveryBatch,
  finalizeRun: finalizeScheduledSignalRun,
  releaseRun: releaseScheduledSignalRunClaim,
}

function isSuccessfulBatchOutcome(outcome: string): boolean {
  return outcome === 'completed' || outcome === 'no_targets'
}

export async function runSignalCollector(
  input: {
    providers: SignalCollectorProviders
    invocationId?: string
    now?: Date
    softDeadlineMs?: number
    minimumRemainingMs?: number
    clock?: () => number
    client?: SignalAdminClient
    providerConfigured?: boolean
  },
  dependencies: SignalCollectorDependencies = DEFAULT_DEPENDENCIES,
): Promise<SignalCollectorResult> {
  const wallStart = input.now ?? new Date()
  if (!Number.isFinite(wallStart.getTime())) return { outcome: 'failed', stage: 'invalid_start_time', runId: null }
  const softDeadlineMs = input.softDeadlineMs ?? 240_000
  const minimumRemainingMs = input.minimumRemainingMs ?? 20_000
  if (!Number.isInteger(softDeadlineMs) || softDeadlineMs < 1_000 || softDeadlineMs > 240_000) {
    return { outcome: 'failed', stage: 'invalid_deadline', runId: null }
  }
  if (!Number.isInteger(minimumRemainingMs) || minimumRemainingMs < 0 || minimumRemainingMs >= softDeadlineMs) {
    return { outcome: 'failed', stage: 'invalid_deadline_guard', runId: null }
  }
  const clock = input.clock ?? Date.now
  const monotonicStart = clock()
  const deadlineAt = monotonicStart + softDeadlineMs
  const currentDate = () => new Date(wallStart.getTime() + Math.max(0, clock() - monotonicStart))
  const nearDeadline = () => deadlineAt - clock() <= minimumRemainingMs
  const client = input.client

  // Defense-in-depth: every caller, not only the HTTP route, is gated by the
  // single-row DB kill switch. Missing row and DB/shape errors fail closed.
  const control = await dependencies.getControl(client)
  if (control.outcome !== 'success') return { outcome: 'skipped', reason: 'control_unavailable' }
  if (!control.enabled) return { outcome: 'skipped', reason: 'disabled' }
  if (input.providerConfigured === false) return { outcome: 'failed', stage: 'provider_not_configured', runId: null }

  const quotaDate = pacificQuotaDate(wallStart)
  if (!quotaDate) return { outcome: 'failed', stage: 'quota_date', runId: null }
  const invocationId = (input.invocationId?.trim() || randomUUID()).slice(0, 120)
  const leaseOwner = `signal-collector:${invocationId}`
  const runClaim = await dependencies.claimRun({
    idempotencyKey: `scheduled-enrichment:${quotaDate}`,
    leaseSeconds: 270,
    now: currentDate(),
  }, client)
  if (runClaim.outcome === 'not_claimable') {
    return { outcome: 'skipped', reason: runClaim.reason === 'terminal' ? 'run_terminal' : 'run_active' }
  }
  if (runClaim.outcome !== 'claimed') return { outcome: 'failed', stage: 'run_claim', runId: null }
  const runId = runClaim.run.id

  const failAndRelease = async (stage: string): Promise<SignalCollectorResult> => {
    await dependencies.releaseRun(runId, runClaim.claimExpiresAt, client)
    return { outcome: 'failed', stage, runId }
  }

  const phasesResult = await dependencies.ensurePhases(runId, client)
  if (phasesResult.outcome !== 'success') return failAndRelease('ensure_phases')
  const ordered = (['observation', 'discovery'] as const)
    .map(phase => phasesResult.phases.find(row => row.phase === phase))
  if (ordered.some(phase => !phase)) return failAndRelease('phase_shape')

  const summaries: SignalCollectorPhaseSummary[] = []
  let deadlineReached = false
  let providerQuotaExhausted = false

  for (const phaseRow of ordered as SignalRunPhaseRow[]) {
    const phase = phaseRow.phase
    const emptySummary: SignalCollectorPhaseSummary = {
      phase, status: 'not_claimed', batchesPrepared: 0, batchesProcessed: 0,
      batchesCompleted: 0, budgetExhausted: false, providerQuotaExhausted: false,
    }
    const claimed = await dependencies.claimPhase({
      phaseId: phaseRow.id,
      leaseOwner,
      leaseSeconds: 260,
      now: currentDate(),
    }, client)
    if (claimed.outcome === 'not_claimable') {
      if (claimed.reason === 'terminal') {
        const status = phaseRow.status === 'completed' ? 'completed'
          : phaseRow.status === 'skipped' ? 'skipped'
            : 'partially_completed'
        summaries.push({ ...emptySummary, status })
      } else {
        summaries.push(emptySummary)
      }
      continue
    }
    if (claimed.outcome !== 'claimed') return failAndRelease(`claim_${phase}`)

    if (providerQuotaExhausted) {
      const skipped = await dependencies.skipPhase(phaseRow.id, leaseOwner, client)
      if (skipped.outcome !== 'success') return failAndRelease(`skip_${phase}`)
      summaries.push({ ...emptySummary, status: 'skipped', providerQuotaExhausted: true })
      continue
    }
    if (nearDeadline()) {
      deadlineReached = true
      const partial = await dependencies.partiallyCompletePhase(phaseRow.id, leaseOwner, client)
      if (partial.outcome !== 'success') return failAndRelease(`deadline_${phase}`)
      summaries.push({ ...emptySummary, status: 'partially_completed' })
      continue
    }

    const prepared = phase === 'observation'
      ? await dependencies.prepareObservation({
        runPhaseId: phaseRow.id, now: currentDate(), maxUniqueVideoIds: 200,
        batchSize: 50, maxAttempts: 2,
      }, client)
      : await dependencies.prepareDiscovery({
        runPhaseId: phaseRow.id, now: currentDate(), limit: 3, maxAttempts: 2,
      }, client)
    if (prepared.outcome !== 'success') {
      const transitioned = claimed.phase.attempt < claimed.phase.max_attempts
        ? await dependencies.retryPhase(phaseRow.id, leaseOwner, client)
        : await dependencies.failPhase(phaseRow.id, leaseOwner, client)
      if (transitioned.outcome !== 'success') return failAndRelease(`prepare_${phase}`)
      return failAndRelease(`prepare_${phase}`)
    }

    const batches = prepared.batches
    let processed = 0
    let completed = 0
    let phaseBudgetExhausted = false
    let phaseHadNonSuccess = false
    for (const batch of batches) {
      if (nearDeadline()) {
        deadlineReached = true
        phaseHadNonSuccess = true
        break
      }
      const result = phase === 'observation'
        ? await dependencies.processObservation({
          batchId: batch.id, runId, leaseOwner: `${leaseOwner}:observation:${batch.id}`,
          provider: input.providers.observation, leaseSeconds: 90, now: currentDate(),
        }, client)
        : await dependencies.processDiscovery({
          batchId: batch.id, runId, leaseOwner: `${leaseOwner}:discovery:${batch.id}`,
          provider: input.providers.discovery, leaseSeconds: 90, now: currentDate(),
        }, client)
      processed++
      if (isSuccessfulBatchOutcome(result.outcome)) completed++
      else phaseHadNonSuccess = true
      if (result.outcome === 'budget_exhausted') {
        phaseBudgetExhausted = true
        break
      }
      if (result.outcome === 'provider_quota_exhausted') {
        providerQuotaExhausted = true
        break
      }
    }

    const partial = deadlineReached || phaseBudgetExhausted || providerQuotaExhausted ||
      phaseHadNonSuccess || processed < batches.length
    const transitioned = partial
      ? await dependencies.partiallyCompletePhase(phaseRow.id, leaseOwner, client)
      : await dependencies.completePhase(phaseRow.id, leaseOwner, client)
    if (transitioned.outcome !== 'success') return failAndRelease(`finalize_${phase}`)
    summaries.push({
      phase,
      status: partial ? 'partially_completed' : 'completed',
      batchesPrepared: batches.length,
      batchesProcessed: processed,
      batchesCompleted: completed,
      budgetExhausted: phaseBudgetExhausted,
      providerQuotaExhausted,
    })
  }

  const finalized = await dependencies.finalizeRun({
    runId,
    claimExpiresAt: runClaim.claimExpiresAt,
    status: 'completed',
    now: currentDate(),
  }, client)
  if (finalized.outcome !== 'success') return { outcome: 'failed', stage: 'finalize_run', runId }
  const partial = deadlineReached || providerQuotaExhausted ||
    summaries.some(summary => summary.status !== 'completed')
  return {
    outcome: partial ? 'partially_completed' : 'completed',
    runId,
    phases: summaries,
    deadlineReached,
    providerQuotaExhausted,
  }
}
