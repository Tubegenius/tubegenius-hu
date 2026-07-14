export const CREDIT_BALANCE_UPDATED_EVENT = 'willviral:credit-balance-updated'

export function publishCreditBalance(balance: number) {
  if (typeof window === 'undefined' || !Number.isFinite(balance)) return

  window.dispatchEvent(new CustomEvent<number>(CREDIT_BALANCE_UPDATED_EVENT, {
    detail: balance,
  }))
}

