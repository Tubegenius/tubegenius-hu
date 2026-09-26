import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  announceAuthSessionEnded,
  armAuthSessionEnd,
  AUTH_SESSION_ENDED_EVENT,
  endAuthSession,
  leaveToLogin,
  LOGIN_PATH,
  rearmAuthSessionEnd,
  SESSION_ENDED_ATTRIBUTE,
} from '@/lib/auth-session-events'
import { CreditBalanceUnauthorizedError, fetchCreditBalance } from '@/lib/credit-balance-client'

function stubBrowser(pathname: string) {
  const attributes = new Map<string, string>()
  const dispatched: Event[] = []
  const replace = vi.fn()
  vi.stubGlobal('CustomEvent', class { type: string; detail: unknown; constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail } })
  vi.stubGlobal('document', {
    documentElement: {
      setAttribute: (k: string, v: string) => attributes.set(k, v),
      removeAttribute: (k: string) => attributes.delete(k),
    },
  })
  vi.stubGlobal('window', {
    location: { pathname, replace },
    dispatchEvent: (e: Event) => { dispatched.push(e); return true },
  })
  return { attributes, dispatched, replace }
}

// The idempotence flags are module state: start every test from the armed state.
beforeEach(() => { stubBrowser('/dashboard'); armAuthSessionEnd(); vi.unstubAllGlobals() })
afterEach(() => { vi.unstubAllGlobals() })

describe('auth session events', () => {
  it('are inert on the server (no window)', () => {
    expect(() => endAuthSession('logout')).not.toThrow()
    expect(() => announceAuthSessionEnded('logout')).not.toThrow()
    expect(() => leaveToLogin()).not.toThrow()
    expect(() => armAuthSessionEnd()).not.toThrow()
  })

  it('marks the document, notifies the shared state and leaves with a HARD navigation', () => {
    const b = stubBrowser('/dashboard/credits')
    endAuthSession('logout')

    expect(b.attributes.get(SESSION_ENDED_ATTRIBUTE)).toBe('ended')
    expect(b.dispatched.map(e => (e as unknown as { type: string }).type)).toEqual([AUTH_SESSION_ENDED_EVENT])
    expect((b.dispatched[0] as unknown as { detail: string }).detail).toBe('logout')
    expect(b.replace).toHaveBeenCalledTimes(1)
    expect(b.replace).toHaveBeenCalledWith(LOGIN_PATH)
  })

  it('does not navigate again when already on the login page', () => {
    const b = stubBrowser(LOGIN_PATH)
    endAuthSession('signed-out-elsewhere')
    expect(b.replace).not.toHaveBeenCalled()
  })

  it('a repeated end (successful logout + SIGNED_OUT) starts exactly ONE navigation and emits ONE event', () => {
    const b = stubBrowser('/dashboard/credits')
    endAuthSession('logout')
    endAuthSession('signed-out-elsewhere')
    endAuthSession('unauthorized')

    expect(b.replace).toHaveBeenCalledTimes(1)
    expect(b.dispatched).toHaveLength(1)
    expect((b.dispatched[0] as unknown as { detail: string }).detail).toBe('logout')
  })

  it('a later, new session can still be ended after the protected tree is armed again', () => {
    const b = stubBrowser('/dashboard')
    endAuthSession('logout')
    expect(b.replace).toHaveBeenCalledTimes(1)

    armAuthSessionEnd() // a new protected tree mounted (new session scope)
    expect(b.attributes.has(SESSION_ENDED_ATTRIBUTE)).toBe(false)
    endAuthSession('unauthorized')

    expect(b.replace).toHaveBeenCalledTimes(2)
    expect(b.dispatched).toHaveLength(2)
    expect((b.dispatched[1] as unknown as { detail: string }).detail).toBe('unauthorized')
  })

  it('a restored (bfcache) page can be ended again without un-hiding it before revalidation', () => {
    const b = stubBrowser('/dashboard')
    endAuthSession('logout')
    rearmAuthSessionEnd()
    expect(b.attributes.get(SESSION_ENDED_ATTRIBUTE)).toBe('ended') // stays hidden until revalidated

    endAuthSession('unauthorized')
    expect(b.replace).toHaveBeenCalledTimes(2)
    expect(b.dispatched).toHaveLength(2)
  })

  it('has no event loop: ending from the ended-event listener is a no-op', () => {
    const b = stubBrowser('/dashboard')
    const original = (window as unknown as { dispatchEvent: (e: Event) => boolean }).dispatchEvent
    ;(window as unknown as { dispatchEvent: (e: Event) => boolean }).dispatchEvent = (e: Event) => {
      original(e)
      endAuthSession('unauthorized') // what a listener reacting to the event might do
      return true
    }
    endAuthSession('logout')
    expect(b.dispatched).toHaveLength(1)
    expect(b.replace).toHaveBeenCalledTimes(1)
  })
})

describe('credit balance read authorization', () => {
  it('turns a 401 into a typed unauthorized error, distinct from other failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })))
    await expect(fetchCreditBalance()).rejects.toBeInstanceOf(CreditBalanceUnauthorizedError)

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
    const failure = await fetchCreditBalance().then(() => null, (e: unknown) => e)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(CreditBalanceUnauthorizedError)
  })
})
