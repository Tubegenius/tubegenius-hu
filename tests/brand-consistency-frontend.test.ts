import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const approvedMomentumPath = 'M12 31 L30 73 L49 49 L64 65 L89 22'
const approvedImpulsePath = 'M82.5 33.2 L89 22'

function source(...segments: string[]) {
  return readFileSync(join(process.cwd(), ...segments), 'utf8')
}

describe('WillViral approved brand contract', () => {
  it('uses the locked Momentum W geometry in the shared component and every public mark', () => {
    const files = [
      source('components', 'brand', 'Logo.tsx'),
      source('public', 'brand', 'logo-primary.svg'),
      source('public', 'brand', 'logo-icon.svg'),
      source('public', 'brand', 'favicon.svg'),
      source('public', 'brand', 'logo-monochrome-white.svg'),
    ]

    for (const file of files) expect(file).toContain(approvedMomentumPath)
    for (const file of files.slice(0, 4)) expect(file).toContain(approvedImpulsePath)
  })

  it('keeps the approved signal, evidence and paper colors in the branded mark', () => {
    const logo = source('components', 'brand', 'Logo.tsx')
    expect(logo).toContain('#C8F135')
    expect(logo).toContain('#49CAD2')
    expect(logo).toContain('#F2F0E8')
    expect(logo).toContain("Will<span style={{ color: '#C8F135' }}>Viral</span>")
  })

  it('uses the shared logo and Creator Intelligence OS identity on authentication screens', () => {
    const authLayout = source('app', 'auth', 'layout.tsx')
    expect(authLayout).toContain("import Logo from '@/components/brand/Logo'")
    expect(authLayout).toContain('<Logo variant="full" size="lg" />')
    expect(authLayout).toContain('Creator Intelligence OS')
    expect(authLayout).not.toMatch(/bg-violet|124,92,252|>W<\/span>/)
  })

  it('scopes the approved palette, spatial depth and reduced motion to the auth shell', () => {
    const css = source('app', 'globals.css')
    expect(css).toContain('.wv-auth-shell')
    expect(css).toContain('--wv-auth-lime: #c8f135')
    expect(css).toContain('--wv-auth-cyan: #49cad2')
    expect(css).toContain('box-shadow: 0 28px 62px')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
  })
})
