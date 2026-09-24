import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(process.cwd(), 'components', 'dashboard', 'PremiumToday.tsx'), 'utf8')

describe('Creator Today production truthfulness', () => {
  it('renders only real profile and memory facts plus an honest no-project state', () => {
    expect(source).toContain('profile?.specific_focus || profile?.niche')
    expect(source).toContain('memoryCount')
    expect(source).toContain('Nincs biztonságosan betöltve')
    expect(source).not.toMatch(/mintaprojekt|mintaadat|szemléltető|pulseItems/i)
  })

  it('links only to existing routes and never promises a fabricated continuation', () => {
    expect(source).toContain('href="/dashboard/profile"')
    expect(source).toContain('href="/dashboard/library"')
    expect(source).toContain('href="/dashboard/channel-audit"')
    expect(source).not.toContain('Folytatom az alkotást')
  })
})
