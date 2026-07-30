import { createServerSupabaseClient } from '@/lib/supabase-server'
import { NextResponse } from 'next/server'

// Dedikalt jelszo-visszaallitasi callback, kulon a /auth/callbacktol.
// Fix celutvonalra iranyit at mindig — nem fogad el next/redirect
// query parametert, igy nem hasznalhato open redirectkent. Ha a code
// csere sikertelen (lejart/hibas link, vagy Supabase error= parameterrel
// terne vissza code helyett), a celoldal sajat session-ellenorzese kezeli
// semlegesen a hibaallapotot.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')

  if (code) {
    const supabase = createServerSupabaseClient()
    await supabase.auth.exchangeCodeForSession(code)
  }

  return NextResponse.redirect(`${origin}/auth/update-password`)
}
