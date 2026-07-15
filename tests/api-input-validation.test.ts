import { describe, expect, it } from 'vitest'
import { isJsonWithinLimit, isOptionalTextWithinLimit, isPlainRecord, isScoreOrNull, MAX_TOPIC_INPUT_LENGTH, topicInputTooLong, topicTooLongResponseMessage } from '@/lib/api-input-validation'

describe('API input validation errors', () => {
  it('accepts the boundary and rejects the first oversized character', () => {
    expect(topicInputTooLong('a'.repeat(MAX_TOPIC_INPUT_LENGTH))).toBe(false)
    expect(topicInputTooLong('a'.repeat(MAX_TOPIC_INPUT_LENGTH + 1))).toBe(true)
  })
  it('does not misclassify non-string JSON values', () => {
    expect(topicInputTooLong(null)).toBe(false)
    expect(topicInputTooLong({ length: 999 })).toBe(false)
  })
  it('returns a stable client-safe error message', () => {
    expect(topicTooLongResponseMessage('A kulcsszó')).toContain(String(MAX_TOPIC_INPUT_LENGTH))
  })

  it('accepts only finite 0-100 scores', () => {
    expect(isScoreOrNull(0)).toBe(true)
    expect(isScoreOrNull(100)).toBe(true)
    expect(isScoreOrNull(NaN)).toBe(false)
    expect(isScoreOrNull(-1)).toBe(false)
    expect(isScoreOrNull(101)).toBe(false)
    expect(isScoreOrNull('80')).toBe(false)
  })

  it('limits metadata shape and serialized size', () => {
    expect(isPlainRecord({ source: 'test' })).toBe(true)
    expect(isPlainRecord([])).toBe(false)
    expect(isJsonWithinLimit({ value: 'x'.repeat(10) }, 100)).toBe(true)
    expect(isJsonWithinLimit({ value: 'x'.repeat(200) }, 100)).toBe(false)
    expect(isOptionalTextWithinLimit(null, 10)).toBe(true)
    expect(isOptionalTextWithinLimit('12345678901', 10)).toBe(false)
  })
})
