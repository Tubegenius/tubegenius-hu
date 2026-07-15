import { describe, expect, it } from 'vitest'
import { MAX_TOPIC_INPUT_LENGTH, topicInputTooLong, topicTooLongResponseMessage } from '@/lib/api-input-validation'

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
})
