import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminClient } from '@/lib/supabase-server'

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

  if (error || !data) {
    // New rows start at zero; the starter grant is an idempotent ledger event.
    const { error: createError } = await admin
      .from('user_credits')
      .insert({ user_id: user.id })
    if (createError && createError.code !== '23505') return NextResponse.json({ error: 'A kreditegyenleg létrehozása sikertelen.' }, { status: 500 })
    const { error: grantError } = await admin.rpc('apply_bucket_credit_event', {
      p_user_id: user.id,
      p_delta: 50,
      p_bucket: 'subscription',
      p_cap: 50,
      p_external_ref: `initial:${user.id}`,
      p_reason: 'initial_credit',
      p_metadata: { plan: 'beta' },
    })
    if (grantError) return NextResponse.json({ error: 'A kezdőkredit jóváírása sikertelen.' }, { status: 500 })
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
