// Starter Credit Contract v1 -- the ONE canonical description of the beta starter grant.
//
// Every new user receives exactly one starter grant, recorded as an idempotent
// ledger event in the SUBSCRIPTION bucket (never the purchased bucket):
//
//   apply_bucket_credit_event(user, 50, 'subscription', cap 50,
//                             'initial:<user_id>', 'initial_credit', {"plan":"beta"})
//
// Two writers may issue this event and they share ONE idempotency key
// (credit_ledger.external_ref is UNIQUE and the RPC row-locks user_credits):
//   1. the DB trigger handle_new_user_credits() (migration 091) -- the primary
//      writer, fires once per newly created auth.users row;
//   2. GET /api/credits, only when the user_credits row is missing entirely
//      (a compatibility fallback for a user created without the trigger).
// Whichever runs second is a no-op ("duplicate": true), so the grant can never
// be doubled. Existing users are never granted retroactively.
//
// tests/091-starter-credit-contract-migration-source-policy.test.ts pins this
// file and supabase/migrations/091_starter_credit_contract.sql to each other.
export const STARTER_CREDIT = {
  amount: 50,
  bucket: 'subscription',
  cap: 50,
  reason: 'initial_credit',
  externalRefPrefix: 'initial:',
  plan: 'beta',
} as const

export function starterCreditExternalRef(userId: string): string {
  return `${STARTER_CREDIT.externalRefPrefix}${userId}`
}

export function starterCreditRpcArgs(userId: string) {
  return {
    p_user_id: userId,
    p_delta: STARTER_CREDIT.amount,
    p_bucket: STARTER_CREDIT.bucket,
    p_cap: STARTER_CREDIT.cap,
    p_external_ref: starterCreditExternalRef(userId),
    p_reason: STARTER_CREDIT.reason,
    p_metadata: { plan: STARTER_CREDIT.plan },
  }
}
