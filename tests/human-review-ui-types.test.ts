// Semantic Topic Identity v0 -- Human-Reviewed Candidate Workflow, minimal
// reviewer UI. Pure-logic unit tests for
// components/semantic-topic-reviews/types.ts's defensive parsing helpers.
import { describe, expect, it } from 'vitest'
import { asSubjectEntities, asSupportingSpans, isUuid } from '@/components/semantic-topic-reviews/types'

describe('isUuid (client-side duplicate of the server helper)', () => {
  it('accepts a canonical lowercase v4 UUID', () => {
    expect(isUuid('c5e4da64-7e23-4e56-9620-6cdcafb395d5')).toBe(true)
  })
  it('rejects non-UUID strings and non-strings', () => {
    expect(isUuid('not-a-uuid')).toBe(false)
    expect(isUuid('')).toBe(false)
    expect(isUuid(123)).toBe(false)
    expect(isUuid(null)).toBe(false)
    expect(isUuid(undefined)).toBe(false)
  })
})

describe('asSupportingSpans -- defensive narrowing before render', () => {
  it('passes through a well-formed array', () => {
    const input = [{ source_field: 'title', quoted_text: 'hello' }]
    expect(asSupportingSpans(input)).toEqual(input)
  })

  it('drops malformed entries instead of throwing or rendering them', () => {
    const input = [{ source_field: 'title', quoted_text: 'ok' }, { source_field: 'title' }, 'not-an-object', null, 42]
    expect(asSupportingSpans(input)).toEqual([{ source_field: 'title', quoted_text: 'ok' }])
  })

  it('returns an empty array for non-array input (null/undefined/object)', () => {
    expect(asSupportingSpans(null)).toEqual([])
    expect(asSupportingSpans(undefined)).toEqual([])
    expect(asSupportingSpans({})).toEqual([])
  })

  it('an XSS-shaped quoted_text string survives as inert text data, never as markup', () => {
    const input = [{ source_field: 'title', quoted_text: '<img src=x onerror=alert(1)>' }]
    const result = asSupportingSpans(input)
    expect(result).toHaveLength(1)
    // The value itself is preserved as a plain string -- it is ReviewDetail.tsx's
    // responsibility (verified by the static source scan test) to always render
    // this as text content, never via dangerouslySetInnerHTML.
    expect(typeof result[0].quoted_text).toBe('string')
    expect(result[0].quoted_text).toBe('<img src=x onerror=alert(1)>')
  })
})

describe('asSubjectEntities', () => {
  it('passes through a well-formed string array', () => {
    expect(asSubjectEntities(['A', 'B'])).toEqual(['A', 'B'])
  })
  it('drops non-string entries', () => {
    expect(asSubjectEntities(['A', 42, null, 'B'])).toEqual(['A', 'B'])
  })
  it('returns an empty array for non-array input', () => {
    expect(asSubjectEntities(null)).toEqual([])
    expect(asSubjectEntities('A')).toEqual([])
  })
})
