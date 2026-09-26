import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  auditCreditMutationResponse,
  CREDIT_MUTATION_RESPONSE_CONTRACTS,
} from '@/lib/credit-balance-events'
import { CREATOR_CREDIT_COSTS, CREATOR_SEARCH_ALLOWANCES } from '@/lib/creator-credit-catalog'

const root = process.cwd()
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')

describe('credit visibility and billing clarity contract', () => {
  it('keeps the visible fixed costs aligned with the server source without importing it into the client', () => {
    const serverSource = read('lib/credits.ts')
    for (const item of CREATOR_CREDIT_COSTS) {
      expect(serverSource).toMatch(new RegExp(`${item.key}:\\s*${item.cost}(?:\\D|$)`))
      expect(fs.existsSync(path.join(root, 'app', item.route.replace('/dashboard/', 'dashboard/'), 'page.tsx')) || item.route === '/dashboard').toBe(true)
    }
    expect(CREATOR_SEARCH_ALLOWANCES).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'opportunity_weekly', paid: expect.stringContaining('2 kredit') }),
      expect.objectContaining({ key: 'market_evidence_daily', paid: expect.stringContaining('1 kredit') }),
    ]))
  })

  it('audits route response fields but never turns missing or invalid fields into an estimated balance', () => {
    expect(Object.keys(CREDIT_MUTATION_RESPONSE_CONTRACTS)).toEqual(expect.arrayContaining([
      '/api/video-package',
      '/api/video-audit',
      '/api/opportunity',
      '/api/similar-videos',
    ]))
    expect(auditCreditMutationResponse('/api/video-package', { _credits_remaining: 8.5 }).declaredBalance).toBe(8.5)
    expect(auditCreditMutationResponse('/api/video-package', { _credits_remaining: '8.5' }).declaredBalance).toBeNull()
    expect(auditCreditMutationResponse('/api/video-audit', { creditCost: 4 }).declaredBalance).toBeNull()
    expect(auditCreditMutationResponse('/api/youtube/discover-niche', { charged: false }).charged).toBe(false)
  })

  it('uses one shared /api/credits state in the active dashboard shell', () => {
    const layout = read('app/dashboard/layout.tsx')
    const shell = read('components/dashboard/CreatorOSShell.tsx')
    const page = read('app/dashboard/credits/page.tsx')
    const provider = read('components/credits/CreditBalanceContext.tsx')

    expect(layout).toContain('<CreditBalanceProvider key={user.id}>')
    expect(shell).toContain('<CreditBalanceIndicator />')
    expect(page).toContain('useCreditBalance()')
    expect(page).not.toContain("fetch('/api/credits')")
    expect(provider).toContain('fetchCreditBalance')
    expect(provider).toContain("CREDIT_MUTATION_COMPLETED_EVENT")
  })

  it('isolates balance state by authenticated user and invalidates pending reads on logout', () => {
    const layout = read('app/dashboard/layout.tsx')
    const provider = read('components/credits/CreditBalanceContext.tsx')

    expect(layout).toContain('<CreditBalanceProvider key={user.id}>')
    expect(provider).toContain('useState<CreditBalance | null>(null)')
    expect(provider).toContain('mountedRef.current = false')
    expect(provider).toContain('coordinatorRef.current.abort()')
  })

  it('ends the protected tree with the session: hard logout, shared 401 handling, guard, hidden shell', () => {
    const layout = read('app/dashboard/layout.tsx')
    const shell = read('components/dashboard/CreatorOSShell.tsx')
    const provider = read('components/credits/CreditBalanceContext.tsx')
    const indicator = read('components/credits/CreditBalanceIndicator.tsx')
    const guard = read('components/auth/AuthSessionGuard.tsx')
    const events = read('lib/auth-session-events.ts')
    const css = read('app/dashboard/creator-os.css')

    // logout is a HARD navigation: router.push('/auth/login') left the Router Cache tree restorable via Back
    expect(shell).toContain("endAuthSession('logout')")
    // only a SUCCESSFUL signOut ends the session; an error or exception must not present it as ended
    expect(shell).toContain('signedOut = error === null')
    expect(shell.indexOf("setLogoutState('failed')")).toBeGreaterThan(-1)
    expect(shell.indexOf("setLogoutState('failed')")).toBeLessThan(shell.indexOf("endAuthSession('logout')"))
    expect(shell).not.toContain('finally') // no unconditional session end after a failed signOut
    expect(shell).toContain("if (logoutState === 'pending') return")
    expect(shell).toContain('role="alert"')
    expect(shell).not.toContain('scope:') // the global sign-out scope (default) is unchanged
    expect(shell).not.toContain("router.push('/auth/login')")
    expect(events).toContain('window.location.replace(LOGIN_PATH)')
    // the guard sits inside the credit provider, keyed by the same authenticated user
    expect(layout.indexOf('<CreditBalanceProvider key={user.id}>')).toBeLessThan(layout.indexOf('<AuthSessionGuard />'))
    expect(guard).toContain("event === 'SIGNED_OUT'")
    expect(guard).toContain('armAuthSessionEnd()')
    expect(guard).toContain('rearmAuthSessionEnd()')
    expect(events).toContain('if (endAnnounced) return')
    expect(events).toContain('if (leaveRequested) return')
    expect(guard).toContain('event.persisted')
    expect(guard).toContain("window.addEventListener('popstate', revalidate)")
    expect(guard).toContain('refreshCredits({ supersede: true })')
    expect(read('app/auth/layout.tsx')).toContain('<StaleSessionDocumentPurge />')
    expect(read('components/auth/StaleSessionDocumentPurge.tsx')).toContain('window.location.reload()')
    // shared credit state: a 401 or the session-ended event clears the balance, never keeps it
    expect(provider).toContain('CreditBalanceUnauthorizedError')
    expect(provider).toContain('AUTH_SESSION_ENDED_EVENT')
    expect(provider).toContain('setCredits(null)')
    expect(provider).toContain("setStatus('signed-out')")
    expect(indicator).toContain("status === 'signed-out'")
    // the stale shell is hidden until the navigation completes
    expect(css).toContain("html[data-wv-session='ended'] .wv-shell { visibility: hidden; }")
  })

  it('keeps balance read failures distinct from real zero and from successful product results', () => {
    const provider = read('components/credits/CreditBalanceContext.tsx')
    const indicator = read('components/credits/CreditBalanceIndicator.tsx')
    const videoPackage = read('app/dashboard/video-package/page.tsx')
    const mutationResultIndex = videoPackage.indexOf('setResult(data)')
    const reconciliationIndex = videoPackage.indexOf("publishCreditMutationCompleted('/api/video-package', data)")

    expect(provider).toContain("setStatus('error')")
    expect(provider).not.toMatch(/catch\s*\{[\s\S]{0,220}setCredits\([^)]*0/)
    expect(indicator).toContain("status === 'error'")
    expect(indicator).toContain("'Nem elérhető'")
    expect(indicator).not.toContain("status === 'error' ? '0")
    expect(mutationResultIndex).toBeGreaterThan(-1)
    expect(reconciliationIndex).toBeGreaterThan(mutationResultIndex)
    expect(provider).toContain('const reconcile = () => { void refreshCredits({ supersede: true }) }')
  })

  it('does not add unverified rollover, expiry, cancellation, or Stripe-price promises', () => {
    const creditsDiff = read('app/dashboard/credits/page.tsx')
    const catalog = read('lib/creator-credit-catalog.ts')
    const newBillingCopy = `${catalog}\n${creditsDiff.match(/wv-credit-allowance-note[\s\S]*?<\/p>/)?.[0] ?? ''}`

    expect(newBillingCopy).not.toMatch(/rollover|átvitel|átvihető|lejárati idő|garantált ár|árgarancia/i)
    expect(newBillingCopy).toContain('napi kerete ajánlott költési határ')
    expect(newBillingCopy).toContain('külön megerősítés szükséges')
  })

  it('reconciles every active credit-capable Premium route through the authoritative balance read', () => {
    const expected: Record<string, string> = {
      'app/dashboard/channel-audit/page.tsx': '/api/channel-audit',
      'app/dashboard/video-audit/page.tsx': '/api/video-audit',
      'app/dashboard/video-package/page.tsx': '/api/video-package',
      'app/dashboard/title-studio/page.tsx': '/api/title-studio',
      'app/dashboard/thumbnail-studio/page.tsx': '/api/thumbnail-studio',
      'app/dashboard/seo-optimizer/page.tsx': '/api/seo-optimizer',
      'app/dashboard/profile/page.tsx': '/api/youtube/discover-niche',
      'components/dashboard/TrackedTrendsPanel.tsx': '/api/dashboard/tracked-trends/deep-refresh',
    }
    for (const [file, route] of Object.entries(expected)) {
      expect(read(file)).toContain(`publishCreditMutationCompleted('${route}'`)
    }
  })

  it('does not import server credit/admin modules into client-visible credit code', () => {
    const clientFiles = [
      'lib/creator-credit-catalog.ts',
      'lib/credit-balance-client.ts',
      'components/credits/CreditBalanceContext.tsx',
      'components/credits/CreditBalanceIndicator.tsx',
      'app/dashboard/credits/page.tsx',
    ]
    for (const file of clientFiles) {
      const source = read(file)
      expect(source).not.toMatch(/from ['"]@\/lib\/(credits|supabase-server)['"]/)
      expect(source).not.toContain('SUPABASE_SERVICE_ROLE_KEY')
    }
  })
})
