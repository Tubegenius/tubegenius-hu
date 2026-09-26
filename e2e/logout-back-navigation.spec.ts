// PR #7 Logout/Back Navigation Remediation Gate.
// Real-browser (Edge) reproduction + regression for: login -> credits page -> logout -> browser Back
// must never re-show the previous user's credit balance or account data, and a user switch
// must never surface the previous user's state. Local Supabase + disposable users only.
//
// Projects: 'edge' (Playwright default, bfcache disabled) and 'edge-bfcache' (bfcache enabled,
// like a real browser). WV_E2E_PROD=1 runs the same specs against `next build && next start`.
import { test, expect, type Page, type BrowserContext, type Request as PwRequest } from '@playwright/test'
import { createTestUser, deleteTestUser, type TestUser } from './support/auth'
import { assertLocalStackAvailable, seedOnboardedProfile, setSubscriptionBalance, cleanupUserRows } from './support/credit-fixtures'

const RUN = `lbn-${Date.now()}`
const A_NAME = 'AlphaQaChannel'
const B_NAME = 'BetaQaChannel'

// Next 15 dev-server-only warning about the sync `cookies()` API in lib/supabase-server.ts (pre-existing,
// unrelated to this gate, never emitted by a production build). Every other console line still fails the run.
const KNOWN_DEV_ONLY = /Server\s+Error: Route .* used .*cookies\(\)/

async function login(page: Page, u: TestUser): Promise<void> {
  await page.goto('/auth/login')
  await page.getByPlaceholder('te@example.com').fill(u.email)
  await page.getByPlaceholder('••••••••').fill(u.password)
  await page.getByRole('button', { name: 'Belépés' }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 60_000 })
}

async function logout(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Fiókmenü megnyitása' }).click()
  await page.getByRole('menuitem', { name: 'Kijelentkezés' }).click()
  await expect(page).toHaveURL(/\/auth\/login/, { timeout: 30_000 })
}

// Strict navigation watch for ONE logout: exactly one document request to the login page and no
// aborted document navigation (a double navigation makes the first one fail with ERR_ABORTED).
function watchLoginNavigation(page: Page) {
  const loginDocs: string[] = []
  const failedDocs: string[] = []
  const onRequest = (r: PwRequest) => {
    if (r.resourceType() === 'document' && new URL(r.url()).pathname === '/auth/login') loginDocs.push(r.url())
  }
  const onFailed = (r: PwRequest) => {
    if (r.resourceType() === 'document') failedDocs.push(`${new URL(r.url()).pathname} ${r.failure()?.errorText ?? ''}`)
  }
  page.on('request', onRequest)
  page.on('requestfailed', onFailed)
  return {
    async expectExactlyOneNavigation(): Promise<void> {
      await expect(page).toHaveURL(/\/auth\/login/, { timeout: 30_000 })
      await page.waitForTimeout(2500) // a second navigation or a redirect loop would surface here
      page.off('request', onRequest)
      page.off('requestfailed', onFailed)
      expect(loginDocs, 'exactly one login document request').toHaveLength(1)
      expect(failedDocs, 'no aborted document navigation (no double navigation)').toEqual([])
    },
  }
}

async function logoutStrict(page: Page): Promise<void> {
  const nav = watchLoginNavigation(page)
  await page.getByRole('button', { name: 'Fiókmenü megnyitása' }).click()
  await page.getByRole('menuitem', { name: 'Kijelentkezés' }).click()
  await nav.expectExactlyOneNavigation()
}

async function pill(page: Page): Promise<string | null> {
  const el = page.locator('a.wv-credit-indicator')
  return (await el.count()) ? el.first().getAttribute('aria-label') : null
}

// Everything a "previous user's state" could leak through: visible text AND the serialized DOM
// (including the Next RSC payload scripts) -- not just whether a pill is shown. The credit-hero
// number is read separately: the plan cards legitimately contain the static text "50 kredit".
async function leakReport(page: Page, needles: string[]) {
  return page.evaluate((ns) => {
    const html = document.documentElement.outerHTML
    const text = document.body.innerText
    return {
      url: location.pathname,
      pills: [...document.querySelectorAll('a.wv-credit-indicator')].map((a) => a.getAttribute('aria-label')),
      heroNumber: document.querySelector('.wv-credit-balance-number strong')?.textContent ?? null,
      shellVisible: !!document.querySelector('.wv-shell') && getComputedStyle(document.querySelector('.wv-shell') as Element).visibility !== 'hidden',
      needlesInHtml: ns.filter((n) => html.includes(n)),
      needlesInText: ns.filter((n) => text.includes(n)),
      loginFormVisible: !!document.querySelector('input[type="password"]'),
      dbg: sessionStorage.getItem('__wv_dbg'),
    }
  }, needles)
}

async function instrument(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const push = (e: string) => {
      try {
        const cur = JSON.parse(sessionStorage.getItem('__wv_dbg') || '[]')
        cur.push(`${Math.round(performance.now())}:${location.pathname}:${e}`)
        sessionStorage.setItem('__wv_dbg', JSON.stringify(cur.slice(-60)))
      } catch { /* ignore */ }
    }
    window.addEventListener('pageshow', (ev) => push(`pageshow persisted=${(ev as PageTransitionEvent).persisted}`))
    window.addEventListener('pagehide', (ev) => push(`pagehide persisted=${(ev as PageTransitionEvent).persisted}`))
    window.addEventListener('popstate', () => push('popstate'))
    const of = window.fetch
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const u = typeof args[0] === 'string' ? args[0] : (args[0] as Request).url
      const tracked = /\/api\/credits/.test(u)
      try {
        const r = await of(...args)
        if (tracked) push(`fetch ${u} -> ${r.status}`)
        return r
      } catch (e) {
        if (tracked) push(`fetch ${u} -> ERR`)
        throw e
      }
    }
  })
}

function attachConsole(page: Page, sink: string[]): void {
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) sink.push(`${m.type()}: ${m.text().slice(0, 240)}`) })
  page.on('pageerror', (e) => sink.push(`pageerror: ${String(e).slice(0, 240)}`))
  // Name the resource behind every "Failed to load resource" line (path only, never query strings).
  page.on('response', (r) => { if (r.status() >= 400) sink.push(`http ${r.status()} ${r.request().resourceType()} ${new URL(r.url()).pathname}`) })
}

function unexpected(sink: string[]): string[] {
  return sink.filter((l) => !KNOWN_DEV_ONLY.test(l))
}

let userA: TestUser
let userB: TestUser

test.beforeAll(async () => {
  assertLocalStackAvailable()
  userA = await createTestUser(`${RUN}-a`)
  userB = await createTestUser(`${RUN}-b`)
  seedOnboardedProfile(userA.id, A_NAME)
  seedOnboardedProfile(userB.id, B_NAME)
  setSubscriptionBalance(userB.id, 137)
})

test.afterAll(async () => {
  cleanupUserRows([userA.id, userB.id])
  await deleteTestUser(userA.id)
  await deleteTestUser(userB.id)
})

test.describe('logout -> Back', () => {
  const mode = { toString: () => test.info().project.name }

  async function toCredits(page: Page, balance: RegExp) {
    await expect(page.locator('a.wv-credit-indicator')).toHaveAttribute('aria-label', balance, { timeout: 60_000 })
    await page.locator('a.wv-credit-indicator').click()
    await expect(page).toHaveURL(/\/dashboard\/credits/)
  }

  test('the previous balance and account data do not reappear after logout + Back', async ({ page, context }) => {
    test.setTimeout(240_000)
    const consoleSink: string[] = []
    await instrument(context)
    attachConsole(page, consoleSink)
    const headers: string[] = []
    page.on('response', (r) => {
      if (r.request().resourceType() === 'document' && r.url().includes('/dashboard')) headers.push(`${new URL(r.url()).pathname} cache-control=${r.headers()['cache-control'] ?? '(none)'}`)
    })

    await login(page, userA)
    await toCredits(page, /50 kredit/)
    await expect(page.locator('.wv-credit-balance-number strong')).toHaveText('50', { timeout: 60_000 })

    await logoutStrict(page)
    await page.goBack()
    await page.waitForTimeout(2500)

    const rep = await leakReport(page, [A_NAME, userA.email])
    console.log(`[${mode}] after-Back report: ${JSON.stringify(rep)}`)
    console.log(`[${mode}] document cache-control: ${JSON.stringify(headers)}`)
    console.log(`[${mode}] console: ${JSON.stringify(consoleSink)}`)

    expect(rep.url, 'Back from the logged-out state ends on the login page').toBe('/auth/login')
    expect(rep.pills, 'no credit pill after logout + Back').toEqual([])
    expect(rep.heroNumber).toBeNull()
    expect(rep.shellVisible).toBe(false)
    expect(rep.needlesInText, 'no previous-user data in visible text').toEqual([])
    expect(rep.needlesInHtml, 'no previous-user data in the serialized DOM').toEqual([])
    expect(consoleSink.filter((l) => l.startsWith('pageerror')), 'no uncaught page errors').toEqual([])
  })

  test('user switch: B never sees A after A logs out, B logs in and presses Back', async ({ page, context }) => {
    test.setTimeout(240_000)
    await instrument(context)
    await login(page, userA)
    await toCredits(page, /50 kredit/)
    await logoutStrict(page)

    await login(page, userB)
    await expect(page.locator('a.wv-credit-indicator')).toHaveAttribute('aria-label', /137 kredit/, { timeout: 60_000 })
    const own = await leakReport(page, [A_NAME, userA.email])
    expect(own.needlesInHtml, 'B session at /dashboard carries no A data').toEqual([])

    await page.goBack()
    await page.waitForTimeout(2500)
    const back = await leakReport(page, [A_NAME, userA.email])
    console.log(`[${mode}] B after Back: ${JSON.stringify(back)}`)
    expect(back.needlesInText, 'no A data in visible text for B').toEqual([])
    expect(back.needlesInHtml, 'no A data in serialized DOM for B').toEqual([])
    for (const p of back.pills) expect(p, 'B never sees the 50 of A').not.toMatch(/(^|[^\d])50 kredit/)
    if (back.heroNumber !== null) expect(back.heroNumber).not.toBe('50')
  })

  test('a later, new session (B) is closed properly after A was closed: one navigation, nothing of A or B after Back', async ({ page, context }) => {
    test.setTimeout(240_000)
    await instrument(context)
    await login(page, userA)
    await toCredits(page, /50 kredit/)
    await logoutStrict(page)

    await login(page, userB)
    await toCredits(page, /137 kredit/)
    await logoutStrict(page)
    await page.goBack()
    await page.waitForTimeout(2500)
    const rep = await leakReport(page, [A_NAME, userA.email, B_NAME, userB.email])
    console.log(`[${mode}] B after own logout + Back: ${JSON.stringify(rep)}`)
    expect(rep.url).toBe('/auth/login')
    expect(rep.pills).toEqual([])
    expect(rep.heroNumber).toBeNull()
    expect(rep.needlesInText).toEqual([])
    expect(rep.needlesInHtml).toEqual([])
    expect((await context.cookies()).filter((k) => k.name.startsWith('sb-')).length).toBe(0)
  })

  test('session ended without a logout click: the Router Cache restore (soft Back) is ended by the shared state', async ({ page, context }) => {
    test.setTimeout(240_000)
    await instrument(context)
    await login(page, userA)
    await toCredits(page, /50 kredit/)
    // The session disappears (expiry / revoked elsewhere) while the protected tree stays cached client-side.
    await context.clearCookies()
    await page.goBack() // soft popstate to the cached /dashboard entry
    await page.waitForURL(/\/auth\/login/, { timeout: 30_000 }).catch(async (e) => {
      console.log(`[${mode}] STUCK after soft Back: ${JSON.stringify(await leakReport(page, [A_NAME, userA.email]))}`)
      throw e
    })
    // The auth page purges a stale protected document with one reload; wait for that to settle.
    await expect.poll(async () => (await leakReport(page, [A_NAME, userA.email])).needlesInHtml, { timeout: 30_000 }).toEqual([])
    const rep = await leakReport(page, [A_NAME, userA.email])
    console.log(`[${mode}] session-ended soft Back: ${JSON.stringify(rep)}`)
    expect(rep.url).toBe('/auth/login')
    expect(rep.pills).toEqual([])
    expect(rep.loginFormVisible).toBe(true)
  })

  test('bfcache-style restore (pageshow persisted) revalidates the session instead of trusting the frozen page', async ({ page, context }) => {
    test.setTimeout(240_000)
    await instrument(context)
    await login(page, userA)
    await toCredits(page, /50 kredit/)
    await context.clearCookies()
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
    await page.waitForURL(/\/auth\/login/, { timeout: 30_000 })
    const rep = await leakReport(page, [A_NAME, userA.email])
    expect(rep.pills).toEqual([])
    expect(rep.needlesInHtml).toEqual([])
  })

  test('a second tab that logs out ends the first tab (shared auth state)', async ({ page, context }) => {
    test.setTimeout(240_000)
    await login(page, userA)
    await toCredits(page, /50 kredit/)
    const second = await context.newPage()
    await second.goto('/dashboard')
    await expect(second.locator('a.wv-credit-indicator')).toBeVisible({ timeout: 60_000 })
    await logout(second)
    await page.waitForURL(/\/auth\/login/, { timeout: 30_000 })
    const rep = await leakReport(page, [A_NAME, userA.email])
    expect(rep.pills).toEqual([])
    expect(rep.needlesInHtml).toEqual([])
  })
})

test.describe('session-check failure semantics and no request/redirect loops', () => {
  async function toCredits(page: Page) {
    await expect(page.locator('a.wv-credit-indicator')).toHaveAttribute('aria-label', /50 kredit/, { timeout: 60_000 })
    await page.locator('a.wv-credit-indicator').click()
    await expect(page).toHaveURL(/\/dashboard\/credits/)
  }

  function counters(page: Page) {
    const c = { credits: 0, loginDocs: 0 }
    page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/credits') c.credits += 1 })
    // One document REQUEST per navigation to the login page (framenavigated fires twice per navigation).
    page.on('request', (r) => { if (r.resourceType() === 'document' && new URL(r.url()).pathname === '/auth/login') c.loginDocs += 1 })
    return c
  }

  test('a 500 or a network failure of the session check is NOT a sign-out; only 401 is', async ({ page }) => {
    test.setTimeout(240_000)
    let mode: 'ok' | '500' | 'abort' = 'ok'
    await page.route('**/api/credits', async (route) => {
      if (mode === '500') return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' })
      if (mode === 'abort') return route.abort('failed')
      return route.continue()
    })
    await login(page, userA)
    await toCredits(page)

    for (const failing of ['500', 'abort'] as const) {
      mode = failing
      await page.goBack() // popstate -> revalidation hits the failing endpoint
      await expect(page.locator('a.wv-credit-indicator')).toHaveAttribute('aria-label', /nem elérhető/, { timeout: 30_000 })
      await page.waitForTimeout(1500)
      expect(new URL(page.url()).pathname, `${failing}: still on the protected page`).toBe('/dashboard')
      expect(await page.locator('.wv-shell').isVisible(), `${failing}: shell still shown`).toBe(true)
      expect(await page.evaluate(() => document.documentElement.getAttribute('data-wv-session')), `${failing}: not marked ended`).toBeNull()
      mode = 'ok'
      await page.goForward()
      await expect(page).toHaveURL(/\/dashboard\/credits/)
    }
  })

  test('a 401 of the session check ends the session exactly once (no request or redirect loop)', async ({ page }) => {
    test.setTimeout(240_000)
    const c = counters(page)
    let unauthorized = false
    await page.route('**/api/credits', async (route) => {
      if (unauthorized) return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Nem vagy bejelentkezve"}' })
      return route.continue()
    })
    await login(page, userA)
    await toCredits(page)
    unauthorized = true
    const before = { ...c }
    await page.goBack()
    await page.waitForURL(/\/auth\/login/, { timeout: 30_000 })
    await page.waitForTimeout(4000) // idle: a loop would keep issuing requests / navigations
    console.log(`[401] counters before=${JSON.stringify(before)} after=${JSON.stringify(c)}`)
    expect(c.credits - before.credits, '/api/credits reads caused by one Back + the 401').toBeLessThanOrEqual(2)
    expect(c.loginDocs - before.loginDocs, 'exactly one NEW navigation to the login page').toBe(1)
  })

  test('with a valid session Back/Forward/pageshow revalidate once per event, never loop, never redirect', async ({ page }) => {
    test.setTimeout(240_000)
    const c = counters(page)
    await login(page, userA)
    await toCredits(page)
    await page.waitForTimeout(1500)
    const base = c.credits
    const loginBase = c.loginDocs
    await page.goBack()
    await page.waitForTimeout(2500)
    const afterBack = c.credits - base
    await page.goForward()
    await page.waitForTimeout(2500)
    const afterForward = c.credits - base - afterBack
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
    await page.waitForTimeout(2500)
    const afterPageshow = c.credits - base - afterBack - afterForward
    await page.waitForTimeout(4000) // idle
    const idle = c.credits - base - afterBack - afterForward - afterPageshow
    console.log(`[loop] back=${afterBack} forward=${afterForward} pageshow=${afterPageshow} idle=${idle} loginDocs=${c.loginDocs}`)
    expect(afterBack).toBe(1)
    expect(afterForward).toBe(1)
    expect(afterPageshow).toBe(1)
    expect(idle).toBe(0)
    expect(c.loginDocs - loginBase, 'no navigation to the login page').toBe(0)
    expect(new URL(page.url()).pathname).toBe('/dashboard/credits')
    await expect(page.locator('a.wv-credit-indicator')).toHaveAttribute('aria-label', /50 kredit/)
  })

  for (const kind of ['network-abort', 'server-500'] as const) {
    test(`a FAILED signOut (${kind}) keeps the session, shows a redacted error, never retries by itself, retries only on click`, async ({ page, context }) => {
      test.setTimeout(240_000)
      let failing = true
      let logoutCalls = 0
      await page.route('**/auth/v1/logout*', (route) => {
        logoutCalls += 1
        if (!failing) return route.continue()
        return kind === 'network-abort'
          ? route.abort('failed')
          : route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"SECRET-INTERNAL-DETAIL upstream exploded"}' })
      })
      await login(page, userA)
      await toCredits(page)
      await page.getByRole('button', { name: 'Fiókmenü megnyitása' }).click()
      await page.getByRole('menuitem', { name: 'Kijelentkezés' }).click()

      const alert = page.getByRole('alert').filter({ hasText: /kijelentkezés nem sikerült/i })
      await expect(alert).toBeVisible({ timeout: 30_000 })
      const text = await alert.innerText()
      await page.waitForTimeout(4000) // a hidden auto-retry would show up as extra logout calls here
      const state = {
        kind,
        path: new URL(page.url()).pathname,
        sbCookies: (await context.cookies()).filter((k) => k.name.startsWith('sb-')).length,
        shellVisible: await page.locator('.wv-shell').isVisible(),
        ended: await page.evaluate(() => document.documentElement.getAttribute('data-wv-session')),
        pill: await page.locator('a.wv-credit-indicator').getAttribute('aria-label'),
        logoutCalls,
        text,
      }
      console.log(`[signOut-fail] ${JSON.stringify(state)}`)
      expect(state.sbCookies, 'the local session still exists').toBeGreaterThan(0)
      expect(state.path, 'no navigation as if signed out').toBe('/dashboard/credits')
      expect(state.shellVisible).toBe(true)
      expect(state.ended, 'the document is not marked as session-ended').toBeNull()
      expect(state.pill, 'the balance is still the live one').toMatch(/50 kredit/)
      expect(state.logoutCalls, 'exactly one attempt, no automatic retry').toBe(1)
      expect(text, 'redacted: no upstream detail, no technical error text').not.toMatch(/SECRET|upstream|exploded|fetch|Failed|500|AuthRetryable/i)

      // The user retries by clicking again; this time the server answers.
      failing = false
      const nav = watchLoginNavigation(page)
      await page.getByRole('menuitem', { name: 'Kijelentkezés' }).click()
      await nav.expectExactlyOneNavigation()
      expect(logoutCalls, 'the retry happened only because of the click').toBe(2)
      const after = await leakReport(page, [A_NAME, userA.email])
      expect(after.pills).toEqual([])
      expect(after.needlesInHtml).toEqual([])
      expect((await context.cookies()).filter((k) => k.name.startsWith('sb-')).length, 'session removed after the successful sign-out').toBe(0)
    })
  }

  test('a double click while the sign-out is in flight sends exactly one request (double-submit guard)', async ({ page }) => {
    test.setTimeout(240_000)
    let logoutCalls = 0
    await page.route('**/auth/v1/logout*', async (route) => {
      logoutCalls += 1
      await new Promise((r) => setTimeout(r, 2000))
      return route.continue()
    })
    await login(page, userA)
    await toCredits(page)
    await page.getByRole('button', { name: 'Fiókmenü megnyitása' }).click()
    const item = page.getByRole('menuitem', { name: /Kijelentkezés/ })
    const nav = watchLoginNavigation(page)
    await item.click()
    await item.click({ force: true, timeout: 2000 }).catch(() => undefined)
    await item.dispatchEvent('click').catch(() => undefined)
    await nav.expectExactlyOneNavigation()
    expect(logoutCalls).toBe(1)
  })
})

test.describe('mobile 390px', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  })

  test('credit indicator is visible, links to billing, no overflow, no console problems from first load; logout + Back leaks nothing', async ({ page, context }) => {
    test.setTimeout(240_000)
    const consoleSink: string[] = []
    attachConsole(page, consoleSink) // attached before the very first navigation
    await instrument(context)
    await login(page, userA)
    await expect(page.locator('a.wv-credit-indicator')).toHaveAttribute('aria-label', /50 kredit/, { timeout: 60_000 })

    const m = await page.evaluate(() => {
      const el = document.querySelector('a.wv-credit-indicator') as HTMLElement
      const r = el.getBoundingClientRect()
      return {
        iw: innerWidth,
        docW: document.documentElement.scrollWidth,
        pill: { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height), text: el.innerText },
        href: el.getAttribute('href'),
        wide: [...document.querySelectorAll('body *')].filter((e) => {
          const b = e.getBoundingClientRect()
          return b.width > 0 && b.right > innerWidth + 1 && getComputedStyle(e).position !== 'fixed'
        }).slice(0, 6).map((e) => `${e.tagName}.${String((e as HTMLElement).className).slice(0, 30)}`),
      }
    })
    console.log(`[mobile] dashboard metrics: ${JSON.stringify(m)}`)
    expect(m.docW).toBeLessThanOrEqual(m.iw)
    expect(m.pill.l).toBeGreaterThanOrEqual(0)
    expect(m.pill.r).toBeLessThanOrEqual(m.iw)
    expect(m.href).toBe('/dashboard/credits')
    expect(m.wide).toEqual([])

    await page.locator('a.wv-credit-indicator').tap()
    await expect(page).toHaveURL(/\/dashboard\/credits/)
    await expect(page.locator('.wv-credit-balance-number strong')).toHaveText('50', { timeout: 60_000 })
    const m2 = await page.evaluate(() => ({ iw: innerWidth, docW: document.documentElement.scrollWidth }))
    console.log(`[mobile] credits metrics: ${JSON.stringify(m2)}`)
    expect(m2.docW).toBeLessThanOrEqual(m2.iw)
    await page.screenshot({ path: process.env.WV_QA_SHOT_DIR ? `${process.env.WV_QA_SHOT_DIR}/mobile-credits.png` : 'test-results/mobile-credits.png' })

    await logoutStrict(page)
    await page.goBack()
    await page.waitForTimeout(2500)
    const rep = await leakReport(page, [A_NAME, userA.email])
    console.log(`[mobile] after logout + Back: ${JSON.stringify(rep)}`)
    expect(rep.pills).toEqual([])
    expect(rep.needlesInText).toEqual([])
    expect(rep.needlesInHtml).toEqual([])

    console.log(`[mobile] console since first load (all): ${JSON.stringify(consoleSink)}`)
    expect(unexpected(consoleSink), 'no console errors/warnings from first load (only the known dev-only cookies() warning is tolerated)').toEqual([])
  })
})
