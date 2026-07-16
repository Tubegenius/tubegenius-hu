import { describe, expect, it } from 'vitest'
import { canClaimFailedWebhook, isSettledTopupCheckout } from '@/lib/stripe-event-policy'

describe('Stripe event policy', () => {
  it('credits top-ups only for settled one-time payments', () => {
    expect(isSettledTopupCheckout('payment', 'paid')).toBe(true)
    expect(isSettledTopupCheckout('payment', 'unpaid')).toBe(false)
    expect(isSettledTopupCheckout('subscription', 'paid')).toBe(false)
  })

  it('allows retry claims only from failed state', () => {
    expect(canClaimFailedWebhook('failed')).toBe(true)
    expect(canClaimFailedWebhook('processing')).toBe(false)
    expect(canClaimFailedWebhook('completed')).toBe(false)
  })
})
