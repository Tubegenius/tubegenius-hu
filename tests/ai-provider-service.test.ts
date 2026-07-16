import { describe, expect, it } from 'vitest'
import { assertAICompletion, extractJson, validateAICallInput } from '@/lib/services/ai-provider-service'
import { MODELS } from '@/lib/models'

const validInput = {
  model: MODELS.fast,
  maxTokens: 1000,
  messages: [{ role: 'user' as const, content: 'Adj JSON választ.' }],
  promptTemplateId: 'viral_score_explanation',
  promptVersion: 'v1',
}

describe('AI provider contract', () => {
  it('accepts registered-model shaped input and rejects model or token drift', () => {
    expect(() => validateAICallInput(validInput)).not.toThrow()
    expect(() => validateAICallInput({ ...validInput, model: 'unknown-model' })).toThrow('Unsupported AI model')
    expect(() => validateAICallInput({ ...validInput, maxTokens: 0 })).toThrow('token limit')
    expect(() => validateAICallInput({ ...validInput, maxTokens: 9000 })).toThrow('token limit')
  })

  it('rejects empty, malformed, or excessively large prompts', () => {
    expect(() => validateAICallInput({ ...validInput, messages: [] })).toThrow('message count')
    expect(() => validateAICallInput({ ...validInput, messages: [{ role: 'user', content: ' ' }] })).toThrow('Invalid AI message')
    expect(() => validateAICallInput({ ...validInput, messages: [{ role: 'user', content: 'x'.repeat(500_001) }] })).toThrow('too large')
  })

  it('fails closed on truncation, empty output, or invalid usage telemetry', () => {
    expect(() => assertAICompletion('end_turn', '{"ok":true}', 10, 5, 100)).not.toThrow()
    expect(() => assertAICompletion('max_tokens', '{"partial":', 10, 100, 100)).toThrow('truncated')
    expect(() => assertAICompletion('end_turn', ' ', 10, 0, 100)).toThrow('empty response')
    expect(() => assertAICompletion('end_turn', '{}', Number.NaN, 2, 100)).toThrow('invalid usage')
  })
})

describe('AI JSON extraction', () => {
  it('extracts fenced objects and arrays case-insensitively', () => {
    expect(extractJson('```JSON\n{"ok":true}\n```')).toEqual({ ok: true })
    expect(extractJson('Előtag [1,2,3] utótag')).toEqual([1, 2, 3])
  })

  it('repairs unescaped inner quotes but rejects empty or non-container output', () => {
    expect(extractJson('{"reason":"az "erős" állítás"}')).toEqual({ reason: 'az "erős" állítás' })
    expect(() => extractJson('')).toThrow('empty')
    expect(() => extractJson('"csak szöveg"')).toThrow('no JSON object or array')
  })
})
