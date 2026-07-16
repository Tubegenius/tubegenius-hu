import { describe, expect, it } from 'vitest'
import { isValidNextVideoSuggestions, isValidScriptAnalysis } from '@/lib/generated-output-validation'

describe('generated workflow output validation', () => {
  it('accepts bounded channel suggestions and rejects malformed arrays', () => {
    const valid = Array.from({ length: 10 }, (_, i) => ({ topic: `Teszt ${i}`, reasoning: 'Valos indok' }))
    expect(isValidNextVideoSuggestions(valid)).toBe(true)
    expect(isValidNextVideoSuggestions(valid.slice(0, 9))).toBe(false)
    expect(isValidNextVideoSuggestions([])).toBe(false)
    expect(isValidNextVideoSuggestions([{ topic: '', reasoning: 'x' }])).toBe(false)
  })
  it('validates script analysis before charging', () => {
    expect(isValidScriptAnalysis({ hook: 'Hook', structure: [{ timestamp: '0:00', label: 'Nyitas', content: 'Szoveg', type: 'hook' }], key_points: ['Pont'], success_factors: 'Ok' })).toBe(true)
    expect(isValidScriptAnalysis({ hook: 'Hook', structure: 'invalid', key_points: [], success_factors: 'Ok' })).toBe(false)
  })
})
