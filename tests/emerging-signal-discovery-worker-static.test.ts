import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('PFM-3B4 discovery worker external-call boundary', () => {
  it('has an injected provider and zero built-in YouTube, Serper or Claude call sites', () => {
    const source = readFileSync(resolve(process.cwd(), 'lib/emerging-signal/discovery-worker.ts'), 'utf8')
    expect(source).toContain('provider: DiscoveryProvider')
    expect(source).toContain('input.provider.search')
    for (const forbidden of [
      "from '@/lib/youtube-service'",
      "from './youtube-service'",
      'trend-radar',
      'SERPER_API_KEY',
      'serper.dev',
      '@anthropic-ai/sdk',
      'ANTHROPIC_API_KEY',
      'claude',
      'fetch(',
    ]) expect(source.toLowerCase()).not.toContain(forbidden.toLowerCase())
  })

  it('hard-caps one provider request at 25 results and one search.list reservation at 100 units', () => {
    const source = readFileSync(resolve(process.cwd(), 'lib/emerging-signal/discovery-worker.ts'), 'utf8')
    expect(source).toContain('maxResults: 25')
    expect(source).toContain("usageType: 'discovery_search'")
    expect(source).toContain('units: 100')
    expect(source).toContain('commitProviderUnits(reservationId, 100')
  })
})
