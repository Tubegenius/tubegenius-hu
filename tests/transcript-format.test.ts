import { describe, expect, it } from 'vitest'
import { buildSrt, buildVtt, normalizeTranscriptSegments, secondsToTimestamp } from '@/lib/transcript-format'

describe('transcript export safety', () => {
  it('carries rounded milliseconds into the next second', () => expect(secondsToTimestamp(1.9996, ',')).toBe('00:00:02,000'))
  it('rejects invalid cues and orders valid cues', () => {
    expect(normalizeTranscriptSegments([{ start: 4, end: 5, text: 'masodik' }, { start: Number.NaN, end: 2, text: 'hibas' }, { start: 1, end: 1, text: 'nulla' }, { start: 1, end: 2, text: 'elso' }]))
      .toEqual([{ start: 1, end: 2, text: 'elso' }, { start: 4, end: 5, text: 'masodik' }])
  })
  it('does not invent timed exports when duration is unknown', () => {
    const segments = normalizeTranscriptSegments([], 'szoveg', 0)
    expect(segments).toEqual([]); expect(buildSrt(segments)).toBe(''); expect(buildVtt(segments)).toBe('')
  })
})
