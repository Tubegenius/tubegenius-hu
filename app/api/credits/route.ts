import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase-server'
import { starterCreditRpcArgs } from '@/lib/starter-credit'
import { resolveSessionAuth, withSessionResponseHeaders, type SessionResponseHeaders } from '@/lib/auth/resolve-session-auth'
import { authUnavailableResponse, unauthenticatedResponse } from '@/lib/http/api-error'

// The session cache headers (@supabase/ssr: Cache-Control no-store etc.) are added to this response only when
// session cookies were actually written (lib/auth/resolve-session-auth.ts).
export async function GET(request: Request) {
  return withSessionResponseHeaders(session => handleGet(request, session))
}

async function handleGet(request: Request, session: SessionResponseHeaders) {
  // Backend error contract (wave 1): only a PROVEN missing/invalid session is a 401
  // (the client turns a 401 from this endpoint into a logout redirect); a Supabase
  // network/gateway/unknown failure is a 503 and must never sign the user out.
  // A TRANSIENT failure must also not delete the browser's session cookie, a successful token refresh must
  // reach the browser as a whole, and a PROVEN-invalid session is still cleared (lib/auth/resolve-session-auth.ts).
  const auth = await resolveSessionAuth({ apiKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, persistOnInvalidSession: true }, session)
  if (auth.kind === 'unauthenticated') return unauthenticatedResponse(request)
  if (auth.kind === 'unavailable') return authUnavailableResponse(auth, '/api/credits', request)
  const user = { id: auth.userId }

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
