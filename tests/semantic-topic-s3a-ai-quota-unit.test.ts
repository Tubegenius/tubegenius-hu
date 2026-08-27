// Semantic Topic Identity v0 -- S3A. Pure unit tests for ai-quota.ts's
// reserveAiProviderUnits() kill-switch pre-check (see the runner's typed-
// contract fix: reserve_ai_provider_units (075, frozen/hash-locked) raises
// every one of its validation exceptions with the identical ERRCODE='P0001',
// so its rejection ALONE cannot tell "AI extraction is disabled" apart from
// any other invalid_transition without parsing its message text, which
// callers must never do -- see supervised-intake-runner.ts's decideItemOutcome
// header). No Docker, no network, no real provider or RPC call: the Supabase
// client is a hand-built mock covering exactly .from().select().eq().maybeSingle()
// and .rpc(), same pattern as tests/supervised-intake-runner.test.ts.
import { describe, expect, it, vi } from 'vitest'
import { reserveAiProviderUnits } from '@/lib/semantic-topic/ai-quota'
import type { SemanticTopicAdminClient } from '@/lib/semantic-topic/quota-types'

const VALID_RESERVE_INPUT = {
  signalEvidenceId: '11111111-1111-4111-8111-111111111111',
  normalizedExtractionInput: 'some normalized text',
  estimatedInputTokens: 100,
  idempotencyKey: 'unit-test-key-1',
}

function createMockClient() {
  const rpc = vi.fn()
  const from = vi.fn()
  return { rpc, from } as unknown as SemanticTopicAdminClient & { rpc: ReturnType<typeof vi.fn>; from: ReturnType<typeof vi.fn> }
}

function mockControlRead(client: ReturnType<typeof createMockClient>, response: { data: unknown; error: unknown }) {
  const maybeSingleMock = vi.fn().mockResolvedValue(response)
  const eqMock = vi.fn(() => ({ maybeSingle: maybeSingleMock }))
  const selectMock = vi.fn(() => ({ eq: eqMock }))
  client.from.mockImplementation((table: string) => {
    if (table === 'ai_extraction_control') return { select: selectMock }
    throw new Error(`unexpected table in this unit test: ${table}`)
  })
  return { eqMock, maybeSingleMock, selectMock }
}

describe('reserveAiProviderUnits -- ai_extraction_control kill-switch pre-check', () => {
  it('enabled=false: returns a stable ai_extraction_disabled outcome, WITHOUT ever calling the reserve RPC (zero provider risk, zero reservation)', async () => {
    const client = createMockClient()
    mockControlRead(client, { data: { enabled: false }, error: null })

    const result = await reserveAiProviderUnits(VALID_RESERVE_INPUT, client)

    expect(result).toEqual({ outcome: 'ai_extraction_disabled' })
    expect(client.rpc).not.toHaveBeenCalled()
  })

  it('enabled=true: falls through to the real RPC call as before', async () => {
    const client = createMockClient()
    mockControlRead(client, { data: { enabled: true }, error: null })
    client.rpc.mockResolvedValue({ data: '33333333-3333-4333-8333-333333333333', error: null })

    const result = await reserveAiProviderUnits(VALID_RESERVE_INPUT, client)

    expect(result).toEqual({ outcome: 'reserved', reservationId: '33333333-3333-4333-8333-333333333333' })
    expect(client.rpc).toHaveBeenCalledTimes(1)
    expect(client.rpc).toHaveBeenCalledWith('reserve_ai_provider_units', expect.any(Object))
  })

  it('control read errors: does NOT fail closed on the pre-check alone -- falls through to the RPC, whose own server-side check stays authoritative', async () => {
    const client = createMockClient()
    mockControlRead(client, { data: null, error: { message: 'connection reset' } })
    client.rpc.mockResolvedValue({ data: '44444444-4444-4444-8444-444444444444', error: null })

    const result = await reserveAiProviderUnits(VALID_RESERVE_INPUT, client)

    expect(result).toEqual({ outcome: 'reserved', reservationId: '44444444-4444-4444-8444-444444444444' })
    expect(client.rpc).toHaveBeenCalledTimes(1)
  })

  it('control row not found (null): falls through to the RPC rather than assuming disabled', async () => {
    const client = createMockClient()
    mockControlRead(client, { data: null, error: null })
    client.rpc.mockResolvedValue({ data: '55555555-5555-4555-8555-555555555555', error: null })

    const result = await reserveAiProviderUnits(VALID_RESERVE_INPUT, client)

    expect(result).toEqual({ outcome: 'reserved', reservationId: '55555555-5555-4555-8555-555555555555' })
  })

  it('the pre-check never mislabels a race-window RPC rejection: enabled=true at read time, RPC itself still rejects -> generic invalid_transition, NOT ai_extraction_disabled', async () => {
    const client = createMockClient()
    mockControlRead(client, { data: { enabled: true }, error: null })
    client.rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'reserve_ai_provider_units: AI extraction is currently disabled' } })

    const result = await reserveAiProviderUnits(VALID_RESERVE_INPUT, client)

    // Never reinterprets the RPC's own rejection based on the (now-stale)
    // pre-check read -- stays generic and honest rather than confidently
    // mislabeling a race-window outcome.
    expect(result).toEqual({ outcome: 'invalid_transition', message: 'reserve_ai_provider_units: AI extraction is currently disabled' })
  })

  it('validation still runs BEFORE the pre-check even reads the DB (invalid input never spends a round-trip)', async () => {
    const client = createMockClient()
    const result = await reserveAiProviderUnits({ ...VALID_RESERVE_INPUT, signalEvidenceId: 'not-a-uuid' }, client)

    expect(result).toEqual({ outcome: 'invalid_request', message: 'signalEvidenceId must be a UUID.' })
    expect(client.from).not.toHaveBeenCalled()
    expect(client.rpc).not.toHaveBeenCalled()
  })
})
