import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { lifecycleListError } from '@/lib/lifecycle-review-presentation'
import { lifecycleDetailError } from '@/lib/lifecycle-review-detail-presentation'
import { lifecycleDecisionSubmitError } from '@/lib/lifecycle-review-decision-presentation'
import { lifecycleCancelSubmitError } from '@/lib/lifecycle-review-cancel-presentation'
import {
  CAPABILITY_GATED_REVIEWER_ROUTES,
  PREMIUM_CREATOR_OS_RELEASE_ROUTES,
  PRESERVED_LEGACY_TOOL_ROUTES,
} from '@/lib/creator-os-release-routes'

function source(...segments: string[]) {
  return readFileSync(join(process.cwd(), ...segments), 'utf8')
}

describe('Premium Frontend production truthfulness and accessibility closure', () => {
  it('keeps runtime creator surfaces free of the removed demo datasets and persistent-action promises', () => {
    const runtime = [
      source('components', 'dashboard', 'PremiumToday.tsx'),
      source('components', 'dashboard', 'CreatorDiscover.tsx'),
      source('components', 'dashboard', 'CreatorWorkspace.tsx'),
      source('components', 'dashboard', 'CreatorGrowth.tsx'),
      source('components', 'dashboard', 'CreatorOSShell.tsx'),
    ].join('\n')

    expect(runtime).not.toMatch(/Aktív mintaprojekt|Szemléltető nemzetközi profilok|CREATOR_OPPORTUNITIES|CREATOR_GROWTH_PRESENTATION/)
    expect(runtime).not.toMatch(/Mentés a könyvtárba|Projektvázlat indítása|Új állítás|Élménypont hozzáadása|Ritmus előnézete/)
    expect(runtime).not.toMatch(/Városi lombkorona|felszíni hőmérséklet|lakásnézés/)
  })

  it('never exposes an arbitrary backend error through lifecycle or Memory presentation', () => {
    const malicious = 'sk_live_sensitive postgres://private.internal reviewer@example.com'
    const mapped = [
      lifecycleListError(422, malicious).message,
      lifecycleDetailError(422, malicious).message,
      lifecycleDecisionSubmitError(422, malicious).message,
      lifecycleCancelSubmitError(422, malicious).message,
    ].join(' ')

    expect(mapped).not.toContain(malicious)
    expect(mapped).not.toMatch(/sk_live|postgres:\/\/|reviewer@example\.com/)

    const memory = source('app', 'dashboard', 'memory', 'page.tsx')
    expect(memory).not.toMatch(/error instanceof Error \? error\.message|set(?:LoadError|StatusMessage)\(error\.message/)
  })

  it('turns the Workspace source surface into a labelled modal drawer with complete focus containment', () => {
    const workspace = source('components', 'dashboard', 'CreatorWorkspace.tsx')
    const css = source('app', 'dashboard', 'creator-os.css')

    expect(workspace).toContain('useFocusTrap(onClose, returnFocusRef)')
    expect(workspace).toContain('role="dialog"')
    expect(workspace).toContain('aria-modal="true"')
    expect(workspace).toContain('aria-labelledby="wv-source-drawer-title"')
    expect(workspace).toContain("document.body.style.overflow = 'hidden'")
    expect(workspace).toContain("main?.setAttribute('inert', '')")
    expect(css).toContain('.wv-source-layer')
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.wv-source-drawer/)
  })

  it('keeps Premium, reviewer and preserved legacy routes in explicit non-overlapping sets', () => {
    const premium = new Set(PREMIUM_CREATOR_OS_RELEASE_ROUTES)
    const reviewer = new Set(CAPABILITY_GATED_REVIEWER_ROUTES)

    for (const route of PRESERVED_LEGACY_TOOL_ROUTES) {
      expect(premium.has(route as never)).toBe(false)
      expect(reviewer.has(route as never)).toBe(false)
    }
    for (const route of CAPABILITY_GATED_REVIEWER_ROUTES) {
      expect(premium.has(route as never)).toBe(false)
    }

    const newWorkflow = [
      source('components', 'dashboard', 'PremiumToday.tsx'),
      source('components', 'dashboard', 'CreatorDiscover.tsx'),
      source('components', 'dashboard', 'CreatorWorkspace.tsx'),
      source('components', 'dashboard', 'CreatorGrowth.tsx'),
    ].join('\n')
    for (const route of PRESERVED_LEGACY_TOOL_ROUTES) expect(newWorkflow).not.toContain(`href="${route}"`)
  })

  it('moves keyboard focus into the account menu only after the menu is mounted', () => {
    const shell = source('components', 'dashboard', 'CreatorOSShell.tsx')

    expect(shell).toContain("const pendingMenuFocusRef = useRef<'first' | 'last' | null>(null)")
    expect(shell).toContain('if (!menuOpen || !pendingMenuFocusRef.current) return')
    expect(shell).toContain("items[edge === 'first' ? 0 : items.length - 1].focus()")
    expect(shell).toContain("pendingMenuFocusRef.current = event.key === 'ArrowDown' ? 'first' : 'last'")
    expect(shell).not.toContain("setMenuOpen(true)\n              focusMenuEdge")
  })
})
