import Stripe from 'stripe'

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-05-28.basil' as any,
})

export const PLANS = {
  starter: { priceId: process.env.STRIPE_PRICE_STARTER_MONTHLY!, credits: 50, rolloverCap: 75, softDailyLimit: 10, price: 2990 },
  creator: { priceId: process.env.STRIPE_PRICE_CREATOR_MONTHLY!, credits: 150, rolloverCap: 225, softDailyLimit: 30, price: 5990 },
  pro: { priceId: process.env.STRIPE_PRICE_PRO_MONTHLY!, credits: 500, rolloverCap: 750, softDailyLimit: 100, price: 11990 },
} as const

export type PlanKey = keyof typeof PLANS

export const TOPUPS = {
  topup_50: { priceId: process.env.STRIPE_PRICE_TOPUP_50!, credits: 50, price: 1990 },
  topup_150: { priceId: process.env.STRIPE_PRICE_TOPUP_150!, credits: 150, price: 4990 },
  topup_500: { priceId: process.env.STRIPE_PRICE_TOPUP_500!, credits: 500, price: 11990 },
} as const

export type TopupKey = keyof typeof TOPUPS
