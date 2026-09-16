import Stripe from 'stripe'
import { PAID_PLAN_DAILY_SOFT_LIMITS } from '@/lib/plan-limits'

// Server-only, lazy Stripe runtime configuration. Module import (which
// happens for every route during `next build`'s page-data collection, even
// though no request is ever made at build time) DOES read PLANS/TOPUPS'
// individual STRIPE_PRICE_* vars below -- but only optionally (no `!`
// assertion, `undefined` is a perfectly valid value at this point) and it
// never throws, never validates presence, and never constructs the Stripe
// SDK client. The three guaranteed properties of module import are: no
// REQUIRED env var is validated, no Stripe client is constructed, and a
// missing/empty env var never makes the import (or `next build`) throw.
// Actual validation -- of the Stripe secret key, a specific price id, or
// the canonical app origin -- happens only at REQUEST TIME, inside
// getStripeClient()/requirePriceId()/resolveCanonicalAppOrigin(), each of
// which fails closed with a typed, catchable StripeConfigurationError
// rather than a dummy/placeholder value or a raw SDK exception. Never
// reads .env/.env.local -- process.env only.
export class StripeConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StripeConfigurationError'
  }
}

const STRIPE_API_VERSION = '2025-05-28.basil' as any

let cachedClient: Stripe | null = null

// Memoized: constructs the SDK client at most once per server process, on
// the first call that actually needs it. Never logs the key or any part of
// it -- only ever checks presence.
export function getStripeClient(): Stripe {
  if (cachedClient) return cachedClient
  const apiKey = process.env.STRIPE_SECRET_KEY
  if (!apiKey) {
    throw new StripeConfigurationError('STRIPE_SECRET_KEY is not configured')
  }
  cachedClient = new Stripe(apiKey, { apiVersion: STRIPE_API_VERSION })
  return cachedClient
}

// Hostnames the http: scheme is ever allowed on, and ONLY outside
// production -- WHATWG URL renders an IPv6 literal's hostname WITH its
// brackets (`new URL('http://[::1]:3000').hostname === '[::1]'`).
const LOCAL_DEV_HTTP_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

// Canonical app origin for Stripe-facing redirect URLs (checkout
// success/cancel, billing-portal return). Validated at request time --
// never assembled from an unvalidated `${process.env.X}/path` template that
// would silently become "undefined/path" if the var were unset. Fail-closed
// contract: production requires https:; http: is accepted only outside
// production and only on localhost/127.0.0.1/[::1]; no userinfo; path must
// be empty or exactly `/` (a trailing slash is a normal, normalized `/`,
// never a reason to reject); no query string; no fragment. Every failure
// throws the same typed StripeConfigurationError -- callers only ever
// build redirect URLs from this function's validated return value.
export function resolveCanonicalAppOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL
  if (!configured) {
    throw new StripeConfigurationError('NEXT_PUBLIC_APP_URL is not configured')
  }
  let url: URL
  try {
    url = new URL(configured)
  } catch {
    throw new StripeConfigurationError('NEXT_PUBLIC_APP_URL is not a valid URL')
  }

  if (url.protocol === 'https:') {
    // Always allowed, in every environment.
  } else if (url.protocol === 'http:') {
    if (process.env.NODE_ENV === 'production') {
      throw new StripeConfigurationError('NEXT_PUBLIC_APP_URL must use HTTPS in production')
    }
    if (!LOCAL_DEV_HTTP_HOSTNAMES.has(url.hostname)) {
      throw new StripeConfigurationError('NEXT_PUBLIC_APP_URL may only use HTTP for localhost/127.0.0.1/[::1]')
    }
  } else {
    throw new StripeConfigurationError('NEXT_PUBLIC_APP_URL has an unsupported protocol')
  }

  if (url.username || url.password) {
    throw new StripeConfigurationError('NEXT_PUBLIC_APP_URL must not contain userinfo')
  }
  if (url.pathname !== '' && url.pathname !== '/') {
    throw new StripeConfigurationError('NEXT_PUBLIC_APP_URL must not contain a path')
  }
  if (url.search) {
    throw new StripeConfigurationError('NEXT_PUBLIC_APP_URL must not contain a query string')
  }
  if (url.hash) {
    throw new StripeConfigurationError('NEXT_PUBLIC_APP_URL must not contain a fragment')
  }

  return url.origin
}

// Narrows a possibly-missing price id to a real string at the point of use,
// scoped to the ONE plan/package the caller actually needs -- an unrelated
// plan's missing price id never blocks this operation.
export function requirePriceId(priceId: string | undefined, label: string): string {
  if (!priceId) {
    throw new StripeConfigurationError(`Missing Stripe price id for ${label}`)
  }
  return priceId
}

// priceId is intentionally `string | undefined` here (no `!` assertion) --
// an individual missing STRIPE_PRICE_* var must never masquerade as a real
// price id; requirePriceId() above is the only place that turns it into a
// guaranteed string, and only for the specific plan/package being used.
export const PLANS = {
  starter: { priceId: process.env.STRIPE_PRICE_STARTER_MONTHLY, credits: 50, rolloverCap: 75, softDailyLimit: PAID_PLAN_DAILY_SOFT_LIMITS.starter, price: 2990 },
  creator: { priceId: process.env.STRIPE_PRICE_CREATOR_MONTHLY, credits: 150, rolloverCap: 225, softDailyLimit: PAID_PLAN_DAILY_SOFT_LIMITS.creator, price: 5990 },
  pro: { priceId: process.env.STRIPE_PRICE_PRO_MONTHLY, credits: 500, rolloverCap: 750, softDailyLimit: PAID_PLAN_DAILY_SOFT_LIMITS.pro, price: 11990 },
} as const

export type PlanKey = keyof typeof PLANS

export const TOPUPS = {
  topup_50: { priceId: process.env.STRIPE_PRICE_TOPUP_50, credits: 50, price: 1990 },
  topup_150: { priceId: process.env.STRIPE_PRICE_TOPUP_150, credits: 150, price: 4990 },
  topup_500: { priceId: process.env.STRIPE_PRICE_TOPUP_500, credits: 500, price: 11990 },
} as const

export type TopupKey = keyof typeof TOPUPS
