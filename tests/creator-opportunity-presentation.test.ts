import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const discover = readFileSync(join(process.cwd(), 'components', 'dashboard', 'CreatorDiscover.tsx'), 'utf8')
const createPage = readFileSync(join(process.cwd(), 'app', 'dashboard', 'create', 'page.tsx'), 'utf8')

describe('Creator opportunity production truthfulness', () => {
  it('ships no runtime opportunity fixture or static personalized brief', () => {
    expect(existsSync(join(process.cwd(), 'lib', 'creator-opportunity-presentation.ts'))).toBe(false)
    expect(discover).not.toMatch(/CREATOR_OPPORTUNITIES|mintaadat|szemléltető|Mentés a könyvtárba|Projektvázlat indítása/)
    expect(createPage).not.toMatch(/starter|findCreatorOpportunity/)
  })

  it('keeps an honest premium empty state with only functioning route links', () => {
    expect(discover).toContain('Még nincs biztonságosan betöltött')
    expect(discover).toContain('href="/dashboard/channel-audit"')
    expect(discover).toContain('href="/dashboard/profile"')
  })
})
