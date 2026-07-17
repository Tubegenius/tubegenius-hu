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
    .select('balance, total_used, plan, monthly_allowance, renews_at, subscription_status, stripe_customer_id')
    .eq('user_id', user.id)
    .single()

  if (error || !data) {
    // Ha még nincs sora, létrehozzuk
    const { data: created } = await admin
      .from('user_credits')
      .insert({ user_id: user.id })
      .select('balance, total_used, plan, monthly_allowance, renews_at, subscription_status, stripe_customer_id')
      .single()
    return NextResponse.json(created || { balance: 50, total_used: 0, plan: 'beta', monthly_allowance: 50 })
  }

  return NextResponse.json(data)
}
