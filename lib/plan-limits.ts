export const PAID_PLAN_DAILY_SOFT_LIMITS = {
  starter: 10,
  creator: 30,
  pro: 100,
} as const

export type PaidPlanName = keyof typeof PAID_PLAN_DAILY_SOFT_LIMITS
