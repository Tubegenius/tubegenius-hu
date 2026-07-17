import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  applyPurchasedCredit,
  applySubscriptionCredit,
  calculateBucketRefund,
  calculateBucketSpend,
  totalAvailableCredits,
} from '@/lib/credit-charge-policy'

describe('credit bucket policy', () => {
  it('sums 150 subscription and 50 purchased credits to 200', () => {
    expect(totalAvailableCredits({ subscription: 150, purchased: 50 })).toBe(200)
  })

  it('caps only subscription credit at renewal and preserves purchased credit', () => {
    expect(applySubscriptionCredit({ subscription: 150, purchased: 50 }, 150, 225))
      .toEqual({ subscription: 225, purchased: 50, total: 275 })
  })

  it('top-up touches only the purchased bucket', () => {
    expect(applyPurchasedCredit({ subscription: 150, purchased: 0 }, 50))
      .toEqual({ subscription: 150, purchased: 50, total: 200 })
  })

  it('spends subscription credit before purchased credit', () => {
    expect(calculateBucketSpend({ subscription: 150, purchased: 50 }, 20))
      .toEqual({ allowed: true, subscription: 130, purchased: 50, subscriptionSpent: 20, purchasedSpent: 0, total: 180 })
  })

  it('spends the remainder from purchased credit', () => {
    expect(calculateBucketSpend({ subscription: 5, purchased: 50 }, 20))
      .toEqual({ allowed: true, subscription: 0, purchased: 35, subscriptionSpent: 5, purchasedSpent: 15, total: 35 })
  })

  it('refunds the exact original mixed allocation', () => {
    const spent = calculateBucketSpend({ subscription: 5, purchased: 50 }, 20)
    expect(calculateBucketRefund(
      { subscription: spent.subscription, purchased: spent.purchased },
      { subscriptionSpent: spent.subscriptionSpent, purchasedSpent: spent.purchasedSpent },
    )).toEqual({ subscription: 5, purchased: 50, total: 55 })
  })

  it('rejects insufficient total credit without changing either bucket', () => {
    expect(calculateBucketSpend({ subscription: 2, purchased: 3 }, 6))
      .toEqual({ allowed: false, subscription: 2, purchased: 3, subscriptionSpent: 0, purchasedSpent: 0, total: 5 })
  })
})

describe('credit bucket database invariants', () => {
  const migration = readFileSync('supabase/migrations/037_credit_buckets.sql', 'utf8')
  const webhook = readFileSync('app/api/stripe/webhook/route.ts', 'utf8')
  const paidResults = readFileSync('lib/paid-results/paid-results-service.ts', 'utf8')

  it('backs up and backfills all legacy balance to purchased in one transaction', () => {
    expect(migration.trimStart().startsWith('BEGIN;')).toBe(true)
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true)
    expect(migration).toContain('credit_bucket_migration_backup_037')
    expect(migration).toContain('subscription_credit_balance = 0')
    expect(migration).toContain('purchased_credit_balance = GREATEST(COALESCE(balance, 0), 0)')
    expect(migration).toContain("RAISE EXCEPTION 'credit bucket backfill invariant failed'")
  })

  it('prevents negative buckets and requires total balance equality', () => {
    expect(migration).toContain('user_credits_subscription_balance_nonnegative')
    expect(migration).toContain('user_credits_purchased_balance_nonnegative')
    expect(migration).toContain('user_credits_balance_matches_buckets')
  })

  it('serializes spends and prevents negative concurrent outcomes', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.spend_credits')
    expect(migration).toContain('FOR UPDATE')
    expect(migration).toContain("RAISE EXCEPTION 'insufficient credits'")
  })

  it('makes duplicate refund idempotent by original spend transaction', () => {
    expect(migration).toContain('idx_credit_ledger_single_refund')
    expect(migration).toContain('related_transaction_id = p_spend_transaction_id')
  })

  it('routes Stripe top-up and renewal into separate buckets', () => {
    expect(webhook).toContain("p_bucket: 'purchased'")
    expect(webhook).toContain("p_reason: 'topup_purchase'")
    expect(webhook).toContain("p_bucket: 'subscription'")
    expect(webhook).toContain("p_reason: 'subscription_renewal'")
  })

  it('retains paid-result reopen metadata as zero-credit', () => {
    expect(paidResults).toContain('requires_credit: false')
  })
})
