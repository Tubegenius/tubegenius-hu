import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const files = ['provider-budget.ts', 'run-phases.ts', 'batches.ts', 'collection-types.ts']

describe('PFM-3B2 server-side orchestration isolation', () => {
  it('contains no external provider, billing or generic fetch call', () => {
    for (const file of files) {
      const source = readFileSync(path.join(process.cwd(), 'lib', 'emerging-signal', file), 'utf8')
      expect(source).not.toMatch(/\bfetch\s*\(/)
      expect(source).not.toMatch(/anthropic|openai|serper|stripe/i)
      expect(source).not.toMatch(/youtube-service|trend-radar|keyword-research/)
    }
  })

  it('does not expose caller-controlled quota dates or limit units', () => {
    const source = readFileSync(path.join(process.cwd(), 'lib', 'emerging-signal', 'provider-budget.ts'), 'utf8')
    expect(source).not.toMatch(/quotaDate|limitUnits|p_quota_date|p_limit_units/)
  })
})
