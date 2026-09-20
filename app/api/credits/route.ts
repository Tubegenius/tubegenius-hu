import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminClient } from '@/lib/supabase-server'
import { starterCreditRpcArgs } from '@/lib/starter-credit'

export async function GET() {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })
  }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('user_credits')
    .select('balance, subscription_credit_balance, purchased_credit_balance, total_used, plan, monthly_allowance, renews_at, subscription_status, stripe_customer_id')
    .eq('user_id', user.id)
    .single()

  // Starter Credit Contract v1 (lib/starter-credit.ts): the DB trigger
  // handle_new_user_credits() (migration 091) creates the row AND issues the
  // starter grant for every newly created user. This branch is only a
  // compatibility fallback for a user that has no user_credits row at all.
  // It must never grant to a user whose row exists: only a definitive
  // "row not found" (PGRST116) may create + grant, and only when THIS call
  // actually created the row (a 23505 means the trigger/another request won
  // the race and has already granted, or is granting, through the same
  // idempotency key).
  if (error && error.code !== 'PGRST116') {
    return NextResponse.json({ error: 'A kreditegyenleg nem olvasható.' }, { status: 500 })
  }

  if (!data) {
    const { error: createError } = await admin
      .from('user_credits')
      .insert({ user_id: user.id })
    if (createError && createError.code !== '23505') return NextResponse.json({ error: 'A kreditegyenleg létrehozása sikertelen.' }, { status: 500 })
    if (!createError) {
      const { error: grantError } = await admin.rpc('apply_bucket_credit_event', starterCreditRpcArgs(user.id))
      if (grantError) return NextResponse.json({ error: 'A kezdőkredit jóváírása sikertelen.' }, { status: 500 })
    }
    const { data: created } = await admin
      .from('user_credits')
      .select('balance, subscription_credit_balance, purchased_credit_balance, total_used, plan, monthly_allowance, renews_at, subscription_status, stripe_customer_id')
      .eq('user_id', user.id)
      .single()
    if (!created) return NextResponse.json({ error: 'A kreditegyenleg nem olvasható.' }, { status: 500 })
    return NextResponse.json({ ...created, total_available_credits: Number(created.balance) })
  }

  return NextResponse.json({ ...data, total_available_credits: Number(data.balance) })
}
