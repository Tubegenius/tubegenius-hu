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
