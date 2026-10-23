// @vitest-environment jsdom
//
// VALÓDI renderelt (RTL + jsdom) oldalteszt a futó generálás alatti állapotversenyekről (app/dashboard/video-package/page.tsx,
// mockolt böngészőkörnyezettel és mockolt fetch-csel; nincs valódi hálózat, DB, AI-hívás vagy levonás).
//
// Bizonyítandó:
//   * futó (függő) generálás alatt a régi eredményen a kézi mentés újrapróbálása és a naptárba mentés NEM indulhat
//     (a gombok tiltottak, és a kattintás sem indít kérést); a hiba utáni (késői) válasz után újra használhatók;
//   * futó kézi mentés alatt új generálás nem indítható (fordított verseny);
//   * új eredmény megérkezésekor a naptár-állapot visszaáll idle-re, és egy KÉSŐN befejeződő, a régi eredményre indított
//     naptármentés már nem állíthatja át az új eredmény állapotát (a művelet maga befejeződik).
// NEM bizonyít: valódi böngészőt/CSS-t, szervert, eszközök/lapok közötti viselkedést.
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

const HOOK_A = 'ELSO-EREDMENY-HOOK'
const HOOK_B = 'MASODIK-EREDMENY-HOOK'
const PAID_A = '3f2b8f0e-7c1a-4d5e-9b6a-1c2d3e4f5a6b'
const PAID_B = '7a1c2d3e-4b5f-4a6b-8c7d-9e0f1a2b3c4d'

function resultFixture(overrides: Record<string, unknown> = {}) {
  return {
    paid_result_id: PAID_A, topic: 'Node.js Async/Await', platform: 'youtube_long', video_length: '6-10min',
    narration_style: 'storytelling', intensity: 'classic', goal: 'views', hook: HOOK_A, hook_variations: [], narration: 'Narráció szöveg.',
    scene_structure: [{ number: 1, title: 'Nyitás', duration: '0:00-0:30', visual: 'Kép', voiceover: 'Hang', on_screen_text: 'Szöveg' }],
    broll_ideas: ['b-roll'], thumbnail_texts: ['Thumb'], title_variations: ['Cím 1', 'Cím 2'], caption: 'Felirat', description: 'Leírás',
    hashtags: { viral: ['#a'], niche: ['#b'], general: ['#c'] }, upload_times: { primary: 'Kedd 18:00', secondary: 'Csüt. 18:00', reason: 'ok' },
    cta: 'Iratkozz fel', timestamps: [], sources_used: [], forbidden_claims: [], quality_status: 'verified',
    ...overrides,
  }
}

type Responder = (n: number) => Promise<Response> | Response
interface Handlers { video?: Responder; archive?: Responder; ideasPost?: Responder; ideasPatch?: Responder }
const calls: Array<{ url: string; method: string }> = []
const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
const countOf = (url: string, method = 'POST') => calls.filter(c => c.url === url && c.method === method).length
function deferred<T = Response>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

function installFetch(h: Handlers = {}) {
  const n = { video: 0, archive: 0, post: 0, patch: 0 }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method || 'GET').toUpperCase()
    calls.push({ url, method })
    if (url === '/api/facts') return json(200, { has_data: false })
    if (url === '/api/video-package' && method === 'POST') return h.video ? h.video(++n.video) : json(200, resultFixture())
    if (url === '/api/video-packages' && method === 'POST') return h.archive ? h.archive(++n.archive) : json(200, { id: 'pkg-1' })
    if (url === '/api/video-ideas' && method === 'POST') return h.ideasPost ? h.ideasPost(++n.post) : json(200, { idea: { id: 'idea-1' } })
    if (url === '/api/video-ideas' && method === 'PATCH') return h.ideasPatch ? h.ideasPatch(++n.patch) : json(200, {})
    if (url === '/api/memory') return json(200, {})
    return json(404, { error: 'unexpected ' + url })
  }))
}

beforeEach(() => {
  calls.length = 0
  nav.search = 'topic=Node.js%20Async%2FAwait'
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

const calendarButton = () => document.querySelector('button[data-state]') as HTMLButtonElement
const retryButton = () => screen.queryByRole('button', { name: 'Mentés újrapróbálása' }) as HTMLButtonElement | null
const generateButton = () => document.querySelector('.wv-package-generate-rail button') as HTMLButtonElement

// Elindítja a generálást (modal -> Folytatás), és megvárja az eredményt.
async function startGeneration(expectHook: string) {
  fireEvent.click(generateButton())
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Folytatás' }))
  await waitFor(() => expect(screen.getAllByText(expectHook).length).toBeGreaterThan(0))
}

// Állapot: az első eredmény megvan, az automatikus archívum-mentés határozott (400) hibával elbukott -> látszik a kézi újrapróbálás.
async function reachRetryState(extra: Handlers = {}) {
  installFetch({ archive: n => (n === 1 ? json(400, {}) : json(200, { id: 'pkg-1' })), ...extra })
  render(<VideoPackagePage />)
  await startGeneration(HOOK_A)
  await waitFor(() => expect(retryButton()).toBeTruthy())
  expect(countOf('/api/video-packages')).toBe(1)
}

describe('a running (pending) generation: the old result cannot be saved or calendared', () => {
  it('manual save retry and calendar save are DISABLED while the new request is pending, clicks start nothing; usable again after a refusal', async () => {
    const pending = deferred()
    let videoCall = 0
    await reachRetryState({ video: () => (++videoCall === 1 ? json(200, resultFixture()) : pending.promise) })

    // új generálás indul (régi eredmény megmarad), a kérés függőben van
    fireEvent.click(generateButton())
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Folytatás' }))
    await waitFor(() => expect(countOf('/api/video-package')).toBe(2))

    expect(screen.getAllByText(HOOK_A).length).toBeGreaterThan(0) // a régi eredmény látszik
    expect(retryButton()!.disabled).toBe(true)
    expect(calendarButton().disabled).toBe(true)
    fireEvent.click(retryButton()!)
    fireEvent.click(calendarButton())
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
    expect(countOf('/api/video-packages')).toBe(1) // nem indult új mentés
    expect(countOf('/api/video-ideas')).toBe(0) // nem indult naptármentés
    expect(countOf('/api/video-ideas', 'PATCH')).toBe(0)

    // késői válasz: elutasítás (402) -> a régi eredmény marad, a gombok újra használhatók
    await act(async () => { pending.resolve(json(402, { error: 'Nincs elég kredited új generáláshoz (6 kredit szükséges), és ehhez a bemenethez még nincs kifizetett eredményed, amit díjmentesen megnyithatnánk.' })) })
    await screen.findByText(/még nincs kifizetett eredményed/)
    await waitFor(() => expect(retryButton()!.disabled).toBe(false))
    expect(calendarButton().disabled).toBe(false)
    fireEvent.click(retryButton()!)
    await waitFor(() => expect(countOf('/api/video-packages')).toBe(2))
  })

  it('positive control: with NO generation running both actions do start', async () => {
    await reachRetryState()
    expect(retryButton()!.disabled).toBe(false)
    fireEvent.click(calendarButton())
    await waitFor(() => expect(calendarButton().getAttribute('data-state')).toBe('saved'))
    expect(countOf('/api/video-ideas')).toBe(1)
    expect(countOf('/api/video-ideas', 'PATCH')).toBe(1)
    fireEvent.click(retryButton()!)
    await waitFor(() => expect(countOf('/api/video-packages')).toBe(2))
  })
})

describe('reverse race: a running archive request blocks the start of a new generation', () => {
  it('while the manual retry request is in flight the generate button is disabled; no second generation can start; enabled again afterwards', async () => {
    const archiveRetry = deferred()
    await reachRetryState({ archive: n => (n === 1 ? json(400, {}) : archiveRetry.promise) })
    fireEvent.click(retryButton()!)
    await waitFor(() => expect(countOf('/api/video-packages')).toBe(2))
    await waitFor(() => expect(generateButton().disabled).toBe(true))
    fireEvent.click(generateButton())
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
    expect(screen.queryByRole('dialog')).toBeNull() // not even the confirmation opens
    expect(countOf('/api/video-package')).toBe(1)

    await act(async () => { archiveRetry.resolve(json(200, { id: 'pkg-1' })) })
    await waitFor(() => expect(generateButton().disabled).toBe(false))
  })
})

describe('calendar status follows the CURRENT result only', () => {
  it('a new result resets a finished calendar save back to idle', async () => {
    installFetch({ video: n => json(200, n === 1 ? resultFixture() : resultFixture({ paid_result_id: PAID_B, hook: HOOK_B })) })
    render(<VideoPackagePage />)
    await startGeneration(HOOK_A)
    fireEvent.click(calendarButton())
    await waitFor(() => expect(calendarButton().getAttribute('data-state')).toBe('saved'))

    await startGeneration(HOOK_B)
    expect(screen.queryByText(HOOK_A)).toBeNull()
    expect(calendarButton().getAttribute('data-state')).toBe('idle')
    expect(calendarButton().disabled).toBe(false)
  })

  it('LATE completion: a calendar save started on the old result and finishing after the new result arrived does NOT mark the new result; the old save itself still completes', async () => {
    const ideas = deferred()
    installFetch({
      video: n => json(200, n === 1 ? resultFixture() : resultFixture({ paid_result_id: PAID_B, hook: HOOK_B })),
      ideasPost: () => ideas.promise,
    })
    render(<VideoPackagePage />)
    await startGeneration(HOOK_A)
    fireEvent.click(calendarButton())
    await waitFor(() => expect(calendarButton().getAttribute('data-state')).toBe('saving'))

    await startGeneration(HOOK_B) // the new result arrives while the old calendar save is still running
    expect(calendarButton().getAttribute('data-state')).toBe('idle') // reset by the new result

    await act(async () => { ideas.resolve(json(200, { idea: { id: 'idea-1' } })) })
    await waitFor(() => expect(countOf('/api/video-ideas', 'PATCH')).toBe(1)) // the old save completed its second step
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
    expect(calendarButton().getAttribute('data-state')).toBe('idle') // ... but the NEW result is not labelled as calendared
  })

  it('LATE FAILURE: an old calendar save that fails after the new result arrived does not put an error on the new result', async () => {
    const ideas = deferred()
    installFetch({
      video: n => json(200, n === 1 ? resultFixture() : resultFixture({ paid_result_id: PAID_B, hook: HOOK_B })),
      ideasPost: () => ideas.promise,
    })
    render(<VideoPackagePage />)
    await startGeneration(HOOK_A)
    fireEvent.click(calendarButton())
    await waitFor(() => expect(calendarButton().getAttribute('data-state')).toBe('saving'))
    await startGeneration(HOOK_B)
    await act(async () => { ideas.resolve(json(500, { error: 'x' })) })
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
    expect(calendarButton().getAttribute('data-state')).toBe('idle')
  })
})
