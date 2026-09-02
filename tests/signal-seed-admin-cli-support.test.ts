// PFM Collector Seed Admin v0 -- pure unit tests for the shared CLI-support
// module: manifest parsing, the real computeFingerprint() contract, and
// idempotency-key derivation. No DB, no network, no filesystem beyond
// reading the real Phase 1 manifest fixture.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  parseManifest, loadManifestFromPath, prepareSeed,
  deriveRegisterIdempotencyKey, deriveDeactivateIdempotencyKey,
  SEED_MANIFEST_CONTRACT_VERSION, DEACTIVATE_REASON_CODES,
} from '@/lib/emerging-signal/seed-admin-cli-support'
import { computeFingerprint } from '@/lib/emerging-signal/fingerprint'
import type { SeedManifestEntry } from '@/lib/emerging-signal/seed-admin-cli-support'

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
