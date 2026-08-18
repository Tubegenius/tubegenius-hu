// PFM Creator Lane Architecture v0 — a közös, kliens+szerver topic-identitás
// szerződés (lib/creator-lane/topic-identity.ts). Ennek EGYETLEN dolga van:
// pontosan ugyanazt az identitást adni, mint amit upsert_creator_memory()
// ténylegesen tárol (btrim(), case-sensitive, nincs Unicode-normalizálás) —
// ha ez a függvény máshogy viselkedne, mint a szerver, egy vezető/záró
// szóközös cím hamis "nincs elmentve" állapotot mutathatna egy ténylegesen
// már mentett témánál.
import { describe, expect, it } from 'vitest'
import { normalizeTopicKey, isValidTopicKey, SAVED_LOOKUP_MAX_TOPICS, SAVED_LOOKUP_MAX_TOPIC_LENGTH } from '@/lib/creator-lane/topic-identity'

describe('normalizeTopicKey', () => {
  it('trims leading and trailing whitespace, exactly matching the server\'s btrim()', () => {
    expect(normalizeTopicKey('  Egy téma  ')).toBe('Egy téma')
    expect(normalizeTopicKey('\tTabbed\n')).toBe('Tabbed')
  })

  it('a topic with no surrounding whitespace is unchanged', () => {
    expect(normalizeTopicKey('Egy téma')).toBe('Egy téma')
  })

  it('an all-whitespace topic normalizes to the empty string (invalid)', () => {
    expect(normalizeTopicKey('   ')).toBe('')
  })

  it('does NOT lowercase or otherwise Unicode-fold — creator_memory identity is case-sensitive AS-IS', () => {
    expect(normalizeTopicKey('Egy Téma')).toBe('Egy Téma')
    expect(normalizeTopicKey('EGY TÉMA')).not.toBe(normalizeTopicKey('egy téma'))
  })

  it('internal whitespace is preserved untouched (only leading/trailing is trimmed)', () => {
    expect(normalizeTopicKey('  Egy   téma  ')).toBe('Egy   téma')
  })
})

describe('isValidTopicKey', () => {
  it('non-empty key is valid', () => {
    expect(isValidTopicKey('Egy téma')).toBe(true)
  })

  it('empty string is invalid', () => {
    expect(isValidTopicKey('')).toBe(false)
  })
})

describe('SAVED_LOOKUP_MAX_TOPICS / SAVED_LOOKUP_MAX_TOPIC_LENGTH', () => {
  it('are positive, finite, sane bounds — shared by client and server so neither can drift out of sync', () => {
    expect(SAVED_LOOKUP_MAX_TOPICS).toBeGreaterThan(0)
    expect(Number.isFinite(SAVED_LOOKUP_MAX_TOPICS)).toBe(true)
    expect(SAVED_LOOKUP_MAX_TOPIC_LENGTH).toBeGreaterThan(0)
    expect(Number.isFinite(SAVED_LOOKUP_MAX_TOPIC_LENGTH)).toBe(true)
  })
})
