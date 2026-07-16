import { describe, expect, it } from 'vitest'
import { resolveOAuthOrigin } from '@/lib/youtube-analytics'

describe('YouTube OAuth origin policy', () => {
  it('uses the canonical HTTPS app origin in production', () => {
    expect(resolveOAuthOrigin('https://attacker.example', 'https://app.willviral.example/path', true)).toBe('https://app.willviral.example')
  })

  it('uses the request origin in development', () => {
    expect(resolveOAuthOrigin('http://localhost:3000', 'https://production.example', false)).toBe('http://localhost:3000')
  })

  it('rejects missing or insecure production origins', () => {
    expect(() => resolveOAuthOrigin('https://request.example', undefined, true)).toThrow('not configured')
    expect(() => resolveOAuthOrigin('https://request.example', 'http://production.example', true)).toThrow('HTTPS')
  })
})
