import { describe, expect, it } from 'vitest'
import {
  canClaimFailedWebhook,
  getInvoiceSubscriptionId,
  isInitialSubscriptionInvoice,
  isSettledSubscriptionCheckout,
  isSettledTopupCheckout,
  resolveSubscriptionSkipReason,
  resolveTopupSkipReason,
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

  it('credits subscription checkouts only when payment_status is exactly paid', () => {
    expect(isSettledSubscriptionCheckout('paid')).toBe(true)
    expect(isSettledSubscriptionCheckout('unpaid')).toBe(false)
    expect(isSettledSubscriptionCheckout('no_payment_required')).toBe(false)
    expect(isSettledSubscriptionCheckout(null)).toBe(false)
    expect(isSettledSubscriptionCheckout(undefined)).toBe(false)
    // Whitelist, not blacklist: an unrecognized future Stripe status must also be unsettled.
    expect(isSettledSubscriptionCheckout('some_future_status')).toBe(false)
  })

  it('maps subscription checkout payment_status to a closed skip-reason set', () => {
    expect(resolveSubscriptionSkipReason('unpaid')).toBe('unpaid_subscription_checkout')
    expect(resolveSubscriptionSkipReason('no_payment_required')).toBe('no_payment_required_subscription')
    expect(resolveSubscriptionSkipReason('some_future_status')).toBe('unsupported_payment_status')
    expect(resolveSubscriptionSkipReason(null)).toBe('unsupported_payment_status')
  })

  it('maps top-up checkout payment_status to a closed skip-reason set', () => {
    expect(resolveTopupSkipReason('unpaid')).toBe('unpaid_topup_checkout')
    expect(resolveTopupSkipReason('no_payment_required')).toBe('no_payment_required_topup')
    expect(resolveTopupSkipReason('some_future_status')).toBe('unsupported_topup_payment_status')
    expect(resolveTopupSkipReason(null)).toBe('unsupported_topup_payment_status')
  })
})
