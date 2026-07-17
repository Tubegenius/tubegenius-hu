export function isSettledTopupCheckout(mode: string | null, paymentStatus: string | null): boolean {
  return mode === 'payment' && paymentStatus === 'paid'
}

export function canClaimFailedWebhook(status: string | null): boolean {
  return status === 'failed'
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
