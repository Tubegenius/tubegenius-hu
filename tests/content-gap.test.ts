import { describe, expect, it } from 'vitest'
import { validateContentGapSuggestions } from '@/lib/content-gap'

const signals = ['hogyan kezdjem el', 'melyik eszköz a jobb', 'kezdő hibák']
const valid = signals.map((signal, index) => ({
  gap_topic: `Konkrét téma ${index}`,
  demand_signal: signal,
  evidence: `A ${signal} kérdésre a videóminta nem ad egyértelmű választ.`,
  angle: 'Gyakorlati bemutató.',
}))

describe('content gap evidence validation', () => {
  it('accepts unique gaps tied to observed demand signals', () => expect(validateContentGapSuggestions(valid, signals)).toHaveLength(3))
  it('rejects invented demand', () => expect(() => validateContentGapSuggestions(valid.map((item, index) => index ? item : { ...item, demand_signal: 'sokan ezt keresik' }), signals)).toThrow())
  it('rejects duplicate topics and too few suggestions', () => {
    expect(() => validateContentGapSuggestions(valid.slice(0, 2), signals)).toThrow()
    expect(() => validateContentGapSuggestions(valid.map(item => ({ ...item, gap_topic: 'ugyanaz' })), signals)).toThrow()
  })
})
