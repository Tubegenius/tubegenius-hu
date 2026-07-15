export interface CreditMutation {
  allowed: boolean
  newBalance: number
  newTotalUsed: number
}

export function calculateCreditMutation(balance: number, totalUsed: number, cost: number): CreditMutation {
  const safeBalance = Number.isFinite(balance) ? Math.max(0, balance) : 0
  const safeTotalUsed = Number.isFinite(totalUsed) ? Math.max(0, totalUsed) : 0
  const safeCost = Number.isFinite(cost) ? Math.max(0, cost) : 0
  if (safeBalance < safeCost) {
    return { allowed: false, newBalance: safeBalance, newTotalUsed: safeTotalUsed }
  }
  return { allowed: true, newBalance: safeBalance - safeCost, newTotalUsed: safeTotalUsed + safeCost }
}

export function isOptimisticCreditLockMiss(error: { code?: string } | null | undefined): boolean {
  return !error || error.code === 'PGRST116'
}
