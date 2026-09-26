import { describe, expect, it, vi } from 'vitest'
import {
  CreditBalanceRequestCoordinator,
  parseCreditBalanceResponse,
  type CreditBalance,
} from '@/lib/credit-balance-client'

const balance = (value: number): CreditBalance => ({
  balance: value,
  total_available_credits: value,
  subscription_credit_balance: value,
  purchased_credit_balance: 0,
  total_used: 0,
  plan: 'creator',
  monthly_allowance: 150,
  renews_at: null,
  subscription_status: 'active',
})

describe('credit balance client', () => {
  it('distinguishes a real zero balance from an invalid or missing balance', () => {
    expect(parseCreditBalanceResponse({ balance: 0, total_available_credits: 0 })?.balance).toBe(0)
    expect(parseCreditBalanceResponse({ balance: 12.5 })?.total_available_credits).toBe(12.5)
    expect(parseCreditBalanceResponse({ balance: '0' })).toBeNull()
    expect(parseCreditBalanceResponse({})).toBeNull()
    expect(parseCreditBalanceResponse({ balance: -1 })).toBeNull()
  })

  it('deduplicates concurrent reads', async () => {
    const coordinator = new CreditBalanceRequestCoordinator()
    const fetcher = vi.fn(async () => balance(9.5))
    const first = coordinator.request(fetcher)
    const second = coordinator.request(fetcher)

    expect(second.id).toBe(first.id)
    expect(second.promise).toBe(first.promise)
    await expect(first.promise).resolves.toEqual(balance(9.5))
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('marks a late pre-mutation response stale after a superseding refresh', async () => {
    const coordinator = new CreditBalanceRequestCoordinator()
    let resolveOld!: (value: CreditBalance) => void
    let resolveFresh!: (value: CreditBalance) => void
    const oldPromise = new Promise<CreditBalance>(resolve => { resolveOld = resolve })
    const freshPromise = new Promise<CreditBalance>(resolve => { resolveFresh = resolve })
    const fetcher = vi.fn()
      .mockReturnValueOnce(oldPromise)
      .mockReturnValueOnce(freshPromise)

    const oldRequest = coordinator.request(fetcher)
    const freshRequest = coordinator.request(fetcher, true)
    resolveFresh(balance(4.5))
    await expect(freshRequest.promise).resolves.toEqual(balance(4.5))
    expect(coordinator.isCurrent(freshRequest.id)).toBe(true)

    resolveOld(balance(99))
    await expect(oldRequest.promise).resolves.toEqual(balance(99))
    expect(coordinator.isCurrent(oldRequest.id)).toBe(false)
  })

  it('invalidates an in-flight response when its session owner unmounts', async () => {
    const coordinator = new CreditBalanceRequestCoordinator()
    let resolveRequest!: (value: CreditBalance) => void
    const requestPromise = new Promise<CreditBalance>(resolve => { resolveRequest = resolve })
    const request = coordinator.request(() => requestPromise)

    coordinator.abort()
    resolveRequest(balance(42.75))

    await expect(request.promise).resolves.toEqual(balance(42.75))
    expect(coordinator.isCurrent(request.id)).toBe(false)
  })
})
