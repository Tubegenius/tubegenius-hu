import { NextRequest, NextResponse } from 'next/server'
import { stripe, PLANS, TOPUPS, PlanKey, TopupKey } from '@/lib/stripe'
import { createAdminClient } from '@/lib/supabase-server'
import Stripe from 'stripe'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function getRawBody(req: NextRequest): Promise<Buffer> {
  const arrayBuffer = await req.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

export async function POST(req: NextRequest) {
  const admin = createAdminClient()
  let event: Stripe.Event

  try {
    const rawBody = await getRawBody(req)
    const sig = req.headers.get('stripe-signature')
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET

    if (webhookSecret && sig) {
      event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret)
    } else {
      // Dev mode: skip verification
      event = JSON.parse(rawBody.toString()) as Stripe.Event
    }
  } catch (err: any) {
    console.error('Webhook signature verification failed:', err.message)
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        const userId = session.metadata?.user_id
        if (!userId) break

        if (session.mode === 'subscription') {
          const plan = session.metadata?.plan as PlanKey
          const planConfig = PLANS[plan]
          if (!planConfig) break

          await admin.from('user_credits').upsert({
            user_id: userId,
            plan,
            subscription_status: 'active',
            stripe_customer_id: session.customer as string,
            stripe_subscription_id: session.subscription as string,
            subscription_credits: planConfig.credits,
          }, { onConflict: 'user_id' })
        } else if (session.mode === 'payment') {
          const pkg = session.metadata?.package as TopupKey
          const topupConfig = TOPUPS[pkg]
          if (!topupConfig) break

          const { data: current } = await admin
            .from('user_credits')
            .select('topup_credits')
            .eq('user_id', userId)
            .single()

          await admin.from('user_credits').update({
            topup_credits: (current?.topup_credits || 0) + topupConfig.credits,
          }).eq('user_id', userId)

          // Log to ai_usage_logs
          await admin.from('ai_usage_logs').insert({
            user_id: userId,
            action: 'topup_purchase',
            credits_used: -topupConfig.credits,
            metadata: { package: pkg, stripe_event_id: event.id },
          })
        }
        break
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice
        const invoiceSubscription = (invoice as any).subscription
        if (!invoiceSubscription) break

        // Find user by subscription ID
        const { data: userRow } = await admin
          .from('user_credits')
          .select('user_id, plan, subscription_credits')
          .eq('stripe_subscription_id', invoiceSubscription as string)
          .single()

        if (!userRow || !userRow.plan) break

        const planConfig = PLANS[userRow.plan as PlanKey]
        if (!planConfig) break

        // Rollover: cap at rolloverCap
        const newCredits = Math.min(
          (userRow.subscription_credits || 0) + planConfig.credits,
          planConfig.rolloverCap
        )

        await admin.from('user_credits').update({
          subscription_credits: newCredits,
        }).eq('user_id', userRow.user_id)

        // Log
        await admin.from('ai_usage_logs').insert({
          user_id: userRow.user_id,
          action: 'subscription_renewal',
          credits_used: -planConfig.credits,
          metadata: { plan: userRow.plan, new_balance: newCredits, stripe_event_id: event.id },
        })
        break
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription
        const { data: userRow } = await admin
          .from('user_credits')
          .select('user_id')
          .eq('stripe_subscription_id', subscription.id)
          .single()

        if (!userRow) break

        // Check if plan changed via price lookup
        const priceId = subscription.items.data[0]?.price?.id
        const newPlan = Object.entries(PLANS).find(([, p]) => p.priceId === priceId)?.[0]

        if (newPlan) {
          await admin.from('user_credits').update({
            plan: newPlan,
            subscription_status: subscription.status === 'active' ? 'active' : subscription.status,
          }).eq('user_id', userRow.user_id)
        }
        break
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription
        await admin.from('user_credits').update({
          subscription_status: 'canceled',
        }).eq('stripe_subscription_id', subscription.id)
        break
      }
    }
  } catch (err: any) {
    console.error('Webhook handler error:', err)
    // Still return 200 to prevent Stripe retries on processing errors
  }

  return NextResponse.json({ received: true })
}
