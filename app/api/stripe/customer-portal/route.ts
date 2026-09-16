import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminClient } from '@/lib/supabase-server'
import { getStripeClient, resolveCanonicalAppOrigin } from '@/lib/stripe'

export async function POST(req: NextRequest) {
  try {
    const supabase = createServerSupabaseClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Config validated (and the Stripe client constructed) BEFORE any DB
    // call -- this route needs nothing else from lib/stripe (no price ids).
    const appOrigin = resolveCanonicalAppOrigin()
    const stripe = getStripeClient()

    const admin = createAdminClient()
    const { data: creditRow, error: creditReadError } = await admin
      .from('user_credits')
      .select('stripe_customer_id')
      .eq('user_id', user.id)
      .single()
    if (creditReadError && creditReadError.code !== 'PGRST116') throw creditReadError

    if (!creditRow?.stripe_customer_id) {
      return NextResponse.json({ error: 'No subscription found' }, { status: 404 })
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: creditRow.stripe_customer_id,
      return_url: `${appOrigin}/dashboard/credits`,
    })

    return NextResponse.json({ url: session.url })
  } catch (err: any) {
    console.error('Customer portal error:', err)
    return NextResponse.json({ error: 'A fiókkezelő megnyitása sikertelen. Próbáld újra.' }, { status: 500 })
  }
}
