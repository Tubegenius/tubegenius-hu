import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminClient } from '@/lib/supabase-server'
import { stripe, TOPUPS, TopupKey } from '@/lib/stripe'

export async function POST(req: NextRequest) {
  try {
    const supabase = createServerSupabaseClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { package: pkg } = await req.json() as { package: string }
    if (!pkg || !(pkg in TOPUPS)) {
      return NextResponse.json({ error: 'Invalid package' }, { status: 400 })
    }

    const topupConfig = TOPUPS[pkg as TopupKey]
    const admin = createAdminClient()

    const { data: creditRow } = await admin
      .from('user_credits')
      .select('stripe_customer_id, subscription_status')
      .eq('user_id', user.id)
      .single()

    if (!creditRow || !['active', 'trialing'].includes(creditRow.subscription_status)) {
      return NextResponse.json({ error: 'Active subscription required for top-ups' }, { status: 403 })
    }

    const session = await stripe.checkout.sessions.create({
      customer: creditRow.stripe_customer_id,
      mode: 'payment',
      line_items: [{ price: topupConfig.priceId, quantity: 1 }],
      success_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/credits?success=true`,
      cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/credits?canceled=true`,
      metadata: { user_id: user.id, package: pkg },
    })

    return NextResponse.json({ url: session.url })
  } catch (err: any) {
    console.error('Create topup session error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
