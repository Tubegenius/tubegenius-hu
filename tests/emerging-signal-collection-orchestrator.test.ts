import { describe, expect, it, vi } from 'vitest'
import { runSignalCollector, type SignalCollectorDependencies } from '@/lib/emerging-signal/collection-orchestrator'
import type { SignalRunPhaseRow } from '@/lib/emerging-signal/run-phases'

const RUN_ID = '61000000-0000-4000-8000-000000000001'
const OBSERVATION_ID = '61000000-0000-4000-8000-000000000002'
const DISCOVERY_ID = '61000000-0000-4000-8000-000000000003'
const CLAIM_EXPIRES = '2026-08-04T12:04:30.000Z'

function phase(id: string, name: 'observation' | 'discovery'): SignalRunPhaseRow {
  return {
    id, run_id: RUN_ID, phase: name, status: 'pending', attempt: 0, max_attempts: 2,
    lease_owner: null, lease_acquired_at: null, lease_expires_at: null,
    started_at: null, completed_at: null, created_at: '2026-08-04T12:00:00.000Z',
  }
}

function dependencies() {
  const observation = phase(OBSERVATION_ID, 'observation')
  const discovery = phase(DISCOVERY_ID, 'discovery')
  return {
    getControl: vi.fn(async () => ({ outcome: 'success', enabled: true, updatedAt: '2026-08-04T00:00:00Z', updatedBy: null })),
    claimRun: vi.fn(async () => ({
      outcome: 'claimed', created: true, claimExpiresAt: CLAIM_EXPIRES,
      run: { id: RUN_ID, idempotency_key: 'scheduled', status: 'started', started_at: '2026-08-04T12:00:00Z', completed_at: null, external_calls_made: 0, error_class: null, run_claim_expires_at: CLAIM_EXPIRES },
    })),
    ensurePhases: vi.fn(async () => ({ outcome: 'success', phases: [observation, discovery] })),
    claimPhase: vi.fn(async ({ phaseId }: { phaseId: string }) => ({
      outcome: 'claimed', phase: phaseId === OBSERVATION_ID ? { ...observation, status: 'in_progress', attempt: 1 } : { ...discovery, status: 'in_progress', attempt: 1 },
    })),
    completePhase: vi.fn(async () => ({ outcome: 'success' })),
    partiallyCompletePhase: vi.fn(async () => ({ outcome: 'success' })),
    failPhase: vi.fn(async () => ({ outcome: 'success' })),
    retryPhase: vi.fn(async () => ({ outcome: 'success' })),
    skipPhase: vi.fn(async () => ({ outcome: 'success' })),
    prepareObservation: vi.fn(async () => ({ outcome: 'success', batches: [] })),
    prepareDiscovery: vi.fn(async () => ({ outcome: 'success', batches: [] })),
    processObservation: vi.fn(async () => ({ outcome: 'completed' })),
    processDiscovery: vi.fn(async () => ({ outcome: 'completed' })),
    finalizeRun: vi.fn(async () => ({ outcome: 'success' })),
    releaseRun: vi.fn(async () => ({ outcome: 'success' })),
  } as unknown as SignalCollectorDependencies & Record<string, ReturnType<typeof vi.fn>>
}

function providers() {
  return {
    observation: { fetchVideoStats: vi.fn() },
    discovery: { search: vi.fn() },
  }
}

const baseInput = {
  now: new Date('2026-08-04T12:00:00.000Z'),
  invocationId: 'test-invocation',
  providerConfigured: true,
  softDeadlineMs: 240_000,
  minimumRemainingMs: 20_000,
}

describe('Premium signal collection orchestrator', () => {
  it('fails closed on disabled or unreadable control before claiming a run or calling providers', async () => {
    for (const control of [
      { outcome: 'success', enabled: false, updatedAt: '2026-08-04T00:00:00Z', updatedBy: null },
      { outcome: 'database_error', operation: 'control', error: { message: 'unavailable' } },
    ]) {
      const deps = dependencies()
      deps.getControl = vi.fn(async () => control) as never
      const injectedProviders = providers()
      const result = await runSignalCollector({ ...baseInput, providers: injectedProviders }, deps)
      expect(result.outcome).toBe('skipped')
      expect(deps.claimRun).not.toHaveBeenCalled()
      expect(injectedProviders.discovery.search).not.toHaveBeenCalled()
      expect(injectedProviders.observation.fetchVideoStats).not.toHaveBeenCalled()
    }
  })

  it('checks the DB control before rejecting missing provider configuration', async () => {
    const deps = dependencies()
    const result = await runSignalCollector({ ...baseInput, providers: providers(), providerConfigured: false }, deps)
    expect(result).toEqual({ outcome: 'failed', stage: 'provider_not_configured', runId: null })
    expect(deps.getControl).toHaveBeenCalledTimes(1)
    expect(deps.claimRun).not.toHaveBeenCalled()
  })

  it('stops all later provider work after the first provider quota-exhausted response', async () => {
    const deps = dependencies()
    deps.prepareObservation = vi.fn(async () => ({ outcome: 'success', batches: [{ id: 'batch-a' }, { id: 'batch-b' }] })) as never
    deps.processObservation = vi.fn(async () => ({ outcome: 'provider_quota_exhausted' })) as never
    deps.prepareDiscovery = vi.fn(async () => ({ outcome: 'success', batches: [{ id: 'batch-c' }] })) as never

    const result = await runSignalCollector({ ...baseInput, providers: providers() }, deps)

    expect(result).toMatchObject({ outcome: 'partially_completed', providerQuotaExhausted: true })
    expect(deps.processObservation).toHaveBeenCalledTimes(1)
    expect(deps.prepareDiscovery).not.toHaveBeenCalled()
    expect(deps.processDiscovery).not.toHaveBeenCalled()
    expect(deps.skipPhase).toHaveBeenCalledTimes(1)
    expect(deps.finalizeRun).toHaveBeenCalledTimes(1)
  })

  it('stops before the next batch at the soft deadline and finalizes a partial run', async () => {
    let clockMs = 0
    const deps = dependencies()
    deps.prepareObservation = vi.fn(async () => ({ outcome: 'success', batches: [{ id: 'batch-a' }, { id: 'batch-b' }] })) as never
    deps.processObservation = vi.fn(async () => {
      clockMs = 225_000
      return { outcome: 'completed' }
    }) as never

    const result = await runSignalCollector({ ...baseInput, providers: providers(), clock: () => clockMs }, deps)

    expect(result).toMatchObject({ outcome: 'partially_completed', deadlineReached: true })
    expect(deps.processObservation).toHaveBeenCalledTimes(1)
    expect(deps.processDiscovery).not.toHaveBeenCalled()
    expect(deps.partiallyCompletePhase).toHaveBeenCalledTimes(2)
    expect(deps.finalizeRun).toHaveBeenCalledTimes(1)
  })

  it('does not retry-storm a DB budget exhaustion and can still process the other capped phase', async () => {
    const deps = dependencies()
    deps.prepareObservation = vi.fn(async () => ({ outcome: 'success', batches: [{ id: 'batch-a' }, { id: 'batch-b' }] })) as never
    deps.processObservation = vi.fn(async () => ({ outcome: 'budget_exhausted' })) as never
    deps.prepareDiscovery = vi.fn(async () => ({ outcome: 'success', batches: [{ id: 'batch-c' }] })) as never
    deps.processDiscovery = vi.fn(async () => ({ outcome: 'completed' })) as never

    const result = await runSignalCollector({ ...baseInput, providers: providers() }, deps)

    expect(result.outcome).toBe('partially_completed')
    expect(deps.processObservation).toHaveBeenCalledTimes(1)
    expect(deps.processDiscovery).toHaveBeenCalledTimes(1)
  })

  it('treats an active same-day run lease as an idempotent skip', async () => {
    const deps = dependencies()
    deps.claimRun = vi.fn(async () => ({ outcome: 'not_claimable', reason: 'lease_active' })) as never
    const result = await runSignalCollector({ ...baseInput, providers: providers() }, deps)
    expect(result).toEqual({ outcome: 'skipped', reason: 'run_active' })
    expect(deps.ensurePhases).not.toHaveBeenCalled()
  })

  it('can reclaim a run that crashed after both phases completed and finalize it without replay', async () => {
    const deps = dependencies()
    deps.ensurePhases = vi.fn(async () => ({
      outcome: 'success',
      phases: [
        { ...phase(OBSERVATION_ID, 'observation'), status: 'completed' },
        { ...phase(DISCOVERY_ID, 'discovery'), status: 'completed' },
      ],
    })) as never
    deps.claimPhase = vi.fn(async () => ({ outcome: 'not_claimable', reason: 'terminal' })) as never

    const result = await runSignalCollector({ ...baseInput, providers: providers() }, deps)

    expect(result.outcome).toBe('completed')
    expect(deps.prepareObservation).not.toHaveBeenCalled()
    expect(deps.prepareDiscovery).not.toHaveBeenCalled()
    expect(deps.finalizeRun).toHaveBeenCalledTimes(1)
  })
})
