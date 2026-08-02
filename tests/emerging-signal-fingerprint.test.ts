import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeFingerprint, FINGERPRINT_VERSION } from '@/lib/emerging-signal/fingerprint'

afterEach(() => vi.useRealTimers())

describe('emerging-signal fingerprint — v1 (category + topic + seed_keyword, no entity extraction)', () => {
  const base = {
    category: 'tech_ai',
    candidateTopicEn: 'GPT-6 launch',
    candidateTopic: 'GPT-6 megjelent',
    seedKeyword: 'openai gpt6',
  }

  it('identical input -> identical fingerprint', () => {
    const a = computeFingerprint(base)
    const b = computeFingerprint({ ...base })
    expect(a).not.toBeNull()
    expect(a).toEqual(b)
  })

  it('is SHA-256 hex, at least 128 bits (32 hex chars) — actually the full 64', () => {
    const a = computeFingerprint(base)
    expect(a!.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(a!.fingerprint.length * 4).toBeGreaterThanOrEqual(128)
    expect(a!.version).toBe(FINGERPRINT_VERSION)
    expect(a!.version).toBe(1)
  })

  it('case/diacritic/whitespace differences produce the SAME fingerprint', () => {
    const a = computeFingerprint(base)
    const b = computeFingerprint({
      category: '  TECH_AI  ',
      candidateTopicEn: 'gpt-6   LAUNCH',
      candidateTopic: 'irrelevant when candidateTopicEn present',
      seedKeyword: 'OpenAI   GPT6',
    })
    expect(b).toEqual(a)
  })

  it('falls back to candidateTopic when candidateTopicEn is absent, and that still matches an equivalent direct call', () => {
    const withEn = computeFingerprint({ ...base, candidateTopicEn: undefined, candidateTopic: 'GPT-6 launch' })
    const direct = computeFingerprint({ category: 'tech_ai', candidateTopicEn: 'GPT-6 launch', candidateTopic: 'x', seedKeyword: 'openai gpt6' })
    expect(withEn).toEqual(direct)
  })

  it('different category -> different fingerprint', () => {
    const a = computeFingerprint(base)
    const b = computeFingerprint({ ...base, category: 'finance_crypto' })
    expect(b!.fingerprint).not.toBe(a!.fingerprint)
  })

  it('different topic -> different fingerprint', () => {
    const a = computeFingerprint(base)
    const b = computeFingerprint({ ...base, candidateTopicEn: 'Completely different topic' })
    expect(b!.fingerprint).not.toBe(a!.fingerprint)
  })

  it('different seed_keyword -> different fingerprint', () => {
    const a = computeFingerprint(base)
    const b = computeFingerprint({ ...base, seedKeyword: 'a totally different seed' })
    expect(b!.fingerprint).not.toBe(a!.fingerprint)
  })

  it('does NOT claim "altman" and "sam altman" are the same input', () => {
    const a = computeFingerprint({ ...base, seedKeyword: 'altman' })
    const b = computeFingerprint({ ...base, seedKeyword: 'sam altman' })
    expect(a!.fingerprint).not.toBe(b!.fingerprint)
  })

  it('the order in which the input object properties are constructed does not affect the result (named fields, not positional)', () => {
    const objA = { seedKeyword: base.seedKeyword, candidateTopic: base.candidateTopic, candidateTopicEn: base.candidateTopicEn, category: base.category }
    const objB = { category: base.category, candidateTopicEn: base.candidateTopicEn, candidateTopic: base.candidateTopic, seedKeyword: base.seedKeyword }
    expect(computeFingerprint(objA)).toEqual(computeFingerprint(objB))
  })

  it('a month/date change does NOT alter the fingerprint (no time component in the formula)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-15T00:00:00Z'))
    const january = computeFingerprint(base)
    vi.setSystemTime(new Date('2026-08-15T00:00:00Z'))
    const august = computeFingerprint(base)
    expect(august).toEqual(january)
  })

  it('missing category -> controlled skip (null), not a fabricated fingerprint', () => {
    expect(computeFingerprint({ ...base, category: null })).toBeNull()
    expect(computeFingerprint({ ...base, category: undefined })).toBeNull()
    expect(computeFingerprint({ ...base, category: '   ' })).toBeNull()
  })

  it('missing topic (both candidateTopicEn and candidateTopic blank) -> controlled skip', () => {
    expect(computeFingerprint({ ...base, candidateTopicEn: undefined, candidateTopic: '   ' })).toBeNull()
  })

  it('missing seed_keyword -> controlled skip', () => {
    expect(computeFingerprint({ ...base, seedKeyword: '' })).toBeNull()
  })

  it('a component that normalizes to empty (punctuation-only) -> controlled skip', () => {
    expect(computeFingerprint({ ...base, seedKeyword: '!!!???...' })).toBeNull()
  })
})
