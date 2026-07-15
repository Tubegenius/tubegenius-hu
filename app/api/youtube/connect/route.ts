import { NextRequest, NextResponse } from 'next/server'
import { getUserId } from '@/lib/credits'
import { buildGoogleAuthUrl, YOUTUBE_OAUTH_STATE_COOKIE } from '@/lib/youtube-analytics'

// GET — elindítja a sajat, Supabase Authtol fuggetlen Google OAuth2 kort a
// YouTube csatorna összekapcsolásához. A state egy egyszer használatos,
// rövid életű véletlen nonce; a user belső azonosítója nem kerül a Google-hoz.
export async function GET(request: NextRequest) {
  const userId = await getUserId()
  if (!userId) return NextResponse.redirect(new URL('/auth/login', request.url))

  const origin = request.nextUrl.origin
  const state = crypto.randomUUID()
  const authUrl = buildGoogleAuthUrl(origin, state)
  const response = NextResponse.redirect(authUrl)
  response.cookies.set(YOUTUBE_OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: request.nextUrl.protocol === 'https:',
    sameSite: 'lax',
    maxAge: 10 * 60,
    path: '/api/youtube/oauth-callback',
  })
  return response
}
