// PFM-2E — statikus forrás-ellenőrzések a kliensoldali cache_only hívókra.
//
// SCOPE, EXPLICITEN KIMONDVA: ennek a repónak nincs jsdom/React Testing
// Library harnessa (vitest.config.ts environment: 'node', include csak
// tests/**/*.test.ts), és a package.json/package-lock.json módosítása
// kifejezetten TILOS ebben a körben (QA-kapu) — ezért nem tudunk valódi
// React-rendereléssel bizonyító kliens-komponens tesztet írni új
// dependency (pl. @testing-library/react, jsdom) hozzáadása nélkül.
//
// Emiatt ez a fájl — a meglévő
// tests/opportunity-route-emerging-signal-regression.test.ts "statikus
// forrás-ellenőrzés" mintáját követve — forrásszöveg-alapú, szerkezeti
// bizonyítékot ad arra, hogy a PFM-2E döntés #1 (nincs automatikus
// cache_only → friss keresés átmenet) és a stale_saved_available kliensoldali
// kezelése ténylegesen megszűnt/megvalósult a kódban. Ez NEM helyettesíti a
// tényleges böngészős viselkedés-tesztet — ezt a korlátot a végső jelentés is
// külön rögzíti.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

function readSource(relativePath: string): string {
  // \r\n -> \n normalizálás — a working tree line-endingje a git core.autocrlf
  // beállítástól függően CRLF is lehet (Windows checkout), a lenti tesztek
  // viszont LF-alapú, többsoros literál mintákat keresnek a forrásban.
  return readFileSync(join(process.cwd(), ...relativePath.split('/')), 'utf-8').replace(/\r\n/g, '\n')
}

// Csak a tényleges kódsorokat adja vissza — a magyarázó megjegyzések
// szándékosan említhetik régi függvénynevet (pl. a levált hiba dokumentálásához),
// ez nem szabad, hogy egy naiv "not.toContain" ellenőrzést tévesen elbuktasson.
function stripComments(block: string): string {
  return block.split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
}

describe('DashboardClient.tsx — no automatic cache_only -> real search transition', () => {
  const src = readSource('components/dashboard/DashboardClient.tsx')

  it('does NOT contain the removed automatic fallback call (recursive loadOpportunities(false, false))', () => {
    expect(src).not.toMatch(/loadOpportunities\(false,\s*false\)/)
  })

  it('the cacheOnly-empty branch returns without issuing a second fetch', () => {
    const idx = src.indexOf('if (cacheOnly && allTopics.length === 0)')
    expect(idx).toBeGreaterThan(-1)
    const blockEnd = src.indexOf('\n      }\n', idx)
    const block = src.slice(idx, blockEnd)
    expect(block).toContain('return')
    expect(block).not.toContain('fetch(')
    expect(block).not.toContain('loadOpportunities(')
  })

  it('the cacheOnly-empty branch surfaces a distinct message for BOTH stale sources (paid_results and opportunity_cache)', () => {
    const idx = src.indexOf('if (cacheOnly && allTopics.length === 0)')
    const blockEnd = src.indexOf('\n      }\n', idx)
    const block = src.slice(idx, blockEnd)
    expect(block).toContain('data.stale_saved_available')
    expect(block).toContain('data.stale_cache_available')
  })
})

describe('DashboardClient.tsx — handleManualRefresh credit-check is fail-closed (PFM-2E correction round)', () => {
  const src = readSource('components/dashboard/DashboardClient.tsx')

  it('imports and uses the extracted, pure checkManualRefreshCredit helper', () => {
    expect(src).toMatch(/import\s*\{\s*checkManualRefreshCredit\s*\}\s*from\s*'@\/lib\/dashboard\/manual-refresh-credit'/)
    expect(src).toContain('await checkManualRefreshCredit()')
  })

  it('handleManualRefresh never calls loadOpportunities anywhere in its ACTUAL CODE (comments documenting the old bug are fine)', () => {
    const declIdx = src.indexOf('async function handleManualRefresh()')
    expect(declIdx).toBeGreaterThan(-1)
    const fnBodyEnd = src.indexOf('\n  async function loadOpportunities(')
    expect(fnBodyEnd).toBeGreaterThan(declIdx)
    const fnBody = src.slice(declIdx, fnBodyEnd)
    // Megjegyzés-sorok kiszűrése — a dokumentáció szándékosan említi a régi,
    // már eltávolított loadOpportunities(false, true) hívást a kontextus kedvéért.
    const codeOnly = fnBody.split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
    expect(codeOnly).not.toMatch(/loadOpportunities\(/)
    expect(codeOnly).not.toMatch(/force_refresh\s*:/)
  })

  it('the !check.ok branch sets a user-facing error message and returns (no credit/search side effects)', () => {
    const checkIdx = src.indexOf('if (!check.ok)')
    expect(checkIdx).toBeGreaterThan(-1)
    const nextBlockIdx = src.indexOf('const balance = check.balance', checkIdx)
    expect(nextBlockIdx).toBeGreaterThan(checkIdx)
    const block = src.slice(checkIdx, nextBlockIdx)
    expect(block).toContain('setOpportunityError(')
    expect(block).toMatch(/return\s*\n\s*\}/)
    expect(block).not.toContain('setCreditCheck(')
  })

  it('a visible error banner renders opportunityError even when a bestTopic is already shown', () => {
    expect(src).toMatch(/\{opportunityError\s*&&\s*bestTopic\s*&&/)
  })

  it('loadOpportunities is only ever invoked from an explicit user action (button/modal), not chained to its own cache_only result', () => {
    // Minden loadOpportunities(...) hívás helye a fájlban — az egyetlen elfogadható
    // hívó a mount-effект (loadOpportunities(true)) és a user-vezérelt gombok/modal
    // (handleManualRefresh, CreditConfirmModal onConfirm) lehetnek, sose maga a
    // loadOpportunities függvénytörzse.
    const declIdx = src.indexOf('async function loadOpportunities(')
    const fnBodyStart = src.indexOf('\n', declIdx) // a deklaráció sorát kihagyjuk, csak a törzset vizsgáljuk
    const fnBodyEnd = src.indexOf('\n  const bestTopic = pickBestTopic(topics)')
    expect(declIdx).toBeGreaterThan(-1)
    expect(fnBodyEnd).toBeGreaterThan(fnBodyStart)
    const fnBody = src.slice(fnBodyStart, fnBodyEnd)
    expect(fnBody).not.toMatch(/loadOpportunities\(/)
  })
})

describe('opportunities/page.tsx — stale/miss states never trigger an automatic search', () => {
  const src = readSource('app/dashboard/opportunities/page.tsx')

  it('openStaleSavedResult() never sends force_refresh (explicit-ID open stays freshness-independent, not a paid refresh)', () => {
    const idx = src.indexOf('async function openStaleSavedResult()')
    expect(idx).toBeGreaterThan(-1)
    const endIdx = src.indexOf('\n  function startFreshSearchFromStale', idx)
    const fnBody = src.slice(idx, endIdx)
    expect(fnBody).not.toContain('force_refresh')
    expect(fnBody).toContain('paidResultId')
  })

  it('the "fresh search" action from the stale/miss banner routes through handleGenerateWithCreditCheck (the credit-check gate) — only reachable via the button\'s onClick, never from the mount effect', () => {
    const idx = src.indexOf('function startFreshSearchFromStale()')
    expect(idx).toBeGreaterThan(-1)
    const endIdx = src.indexOf('\n\n', idx)
    const fnBody = src.slice(idx, endIdx)
    expect(fnBody).toContain('handleGenerateWithCreditCheck')
    // Ez a függvény csak a banner onClick-jéből hívódik, sose az useEffect-ből —
    // ezt a "mount never auto-generates" describe blokk saját tesztjei bizonyítják.
  })

  it('the opportunity_cache-stale and miss kinds never render the paid-result-only "reopen" button', () => {
    const bannerIdx = src.indexOf("staleState.kind === 'saved_paid_result' && (")
    expect(bannerIdx).toBeGreaterThan(-1)
    const block = src.slice(bannerIdx, bannerIdx + 200)
    expect(block).toContain('openStaleSavedResult')
  })

  it('the banner shows a distinct, neutral message for the miss state (never implies a fresh/current recommendation)', () => {
    const idx = src.indexOf("staleState.kind === 'opportunity_cache'")
    expect(idx).toBeGreaterThan(-1)
    const block = src.slice(idx, idx + 200)
    expect(block).toContain('Még nincs validált ajánlásod')
  })
})

describe('opportunities/page.tsx — mount never auto-generates a real search (PFM-2E production incident fix)', () => {
  const src = readSource('app/dashboard/opportunities/page.tsx')

  it('the mount useEffect guards against re-running its body via initRanRef (defense-in-depth against any future double-invoke)', () => {
    const idx = src.indexOf('useEffect(() => {\n    if (initRanRef.current) return\n    initRanRef.current = true')
    expect(idx).toBeGreaterThan(-1)
  })

  it('the ENTIRE mount effect body never calls handleGenerateWithCreditCheck or generate() directly — only tryCacheOnlyLookup', () => {
    const effectIdx = src.indexOf('useEffect(() => {\n    if (initRanRef.current) return')
    expect(effectIdx).toBeGreaterThan(-1)
    const effectEndIdx = src.indexOf('\n  }, [])', effectIdx)
    expect(effectEndIdx).toBeGreaterThan(effectIdx)
    const effectBody = stripComments(src.slice(effectIdx, effectEndIdx))
    expect(effectBody).not.toMatch(/handleGenerateWithCreditCheck/)
    expect(effectBody).not.toMatch(/\bgenerate\(/)
    expect(effectBody.match(/tryCacheOnlyLookup\(/g)?.length).toBe(2) // nicheParam ág + profil-niche ág
  })

  it('tryCacheOnlyLookup always sends cache_only:true, never force_refresh, never calls /api/credit-check', () => {
    const fnIdx = src.indexOf('async function tryCacheOnlyLookup(')
    expect(fnIdx).toBeGreaterThan(-1)
    const fnEndIdx = src.indexOf('\n\n  // Keresési előzmény visszaállítása', fnIdx)
    expect(fnEndIdx).toBeGreaterThan(fnIdx)
    const fnBody = src.slice(fnIdx, fnEndIdx)
    expect(fnBody).toMatch(/cache_only:\s*true/)
    expect(fnBody).not.toContain('force_refresh')
    expect(fnBody).not.toContain('/api/credit-check')
  })

  it('tryCacheOnlyLookup sets a "miss" staleState instead of ever falling through to a real search when nothing is found', () => {
    const fnIdx = src.indexOf('async function tryCacheOnlyLookup(')
    const fnEndIdx = src.indexOf('\n\n  // Keresési előzmény visszaállítása', fnIdx)
    const fnBody = src.slice(fnIdx, fnEndIdx)
    expect(fnBody).toMatch(/setStaleState\(\{\s*kind:\s*'miss'/)
  })

  it('the nicheParam mount branch calls tryCacheOnlyLookup and nothing else — no inline fetch, no auto-generate fallback', () => {
    const idx = src.indexOf('if (nicheParam) {')
    expect(idx).toBeGreaterThan(-1)
    const block = src.slice(idx, idx + 250)
    expect(block).toContain('tryCacheOnlyLookup(nicheParam')
    expect(block).not.toContain('handleGenerateWithCreditCheck')
    expect(block).not.toContain("fetch('/api/opportunity'")
  })

  it('the profile-niche (no nicheParam) mount branch — the EXACT branch that caused the production incident — only calls tryCacheOnlyLookup', () => {
    const idx = src.indexOf('if (prof?.niche) {')
    expect(idx).toBeGreaterThan(-1)
    const block = stripComments(src.slice(idx, idx + 900))
    expect(block).toContain('tryCacheOnlyLookup(prof.niche')
    expect(block).not.toContain('handleGenerateWithCreditCheck')
  })

  it('generate() has a re-entrancy guard (generateInFlightRef) preventing overlapping/duplicate POSTs from any caller', () => {
    const fnIdx = src.indexOf('async function generate(')
    expect(fnIdx).toBeGreaterThan(-1)
    const nearby = stripComments(src.slice(fnIdx, fnIdx + 900))
    expect(nearby).toMatch(/if\s*\(generateInFlightRef\.current\)\s*return/)
    expect(nearby).toContain('generateInFlightRef.current = true')
  })

  it('generate() always resets generateInFlightRef in a finally block (never stays locked after completion or error)', () => {
    const fnIdx = src.indexOf('async function generate(')
    const fnEndIdx = src.indexOf('\n\n  // Korábbi (lejárt) mentett paid_results', fnIdx)
    expect(fnEndIdx).toBeGreaterThan(fnIdx)
    const fnBody = src.slice(fnIdx, fnEndIdx)
    expect(fnBody).toMatch(/finally\s*\{[^}]*generateInFlightRef\.current = false/)
  })
})

describe('TopOpportunitiesRow.tsx — single fetch, no retry/fallback chain', () => {
  const src = readSource('components/dashboard/TopOpportunitiesRow.tsx')

  it('issues exactly one fetch call in the mount effect (no chained/nested second request)', () => {
    const matches = [...src.matchAll(/fetch\(/g)]
    expect(matches.length).toBe(1)
  })

  it('always sends cache_only: true (never escalates to a real search from this widget)', () => {
    expect(src).toMatch(/cache_only:\s*true/)
    expect(src).not.toMatch(/cache_only:\s*false/)
    expect(src).not.toMatch(/force_refresh/)
  })

  it('provides a CTA link to the Opportunities page from the empty state', () => {
    const emptyStateIdx = src.indexOf("Még nincs friss, validált találat")
    expect(emptyStateIdx).toBeGreaterThan(-1)
    const nearby = src.slice(emptyStateIdx, emptyStateIdx + 400)
    expect(nearby).toContain('/dashboard/opportunities')
  })
})
