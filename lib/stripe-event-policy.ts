export function isSettledTopupCheckout(mode: string | null, paymentStatus: string | null): boolean {
  return mode === 'payment' && paymentStatus === 'paid'
}

export function canClaimFailedWebhook(status: string | null): boolean {
  return status === 'failed'
}
