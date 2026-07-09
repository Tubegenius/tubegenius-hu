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
    } else if (process.env.NODE_ENV !== 'production') {
      // Dev mode: skip verification — csak fejlesztéskor engedett. Élesben, ha
      // a secret/header hiányzik, korábban ez ellenőrizetlen payloadot fogadott
      // volna el bárkitől — az alábbi else ág ezt zárja le.
      event = JSON.parse(rawBody.toString()) as Stripe.Event
    } else {
      console.error('Stripe webhook: signature verification skipped in production (missing secret or signature header)')
      return NextResponse.json({ error: 'Webhook not configured' }, { status: 400 })
    }
  } catch (err: any) {
    console.error('Webhook signature verification failed:', err.message)
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  // ── Idempotencia — "claim" az esemenyt MIELOTT barmilyen kredit-mutalo
  // muveletet vegeznenk. Stripe garantaltan tobbszor is kuldheti ugyanazt az
  // eseményt (retry, replay) — a UNIQUE(event_id) constraint atomian
  // biztositja, hogy csak egyetlen feldolgozas indulhasson el, meg akkor is,
  // ha ket delivery majdnem egyszerre erkezik.
  const { error: claimError } = await admin
    .from('stripe_webhook_events')
    .insert({ event_id: event.id, event_type: event.type })

  if (claimError) {
    if (claimError.code === '23505') {
      console.log(`Stripe webhook: event ${event.id} (${event.type}) mar fel lett dolgozva korabban, kihagyva.`)
      return NextResponse.json({ received: true, duplicate: true })
    }
    console.error('Stripe webhook: idempotency claim sikertelen:', claimError)
    return NextResponse.json({ error: 'Idempotency check failed' }, { status: 500 })
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

          // A user_credits tablaban nincs kulon subscription_credits mezo,
          // csak egy kozos "balance" — uj elofizetes inditasakor ezt
          // egyenesen a terv kezdo kreditjere allitjuk (nem increment,
          // hiszen ez egy uj/kezdo allapot), es a monthly_allowance-t is
          // szinkronban tartjuk a UI szamara (korabban ez sem toltodott ki).
          await admin.from('user_credits').upsert({
            user_id: userId,
            plan,
            subscription_status: 'active',
            stripe_customer_id: session.customer as string,
            stripe_subscription_id: session.subscription as string,
            balance: planConfig.credits,
            monthly_allowance: planConfig.credits,
          }, { onConflict: 'user_id' })
        } else if (session.mode === 'payment') {
          const pkg = session.metadata?.package as TopupKey
          const topupConfig = TOPUPS[pkg]
          if (!topupConfig) break

          // Atomi increment RPC-vel — korabban select-update (read-then-write)
          // volt, ami ket kozel egyideju esemenynel elveszithetett egy frissitest.
          const { data: newBalance, error: rpcError } = await admin.rpc('increment_topup_credits', {
            p_user_id: userId,
            p_delta: topupConfig.credits,
          })
          if (rpcError) throw rpcError

          await admin.from('ai_usage_logs').insert({
            user_id: userId,
            action: 'topup_purchase',
            credits_used: -topupConfig.credits,
            metadata: { package: pkg, stripe_event_id: event.id, new_balance: newBalance },
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
          .select('user_id, plan')
          .eq('stripe_subscription_id', invoiceSubscription as string)
          .single()

        if (!userRow || !userRow.plan) break

        const planConfig = PLANS[userRow.plan as PlanKey]
        if (!planConfig) break

        // Atomi increment RPC-vel, a rollover-sapka (rolloverCap) a fuggvenyen
        // belul LEAST()-tel ervenyesul — korabban ez is select-update volt.
        const { data: newBalance, error: rpcError } = await admin.rpc('increment_subscription_credits', {
          p_user_id: userRow.user_id,
          p_delta: planConfig.credits,
          p_cap: planConfig.rolloverCap,
        })
        if (rpcError) throw rpcError

        // Log
        await admin.from('ai_usage_logs').insert({
          user_id: userRow.user_id,
          action: 'subscription_renewal',
          credits_used: -planConfig.credits,
          metadata: { plan: userRow.plan, new_balance: newBalance, stripe_event_id: event.id },
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
          // A monthly_allowance-t is szinkronban tartjuk az uj tervvel, hogy a
          // UI ("X / keret") azonnal a helyes szamot mutassa — a balance-t itt
          // nem bantjuk, az a kovetkezo invoice.payment_succeeded esemenynel
          // ervenyesul az uj terv szerint.
          await admin.from('user_credits').update({
            plan: newPlan,
            subscription_status: subscription.status === 'active' ? 'active' : subscription.status,
            monthly_allowance: PLANS[newPlan as PlanKey].credits,
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

    await admin.from('stripe_webhook_events')
      .update({ status: 'completed', processed_at: new Date().toISOString() })
      .eq('event_id', event.id)
  } catch (err: any) {
    console.error('Webhook handler error:', err)
    // Az esemeny mar "claim-elve" van (lasd fent), ezert egy Stripe-retry
    // ugyanerre az event_id-re az idempotencia-ellenorzesnel korán leallna
    // anelkul, hogy ujra probalna a feldolgozast — emiatt itt NEM
    // hagyatkozunk a Stripe automatikus retry-jara. A 'failed' status +
    // error_message nyomon kovetheto es kezi kivizsgalast igenyel, ha
    // kredit-mutalo lepesnel (topup/renewal) tortent a hiba.
    await admin.from('stripe_webhook_events')
      .update({ status: 'failed', error_message: String(err?.message || err), processed_at: new Date().toISOString() })
      .eq('event_id', event.id)
  }

  return NextResponse.json({ received: true })
}
