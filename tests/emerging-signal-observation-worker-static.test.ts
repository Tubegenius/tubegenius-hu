import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('PFM-3B3 observation worker static safety', () => {
  it('requires an injected provider and has no implicit external integration', () => {
    const source = readFileSync(resolve(process.cwd(), 'lib/emerging-signal/observation-worker.ts'), 'utf8')
    expect(source).toContain('provider: ObservationProvider')
    expect(source).not.toContain("from '@/lib/youtube-service'")
    expect(source).not.toContain("from '@/lib/trend-radar'")
    expect(source).not.toMatch(/\bfetch\s*\(/)
    expect(source).not.toMatch(/serper|claude|anthropic/i)
  })
})
