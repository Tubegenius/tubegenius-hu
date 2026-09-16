import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminClient } from '@/lib/supabase-server'
import { getStripeClient, requirePriceId, resolveCanonicalAppOrigin, PLANS, PlanKey } from '@/lib/stripe'

export async function POST(req: NextRequest) {
  try {
    const supabase = createServerSupabaseClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json().catch(() => null) as { plan?: unknown } | null
    const plan = typeof body?.plan === 'string' ? body.plan : ''
    if (!plan || !(plan in PLANS)) {
      return NextResponse.json({ error: 'Invalid plan' }, { status: 400 })
    }

    const planConfig = PLANS[plan as PlanKey]
    // Config validated (this plan's price id, the app origin, and the
    // Stripe client itself) BEFORE any DB or Stripe call -- an unrelated
    // plan's missing price id never blocks this request.
    const priceId = requirePriceId(planConfig.priceId, plan)
    const appOrigin = resolveCanonicalAppOrigin()
    const stripe = getStripeClient()

    const admin = createAdminClient()

    // Get or create stripe customer
    const { data: creditRow, error: creditReadError } = await admin
      .from('user_credits')
      .select('stripe_customer_id, stripe_subscription_id, subscription_status')
      .eq('user_id', user.id)
      .single()
    if (creditReadError && creditReadError.code !== 'PGRST116') throw creditReadError

    if (creditRow?.stripe_subscription_id
      && ['active', 'trialing', 'past_due'].includes(creditRow.subscription_status || '')) {
      return NextResponse.json({ error: 'Már van aktív előfizetésed. A csomagváltást a számlázási portálon végezheted el.' }, { status: 409 })
    }

    let stripeCustomerId = creditRow?.stripe_customer_id

    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { user_id: user.id },
      })
      stripeCustomerId = customer.id

      const { error: customerSaveError } = await admin
        .from('user_credits')
        .upsert({
          user_id: user.id,
          stripe_customer_id: stripeCustomerId,
        }, { onConflict: 'user_id' })
      if (customerSaveError) {
        try { await stripe.customers.del(stripeCustomerId) } catch (cleanupError) { console.error('Stripe customer cleanup failed:', cleanupError) }
        throw customerSaveError
      }
    }

    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      mode: 'subscription',
      // Card-only, szandekosan: kizarja a Dashboard dinamikus/delayed
      // fizetesi modjait (pl. SEPA, OXXO), amik payment_status='unpaid'-del
      // completed-elnek es csak kesobb, kulon async_payment_succeeded
      // esemennyel fizetodnenek ki — ezt a webhook jelenleg nem kezeli.
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${appOrigin}/dashboard/credits?success=true`,
      cancel_url: `${appOrigin}/dashboard/credits?canceled=true`,
      metadata: { user_id: user.id, plan },
      subscription_data: { metadata: { user_id: user.id, plan } },
    })

    return NextResponse.json({ url: session.url })
  } catch (err: any) {
    console.error('Create subscription session error:', err)
    return NextResponse.json({ error: 'Az előfizetés indítása sikertelen. Próbáld újra.' }, { status: 500 })
  }
}
