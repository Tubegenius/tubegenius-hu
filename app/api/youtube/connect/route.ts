import { NextRequest, NextResponse } from 'next/server'
import { getUserId } from '@/lib/credits'
import { buildGoogleAuthUrl } from '@/lib/youtube-analytics'

// GET — elindítja a sajat, Supabase Authtol fuggetlen Google OAuth2 kort a
// YouTube csatorna osszekapcsolasahoz. A "state" parameter a bejelentkezett
// WillViral user_id-t hordozza, hogy a callback route tudja, kihez mentse
// a tokent (a Google redirekt kozben a sajat Supabase session cookie-nk is
// megmarad, de a state egy extra, hamisitas elleni ellenorzest is ad).
export async function GET(request: NextRequest) {
  const userId = await getUserId()
  if (!userId) return NextResponse.redirect(new URL('/auth/login', request.url))

  const origin = request.nextUrl.origin
  const authUrl = buildGoogleAuthUrl(origin, userId)
  return NextResponse.redirect(authUrl)
}
