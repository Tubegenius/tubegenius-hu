// @vitest-environment jsdom
//
// VALÓDI renderelt (React Testing Library + jsdom) oldalteszt: a teljes app/dashboard/video-package/page.tsx, mockolt
// böngészőkörnyezettel (next/navigation, supabase-kliens, kontextusok) és mockolt fetch-csel. Nincs valódi hálózat, DB,
// AI-hívás vagy levonás. A teszt NEM bizonyít: valódi szervert (azt a tests/video-package-credit-gate-route.test.ts fedi
// a route sorrendjére), valódi böngészőt/CSS-t, vagy bármilyen eszközök közötti garanciát.
//
// Bizonyítandó:
//   * a megerősítés MINDEN egyenleghelyzetben (fedezett / kevés / nem olvasható) megelőzi a külső /api/facts-lekérést;
//   * Mégse után semmilyen kérés nem indul;
//   * 402 / 429 / 503 / 500 / hálózati hiba után a KORÁBBI eredmény látható marad (a hibasáv mellett), mentés nem indul;
//   * sikeres válasznál az új eredmény cseréli a régit; cache-találatból (from_paid_result) nem indul automatikus mentés;
//   * a rail ikonja nem igazolt visszanyitásnál nem "siker" pipa.
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const nav = vi.hoisted(() => ({ search: '' }))
const credits = vi.hoisted(() => ({ refreshCredits: vi.fn() }))
const stable = vi.hoisted(() => ({ setCreatorLane: () => {} }))

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/dashboard/video-package',
}))
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode } & Record<string, unknown>) => <a href={href} {...rest}>{children}</a>,
}))
vi.mock('@/lib/supabase', () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) }, from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: null }) }) }) }) }),
}))
vi.mock('@/components/credits/CreditBalanceContext', () => ({ useCreditBalance: () => ({ refreshCredits: credits.refreshCredits }) }))
vi.mock('@/components/dashboard/CreatorOSContext', () => ({ useCreatorOS: () => ({ creatorLane: null, setCreatorLane: stable.setCreatorLane }) }))
vi.mock('@/lib/credit-balance-events', () => ({ publishCreditMutationCompleted: vi.fn() }))

import VideoPackagePage from '@/app/dashboard/video-package/page'

const OLD_HOOK = 'REGI-KIFIZETETT-HOOK-SZOVEG'
const NEW_HOOK = 'UJ-ERKEZETT-HOOK-SZOVEG'
const PAID_OLD = '3f2b8f0e-7c1a-4d5e-9b6a-1c2d3e4f5a6b'
const PAID_NEW = '7a1c2d3e-4b5f-4a6b-8c7d-9e0f1a2b3c4d'

function resultFixture(overrides: Record<string, unknown> = {}) {
  return {
    paid_result_id: PAID_OLD,
    topic: 'Node.js Async/Await',
    platform: 'youtube_long',
    video_length: '6-10min',
    narration_style: 'storytelling',
    intensity: 'classic',
    goal: 'views',
    hook: OLD_HOOK,
    hook_variations: [],
    narration: 'Narráció szöveg.',
    scene_structure: [{ number: 1, title: 'Nyitás', duration: '0:00-0:30', visual: 'Kép', voiceover: 'Hang', on_screen_text: 'Szöveg' }],
    broll_ideas: ['b-roll'],
    thumbnail_texts: ['Thumb'],
    title_variations: ['Cím 1', 'Cím 2'],
    caption: 'Felirat',
    description: 'Leírás',
    hashtags: { viral: ['#a'], niche: ['#b'], general: ['#c'] },
    upload_times: { primary: 'Kedd 18:00', secondary: 'Csüt. 18:00', reason: 'ok' },
    cta: 'Iratkozz fel',
    timestamps: [],
    sources_used: [],
    forbidden_claims: [],
    quality_status: 'verified',
    ...overrides,
  }
}

interface Handlers {
  video?: (n: number) => Promise<Response> | Response
  facts?: () => Promise<Response> | Response
  archive?: () => Promise<Response> | Response
}
const calls: Array<{ url: string; method: string }> = []
const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
const countOf = (url: string, method = 'POST') => calls.filter(c => c.url === url && c.method === method).length

function installFetch(handlers: Handlers = {}) {
  let videoCalls = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method || 'GET').toUpperCase()
    calls.push({ url, method })
    if (url === '/api/facts') return handlers.facts ? handlers.facts() : json(200, { has_data: false })
    if (url === '/api/video-package' && method === 'POST') { videoCalls += 1; return handlers.video ? handlers.video(videoCalls) : json(200, resultFixture()) }
    if (url === '/api/video-packages' && method === 'POST') return handlers.archive ? handlers.archive() : json(200, { id: 'pkg-1' })
    if (url === '/api/memory') return json(200, {})
    return json(404, { error: 'unexpected ' + url })
  }))
}

// A "visszanyitott" kiinduló állapot: a böngésző vissza-gombját támogató sessionStorage-állapotból áll vissza az eredmény.
function seedRestoredResult(result = resultFixture()) {
  sessionStorage.setItem('willviral_video_package_state', JSON.stringify({
    topic: 'Node.js Async/Await', result, platform: 'youtube_long', videoLength: '6-10min', narrationStyle: 'storytelling', intensity: 'classic', goal: 'views',
  }))
}

beforeEach(() => {
  calls.length = 0
  nav.search = ''
  sessionStorage.clear()
  localStorage.clear()
  credits.refreshCredits.mockReset()
  credits.refreshCredits.mockResolvedValue({ balance: 40 })
  installFetch()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function openRestored(result = resultFixture()) {
  seedRestoredResult(result)
  render(<VideoPackagePage />)
  await waitFor(() => expect(screen.getAllByText(OLD_HOOK).length).toBeGreaterThan(0))
}

const regenerate = () => screen.getByRole('button', { name: /Újragenerálás/ })

describe('the confirmation always comes BEFORE the external facts lookup', () => {
  it.each([
    ['insufficient balance (2 < 6)', { balance: 2 }, 'insufficient'],
    ['covered balance (40 >= 6)', { balance: 40 }, 'covered'],
    ['unreadable balance (null)', null, 'unknown'],
  ])('%s: the modal is shown (mode %s) and NO request has left the page yet', async (_name, creditsAnswer, mode) => {
    credits.refreshCredits.mockResolvedValue(creditsAnswer)
    await openRestored()
    fireEvent.click(regenerate())
    const dialog = await screen.findByRole('dialog')
    expect(dialog.getAttribute('data-credit-mode')).toBe(mode)
    expect(countOf('/api/facts')).toBe(0)
    expect(countOf('/api/video-package')).toBe(0)
    expect(calls).toEqual([]) // nothing at all, not even a read
  })

  it('a balance read that THROWS also ends in the confirmation modal (unknown), not in a silent start', async () => {
    credits.refreshCredits.mockRejectedValue(new Error('balance endpoint down'))
    await openRestored()
    fireEvent.click(regenerate())
    const dialog = await screen.findByRole('dialog')
    expect(dialog.getAttribute('data-credit-mode')).toBe('unknown')
    expect(countOf('/api/facts')).toBe(0)
  })

  it('Mégse: the modal closes and no request is ever made; the old result is untouched', async () => {
    credits.refreshCredits.mockResolvedValue({ balance: 2 })
    await openRestored()
    fireEvent.click(regenerate())
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mégse' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(calls).toEqual([])
    expect(screen.getAllByText(OLD_HOOK).length).toBeGreaterThan(0)
  })

  it('confirm (insufficient balance): only NOW the facts lookup and then the generation request go out, in this order', async () => {
    credits.refreshCredits.mockResolvedValue({ balance: 2 })
    installFetch({ video: () => json(402, { error: 'Nincs elég kredited új generáláshoz (6 kredit szükséges), és ehhez a bemenethez még nincs kifizetett eredményed, amit díjmentesen megnyithatnánk.' }) })
    await openRestored()
    fireEvent.click(regenerate())
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Meglévő eredmény keresése' }))
    await waitFor(() => expect(countOf('/api/video-package')).toBe(1))
    expect(calls.map(c => c.url)).toEqual(['/api/facts', '/api/video-package'])
  })

  it('a first-time start (no result yet, topic from the URL) is confirmed first as well', async () => {
    nav.search = 'topic=Node.js%20Async%2FAwait'
    credits.refreshCredits.mockResolvedValue({ balance: 2 })
    render(<VideoPackagePage />)
    fireEvent.click(await screen.findByRole('button', { name: /Gyártási csomag indítása/ }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.getAttribute('data-credit-mode')).toBe('insufficient')
    expect(countOf('/api/facts')).toBe(0)
  })
})

describe('after a refusal or a failure the PREVIOUS result stays visible', () => {
  const failures: Array<[string, () => Promise<Response> | Response, RegExp]> = [
    ['402 (no cached result, not enough credit)', () => json(402, { error: 'Nincs elég kredited új generáláshoz (6 kredit szükséges), és ehhez a bemenethez még nincs kifizetett eredményed, amit díjmentesen megnyithatnánk.' }), /még nincs kifizetett eredményed/],
    ['429 (daily soft limit)', () => json(429, { error: 'Elérted a napi lágy limitet.' }), /napi lágy limitet/],
    ['503 (cache check unavailable)', () => json(503, { error: 'Nem sikerült ellenőrizni, van-e már kész eredményed. Próbáld újra.' }), /Nem sikerült ellenőrizni/],
    ['500', () => json(500, { error: 'Szerverhiba.' }), /Szerverhiba/],
    ['network failure', () => Promise.reject(new TypeError('offline')), /Kapcsolati hiba/],
  ]

  it.each(failures)('%s: the error banner appears next to the still visible old result; no archive save starts', async (_name, answer, bannerPattern) => {
    installFetch({ video: answer })
    credits.refreshCredits.mockResolvedValue({ balance: 2 })
    await openRestored()
    fireEvent.click(regenerate())
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Meglévő eredmény keresése' }))

    const banner = await screen.findByText(bannerPattern)
    expect(banner).toBeTruthy()
    await waitFor(() => expect(screen.queryByText('A csomag épül…')).toBeNull()) // loading is over
    expect(screen.getAllByText(OLD_HOOK).length).toBeGreaterThan(0) // the old, already paid result is still on screen
    expect(countOf('/api/video-packages')).toBe(0) // no archive POST for a failed generation
    expect(countOf('/api/memory')).toBe(0)
  })

  it('the old result is also visible WHILE the new request is still running (not blanked at the start)', async () => {
    let release: (r: Response) => void = () => {}
    installFetch({ video: () => new Promise<Response>(resolve => { release = resolve }) })
    await openRestored()
    fireEvent.click(regenerate())
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Folytatás' }))
    await waitFor(() => expect(countOf('/api/video-package')).toBe(1))
    expect(screen.getAllByText(OLD_HOOK).length).toBeGreaterThan(0)
    release(json(402, { error: 'Nincs elég kredited új generáláshoz (6 kredit szükséges), és ehhez a bemenethez még nincs kifizetett eredményed, amit díjmentesen megnyithatnánk.' }))
    await screen.findByText(/még nincs kifizetett eredményed/)
    expect(screen.getAllByText(OLD_HOOK).length).toBeGreaterThan(0)
  })
})

describe('positive controls: a successful response replaces the old result', () => {
  it('fresh generation: the new result is shown, the old one is gone, and exactly ONE archive POST starts', async () => {
    installFetch({ video: () => json(200, resultFixture({ paid_result_id: PAID_NEW, hook: NEW_HOOK })) })
    await openRestored()
    fireEvent.click(regenerate())
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Folytatás' }))
    await waitFor(() => expect(screen.getAllByText(NEW_HOOK).length).toBeGreaterThan(0))
    expect(screen.queryByText(OLD_HOOK)).toBeNull()
    await waitFor(() => expect(countOf('/api/video-packages')).toBe(1))
  })

  it('a CACHE HIT (from_paid_result) replaces the result too, but NO automatic archive save starts', async () => {
    installFetch({ video: () => json(200, resultFixture({ paid_result_id: PAID_NEW, hook: NEW_HOOK, from_paid_result: true })) })
    credits.refreshCredits.mockResolvedValue({ balance: 0 })
    await openRestored()
    fireEvent.click(regenerate())
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Meglévő eredmény keresése' }))
    await waitFor(() => expect(screen.getAllByText(NEW_HOOK).length).toBeGreaterThan(0))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(countOf('/api/video-packages')).toBe(0)
    expect(countOf('/api/memory')).toBe(0)
  })
})

describe('rail icon and texts of an unverified reopened result (rendered)', () => {
  it('reopened-unverified: an info icon, NOT the success check mark; the conditional price sentence is shown', async () => {
    await openRestored()
    const rail = document.querySelector('.wv-package-generate-rail') as HTMLElement
    expect(rail).toBeTruthy()
    const icon = rail.querySelector('svg') as SVGElement
    expect(icon.getAttribute('class') || '').toContain('lucide-info')
    expect(icon.getAttribute('class') || '').not.toMatch(/circle-check|check-circle/)
    const text = (rail.textContent || '').replace(/\s+/g, ' ')
    expect(text).toContain('Fizetett eredmény megnyitva — új kredit levonása nélkül.')
    expect(text).toContain('Új generálás esetén legfeljebb 6 kredit szükséges; a meglévő eredmény megnyitása díjmentes.')
    expect(text).toContain('Újragenerálás legfeljebb 6 kredit')
    expect(text).not.toContain('Az újragenerálás újabb kreditet használ')
  })

  it('a fresh start without a result keeps the pre-payment wording, but conditional: "legfeljebb 6 kredit"', async () => {
    nav.search = 'topic=Node.js%20Async%2FAwait'
    render(<VideoPackagePage />)
    await screen.findByRole('button', { name: /Gyártási csomag indítása/ })
    const rail = document.querySelector('.wv-package-generate-rail') as HTMLElement
    const text = (rail.textContent || '').replace(/\s+/g, ' ')
    expect(text).toContain('Long videó csomag · legfeljebb 6 kredit')
    expect(text).toContain('a meglévő eredmény megnyitása díjmentes')
    expect(text).not.toContain('kreditmegerősítést kapsz')
  })
})
