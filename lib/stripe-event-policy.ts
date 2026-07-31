export function isSettledTopupCheckout(mode: string | null, paymentStatus: string | null): boolean {
  return mode === 'payment' && paymentStatus === 'paid'
}

export function canClaimFailedWebhook(status: string | null): boolean {
  return status === 'failed'
}

export type SubscriptionCheckoutSkipReason =
  | 'unpaid_subscription_checkout'
  | 'no_payment_required_subscription'
  | 'unsupported_payment_status'

export type TopupCheckoutSkipReason =
  | 'unpaid_topup_checkout'
  | 'no_payment_required_topup'
  | 'unsupported_topup_payment_status'

/** Whitelist, not blacklist: any status other than 'paid' — including ones Stripe adds later — is unsettled. */
export function isSettledSubscriptionCheckout(paymentStatus: string | null | undefined): boolean {
  return paymentStatus === 'paid'
}

export function resolveSubscriptionSkipReason(paymentStatus: string | null | undefined): SubscriptionCheckoutSkipReason {
  if (paymentStatus === 'unpaid') return 'unpaid_subscription_checkout'
  if (paymentStatus === 'no_payment_required') return 'no_payment_required_subscription'
  return 'unsupported_payment_status'
}

export function resolveTopupSkipReason(paymentStatus: string | null | undefined): TopupCheckoutSkipReason {
  if (paymentStatus === 'unpaid') return 'unpaid_topup_checkout'
  if (paymentStatus === 'no_payment_required') return 'no_payment_required_topup'
  return 'unsupported_topup_payment_status'
}

type StripeInvoiceLike = {
  subscription?: string | { id?: string } | null
  parent?: {
    subscription_details?: {
      subscription?: string | { id?: string } | null
    } | null
  } | null
}

function stripeId(value: string | { id?: string } | null | undefined): string | null {
  if (typeof value === 'string') return value
  return value?.id || null
}

/** Supports both the legacy invoice.subscription field and Stripe's newer parent shape. */
export function getInvoiceSubscriptionId(invoice: StripeInvoiceLike): string | null {
  return stripeId(invoice.subscription)
    || stripeId(invoice.parent?.subscription_details?.subscription)
}

export function isInitialSubscriptionInvoice(billingReason: string | null | undefined): boolean {
  return billingReason === 'subscription_create'
}
