import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const growth = readFileSync(join(process.cwd(), 'components', 'dashboard', 'CreatorGrowth.tsx'), 'utf8')

describe('Creator growth production truthfulness', () => {
  it('ships no fabricated performance dataset or chart', () => {
    expect(existsSync(join(process.cwd(), 'lib', 'creator-growth-presentation.ts'))).toBe(false)
    expect(growth).not.toMatch(/CREATOR_GROWTH_PRESENTATION|RetentionChart|chartPoints|mintaadat|szemléltető/i)
    expect(growth).toContain('Nem rajzolunk kitalált retention görbét')
  })

  it('offers only existing audit and diagnostic routes', () => {
    expect(growth).toContain('href="/dashboard/channel-audit"')
    expect(growth).toContain('href="/dashboard/video-audit"')
    expect(growth).not.toContain('Tesztprojekt megnyitása')
  })
})
