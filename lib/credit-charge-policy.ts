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

export function calculateCreditRefund(balance: number, totalUsed: number, cost: number) {
  const safeBalance = Number.isFinite(balance) ? Math.max(0, balance) : 0
  const safeTotalUsed = Number.isFinite(totalUsed) ? Math.max(0, totalUsed) : 0
  const safeCost = Number.isFinite(cost) ? Math.max(0, cost) : 0
  return { newBalance: safeBalance + safeCost, newTotalUsed: Math.max(0, safeTotalUsed - safeCost) }
}

export interface CreditBuckets {
  subscription: number
  purchased: number
}

export interface BucketSpendResult extends CreditBuckets {
  allowed: boolean
  subscriptionSpent: number
  purchasedSpent: number
  total: number
}

function safeCredit(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

export function totalAvailableCredits(buckets: CreditBuckets): number {
  return safeCredit(buckets.subscription) + safeCredit(buckets.purchased)
}

export function calculateBucketSpend(buckets: CreditBuckets, cost: number): BucketSpendResult {
  const subscription = safeCredit(buckets.subscription)
  const purchased = safeCredit(buckets.purchased)
  const safeCost = safeCredit(cost)
  const total = subscription + purchased
  if (total < safeCost) {
    return { allowed: false, subscription, purchased, subscriptionSpent: 0, purchasedSpent: 0, total }
  }
  const subscriptionSpent = Math.min(subscription, safeCost)
  const purchasedSpent = safeCost - subscriptionSpent
  return {
    allowed: true,
    subscription: subscription - subscriptionSpent,
    purchased: purchased - purchasedSpent,
    subscriptionSpent,
    purchasedSpent,
    total: total - safeCost,
  }
}

export function calculateBucketRefund(
  buckets: CreditBuckets,
  allocation: { subscriptionSpent: number; purchasedSpent: number },
): CreditBuckets & { total: number } {
  const subscription = safeCredit(buckets.subscription) + safeCredit(allocation.subscriptionSpent)
  const purchased = safeCredit(buckets.purchased) + safeCredit(allocation.purchasedSpent)
  return { subscription, purchased, total: subscription + purchased }
}

export function applySubscriptionCredit(
  buckets: CreditBuckets,
  delta: number,
  cap: number,
): CreditBuckets & { total: number } {
  const subscription = Math.min(safeCredit(buckets.subscription) + safeCredit(delta), safeCredit(cap))
  const purchased = safeCredit(buckets.purchased)
  return { subscription, purchased, total: subscription + purchased }
}

export function applyPurchasedCredit(
  buckets: CreditBuckets,
  delta: number,
): CreditBuckets & { total: number } {
  const subscription = safeCredit(buckets.subscription)
  const purchased = safeCredit(buckets.purchased) + safeCredit(delta)
  return { subscription, purchased, total: subscription + purchased }
}
