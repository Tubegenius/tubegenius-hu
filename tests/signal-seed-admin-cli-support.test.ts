// PFM Collector Seed Admin v0 -- pure unit tests for the shared CLI-support
// module: manifest parsing, the real computeFingerprint() contract, and
// idempotency-key derivation. No DB, no network, no filesystem beyond
// reading the real Phase 1 manifest fixture.
import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import {
  parseManifest, loadManifestFromPath, prepareSeed, prepareAllSeeds,
  deriveRegisterIdempotencyKey, deriveDeactivateIdempotencyKey, applyRegisterManifest,
  SEED_MANIFEST_CONTRACT_VERSION, DEACTIVATE_REASON_CODES,
} from '@/lib/emerging-signal/seed-admin-cli-support'
import { computeFingerprint } from '@/lib/emerging-signal/fingerprint'
import type { SeedManifestEntry, PreparedSeed } from '@/lib/emerging-signal/seed-admin-cli-support'
import type { SignalAdminClient } from '@/lib/emerging-signal/collection-types'

const VALID_ENTRY: SeedManifestEntry = {
  id: 'hu-entertainment-x', seedText: 'teszt seed szoveg', category: 'entertainment', region: 'HU', language: 'hu', seedType: 'curated_global',
}

function manifestWith(seeds: unknown[]): string {
  return JSON.stringify({ manifestVersion: 'test.v1', contractVersion: SEED_MANIFEST_CONTRACT_VERSION, seeds })
}

describe('parseManifest', () => {
  it('accepts a valid manifest', () => {
    const result = parseManifest(manifestWith([VALID_ENTRY]))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.manifest.seeds).toHaveLength(1)
  })

  it('rejects invalid JSON', () => {
    expect(parseManifest('{not json')).toEqual({ ok: false, message: 'manifest is not valid JSON' })
  })

  it('rejects a wrong contractVersion', () => {
    const result = parseManifest(JSON.stringify({ manifestVersion: 'x', contractVersion: 'v2', seeds: [VALID_ENTRY] }))
    expect(result.ok).toBe(false)
  })

  it('rejects an empty seeds array', () => {
    expect(parseManifest(manifestWith([])).ok).toBe(false)
  })

  it('rejects a duplicate seed id', () => {
    expect(parseManifest(manifestWith([VALID_ENTRY, VALID_ENTRY])).ok).toBe(false)
  })

  it.each([
    ['category', { ...VALID_ENTRY, category: 'not_a_real_category' }],
    ['region', { ...VALID_ENTRY, region: 'FR' }],
    ['language', { ...VALID_ENTRY, language: 'de' }],
    ['seedType', { ...VALID_ENTRY, seedType: 'not_a_real_type' }],
    ['id', { ...VALID_ENTRY, id: 'INVALID ID!' }],
  ])('rejects an unsupported %s value', (_field, entry) => {
    expect(parseManifest(manifestWith([entry])).ok).toBe(false)
  })

  it('rejects a seedText over 300 characters', () => {
    expect(parseManifest(manifestWith([{ ...VALID_ENTRY, seedText: 'x'.repeat(301) }])).ok).toBe(false)
  })

  it('rejects a blank seedText', () => {
    expect(parseManifest(manifestWith([{ ...VALID_ENTRY, seedText: '   ' }])).ok).toBe(false)
  })
})

describe('loadManifestFromPath -- the real Phase 1 manifest fixture', () => {
  const manifestPath = join(__dirname, '..', 'config', 'signal-seed-catalog', 'phase1.v1.json')

  it('loads and validates the real Phase 1 manifest', () => {
    const result = loadManifestFromPath(manifestPath)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.seeds).toHaveLength(4)
    const categories = new Set(result.manifest.seeds.map((s) => s.category))
    expect(categories.size).toBeGreaterThanOrEqual(3)
  })

  it('every Phase 1 seed produces a real, valid 64-hex fingerprint via computeFingerprint()', () => {
    const result = loadManifestFromPath(manifestPath)
    if (!result.ok) throw new Error('manifest failed to load')
    for (const entry of result.manifest.seeds) {
      const prepared = prepareSeed(entry)
      expect(prepared.ok).toBe(true)
      if (prepared.ok) expect(prepared.seed.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('the Phase 1 manifest has no two seeds sharing a fingerprint (no accidental overlap)', () => {
    const result = loadManifestFromPath(manifestPath)
    if (!result.ok) throw new Error('manifest failed to load')
    const fingerprints = result.manifest.seeds.map((e) => {
      const prepared = prepareSeed(e)
      if (!prepared.ok) throw new Error('fingerprint failed')
      return prepared.seed.fingerprint
    })
    expect(new Set(fingerprints).size).toBe(fingerprints.length)
  })

  it('returns ok:false for a missing file, never throws', () => {
    const result = loadManifestFromPath(join(__dirname, 'does-not-exist-manifest.json'))
    expect(result.ok).toBe(false)
  })
})

describe('prepareSeed -- fingerprint contract', () => {
  it('matches the EXACT computeFingerprint() call shape captureScheduledDiscovery() uses (candidateTopicEn=null, candidateTopic=seedText, seedKeyword=seedText)', () => {
    const entry = VALID_ENTRY
    const prepared = prepareSeed(entry)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    const directly = computeFingerprint({
      category: entry.category, candidateTopicEn: null, candidateTopic: entry.seedText, seedKeyword: entry.seedText,
    })
    expect(prepared.seed.fingerprint).toBe(directly?.fingerprint)
  })

  it('is deterministic -- the same entry always produces the same fingerprint', () => {
    const a = prepareSeed(VALID_ENTRY)
    const b = prepareSeed(VALID_ENTRY)
    expect(a.ok && b.ok && a.seed.fingerprint === b.seed.fingerprint).toBe(true)
  })

  it('a different category with the same seedText produces a different fingerprint', () => {
    const a = prepareSeed(VALID_ENTRY)
    const b = prepareSeed({ ...VALID_ENTRY, category: 'gaming' })
    expect(a.ok && b.ok && a.seed.fingerprint !== b.seed.fingerprint).toBe(true)
  })
})

describe('idempotency-key derivation', () => {
  it('deriveRegisterIdempotencyKey is deterministic per (manifestVersion, seedId)', () => {
    expect(deriveRegisterIdempotencyKey('phase1.v1', 'hu-x')).toBe(deriveRegisterIdempotencyKey('phase1.v1', 'hu-x'))
    expect(deriveRegisterIdempotencyKey('phase1.v1', 'hu-x')).not.toBe(deriveRegisterIdempotencyKey('phase1.v2', 'hu-x'))
  })

  it('deriveDeactivateIdempotencyKey is deterministic per (fingerprint, reasonCode, operatorReference) and differs when any component differs', () => {
    const base = deriveDeactivateIdempotencyKey('f'.repeat(64), 'OPERATOR_REQUESTED', 'op-1')
    expect(deriveDeactivateIdempotencyKey('f'.repeat(64), 'OPERATOR_REQUESTED', 'op-1')).toBe(base)
    expect(deriveDeactivateIdempotencyKey('e'.repeat(64), 'OPERATOR_REQUESTED', 'op-1')).not.toBe(base)
    expect(deriveDeactivateIdempotencyKey('f'.repeat(64), 'LOW_QUALITY_YIELD', 'op-1')).not.toBe(base)
    expect(deriveDeactivateIdempotencyKey('f'.repeat(64), 'OPERATOR_REQUESTED', 'op-2')).not.toBe(base)
  })

  it('DEACTIVATE_REASON_CODES matches the exact closed set the 083 RPC enforces', () => {
    expect([...DEACTIVATE_REASON_CODES].sort()).toEqual(
      ['DUPLICATE_COVERAGE', 'LOW_QUALITY_YIELD', 'OPERATOR_REQUESTED', 'PHASE_ROLLBACK', 'QUOTA_REDUCTION'].sort(),
    )
  })
})

// ===========================================================================
// PFM Collector Seed Admin v0 -- Apply Fail-Fast and Project Identity
// Redaction Remediation gate. Pure unit tests against a fully mocked
// client.rpc -- no DB, no network -- so the exact call-count assertions
// ("second seed rejected -> exactly two calls") are fast and deterministic.
// ===========================================================================
describe('applyRegisterManifest -- fail-fast on the first non-success outcome', () => {
  function seedFixtures(): PreparedSeed[] {
    return (['a', 'b', 'c', 'd'] as const).map((letter) => ({
      id: `seed-${letter}`, seedText: `seed text ${letter}`, category: 'entertainment', region: 'HU', language: 'hu',
      seedType: 'curated_global', fingerprint: 'f'.repeat(63) + letter,
    }))
  }

  function mockClient(responses: Array<{ data?: unknown; error?: { message: string } } | 'throw'>): { client: SignalAdminClient; rpc: ReturnType<typeof vi.fn> } {
    let call = 0
    const rpc = vi.fn(async () => {
      const response = responses[call]
      call += 1
      if (response === 'throw') throw new Error('simulated transport failure')
      return response ?? { data: null, error: { message: 'no more mocked responses' } }
    })
    return { client: { rpc } as unknown as SignalAdminClient, rpc }
  }

  it('second seed rejected (FINGERPRINT_PAYLOAD_CONFLICT) -> exactly two RPC calls, seeds 3 and 4 never called', async () => {
    const { client, rpc } = mockClient([
      { data: { ok: true, outcome: 'created', seed_id: 'id-a' } },
      { error: { message: 'register_signal_seed: FINGERPRINT_PAYLOAD_CONFLICT -- fingerprint xyz already exists with a different payload' } },
    ])
    const result = await applyRegisterManifest(client, { seeds: seedFixtures(), operatorReference: 'test-op', manifestVersion: 'v1' })
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(result).toEqual({
      outcome: 'partial_apply', totalSeeds: 4, succeededCount: 1, failedAtIndex: 2, remainingUncalledCount: 2, stopReason: 'rejected',
    })
  })

  it('first seed database_error -> exactly one RPC call', async () => {
    const { client, rpc } = mockClient([
      { error: { message: 'connection reset' } },
    ])
    const result = await applyRegisterManifest(client, { seeds: seedFixtures(), operatorReference: 'test-op', manifestVersion: 'v1' })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      outcome: 'partial_apply', totalSeeds: 4, succeededCount: 0, failedAtIndex: 1, remainingUncalledCount: 3, stopReason: 'database_error',
    })
  })

  it('an unrecognized outcome shape -> immediate fail-closed stop, exactly one RPC call', async () => {
    const { client, rpc } = mockClient([
      { data: { ok: true, outcome: 'mystery_future_outcome', seed_id: 'id-a' } },
    ])
    const result = await applyRegisterManifest(client, { seeds: seedFixtures(), operatorReference: 'test-op', manifestVersion: 'v1' })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(result.outcome).toBe('partial_apply')
    if (result.outcome === 'partial_apply') expect(result.stopReason).toBe('database_error')
  })

  it('a thrown exception mid-loop -> caught, treated as a fail-closed stop, remaining seeds never called', async () => {
    const { client, rpc } = mockClient([
      { data: { ok: true, outcome: 'created', seed_id: 'id-a' } },
      'throw',
    ])
    const result = await applyRegisterManifest(client, { seeds: seedFixtures(), operatorReference: 'test-op', manifestVersion: 'v1' })
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(result).toEqual({
      outcome: 'partial_apply', totalSeeds: 4, succeededCount: 1, failedAtIndex: 2, remainingUncalledCount: 2, stopReason: 'exception',
    })
  })

  it('created/already_exists combination for all four seeds -> all four run safely, exactly four RPC calls', async () => {
    const { client, rpc } = mockClient([
      { data: { ok: true, outcome: 'created', seed_id: 'id-a' } },
      { data: { ok: true, outcome: 'already_exists', seed_id: 'id-b', active: true } },
      { data: { ok: true, outcome: 'created', seed_id: 'id-c' } },
      { data: { ok: true, outcome: 'already_exists', seed_id: 'id-d', active: false } },
    ])
    const seen: unknown[] = []
    const result = await applyRegisterManifest(client, {
      seeds: seedFixtures(), operatorReference: 'test-op', manifestVersion: 'v1',
      onSeedResult: (event) => seen.push(event),
    })
    expect(rpc).toHaveBeenCalledTimes(4)
    expect(result).toEqual({ outcome: 'completed', succeededCount: 4 })
    expect(seen).toEqual([
      { seedId: 'seed-a', kind: 'created' },
      { seedId: 'seed-b', kind: 'already_exists', active: true },
      { seedId: 'seed-c', kind: 'created' },
      { seedId: 'seed-d', kind: 'already_exists', active: false },
    ])
  })

  it('onSeedResult never fires for the stopping failure itself, only for prior successes', async () => {
    const { client } = mockClient([
      { data: { ok: true, outcome: 'created', seed_id: 'id-a' } },
      { error: { message: 'register_signal_seed: IDEMPOTENCY_KEY_REUSE -- idempotency_key foo already used with a different request' } },
    ])
    const seen: unknown[] = []
    await applyRegisterManifest(client, { seeds: seedFixtures(), operatorReference: 'test-op', manifestVersion: 'v1', onSeedResult: (e) => seen.push(e) })
    expect(seen).toEqual([{ seedId: 'seed-a', kind: 'created' }])
  })

  it('partial_apply summary contains ONLY count-shaped fields and a closed stopReason enum -- no seed identity, no message, no raw RPC response', async () => {
    const { client } = mockClient([
      { error: { message: 'register_signal_seed: FINGERPRINT_PAYLOAD_CONFLICT -- fingerprint ' + 'a'.repeat(64) + ' already exists' } },
    ])
    const result = await applyRegisterManifest(client, { seeds: seedFixtures(), operatorReference: 'test-op', manifestVersion: 'v1' })
    expect(result.outcome).toBe('partial_apply')
    if (result.outcome !== 'partial_apply') return
    expect(Object.keys(result).sort()).toEqual(
      ['outcome', 'totalSeeds', 'succeededCount', 'failedAtIndex', 'remainingUncalledCount', 'stopReason'].sort(),
    )
    expect(typeof result.totalSeeds).toBe('number')
    expect(typeof result.succeededCount).toBe('number')
    expect(typeof result.failedAtIndex).toBe('number')
    expect(typeof result.remainingUncalledCount).toBe('number')
    expect(['rejected', 'database_error', 'exception']).toContain(result.stopReason)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toMatch(/[0-9a-f]{64}/i)
    expect(serialized).not.toMatch(/seed-[abcd]/)
  })

  it('the safe reasonCode extractor never leaks a full fingerprint even when the raw RPC error text contains one', async () => {
    const { callRegisterSignalSeed } = await import('@/lib/emerging-signal/seed-admin-cli-support')
    const fullFingerprint = 'b'.repeat(64)
    const { client } = mockClient([
      { error: { message: `register_signal_seed: FINGERPRINT_PAYLOAD_CONFLICT -- fingerprint ${fullFingerprint} already exists with a different payload` } },
    ])
    const outcome = await callRegisterSignalSeed(client, {
      seed: seedFixtures()[0], operatorReference: 'test-op', idempotencyKey: 'k',
    })
    expect(outcome).toEqual({ kind: 'rejected', reasonCode: 'FINGERPRINT_PAYLOAD_CONFLICT' })
    expect(JSON.stringify(outcome)).not.toContain(fullFingerprint)
  })
})

describe('prepareAllSeeds -- full-manifest validation before any RPC (item 1)', () => {
  it('prepares all entries when every one is valid', () => {
    const manifest = { manifestVersion: 'v1', contractVersion: SEED_MANIFEST_CONTRACT_VERSION, seeds: [VALID_ENTRY, { ...VALID_ENTRY, id: 'hu-entertainment-y' }] }
    const result = prepareAllSeeds(manifest)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.seeds).toHaveLength(2)
  })
})
