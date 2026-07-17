import { describe, expect, it } from 'vitest'
import {
  canClaimFailedWebhook,
  getInvoiceSubscriptionId,
  isInitialSubscriptionInvoice,
  isSettledTopupCheckout,
} from '@/lib/stripe-event-policy'

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

  it('resolves subscription IDs from legacy and current Stripe invoice payloads', () => {
    expect(getInvoiceSubscriptionId({ subscription: 'sub_legacy' })).toBe('sub_legacy')
    expect(getInvoiceSubscriptionId({
      parent: { subscription_details: { subscription: 'sub_current' } },
    })).toBe('sub_current')
    expect(getInvoiceSubscriptionId({
      parent: { subscription_details: { subscription: { id: 'sub_expanded' } } },
    })).toBe('sub_expanded')
    expect(getInvoiceSubscriptionId({})).toBeNull()
  })

  it('separates the initial subscription invoice from renewals', () => {
    expect(isInitialSubscriptionInvoice('subscription_create')).toBe(true)
    expect(isInitialSubscriptionInvoice('subscription_cycle')).toBe(false)
    expect(isInitialSubscriptionInvoice(null)).toBe(false)
  })
})
