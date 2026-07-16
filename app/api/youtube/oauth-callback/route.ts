import { NextRequest, NextResponse } from 'next/server'
import { getUserId } from '@/lib/credits'
import { getOAuth2Client, getOAuthCallbackRedirectUri, resolveOAuthOrigin, saveYoutubeOAuthTokens, YOUTUBE_OAUTH_SCOPES, YOUTUBE_OAUTH_STATE_COOKIE } from '@/lib/youtube-analytics'
import { detectChannelConnectionType, syncChannelProfileFromOAuth } from '@/lib/channel-profile-sync'

// GET — a sajat Google OAuth2 kor callbackje (ld. app/api/youtube/connect).
// Fuggetlen a Supabase Auth-tol: kozvetlenul a googleapis kliensunkkel
// valtjuk be a kodot access/refresh tokenre, majd elmentjuk a bejelentkezett
// WillViral userhez.
export async function GET(request: NextRequest) {
  const origin = resolveOAuthOrigin(request.nextUrl.origin, process.env.NEXT_PUBLIC_APP_URL, process.env.NODE_ENV === 'production')
  const code = request.nextUrl.searchParams.get('code')
  const state = request.nextUrl.searchParams.get('state')
  const oauthError = request.nextUrl.searchParams.get('error')

  const redirectToChannelAudit = (status: 'connected' | 'error', message?: string) => {
    const url = new URL('/dashboard/channel-audit', origin)
    url.searchParams.set('youtube_oauth', status)
    if (message) url.searchParams.set('youtube_oauth_message', message)
    const response = NextResponse.redirect(url)
    response.cookies.set(YOUTUBE_OAUTH_STATE_COOKIE, '', {
      httpOnly: true,
      secure: request.nextUrl.protocol === 'https:',
      sameSite: 'lax',
      maxAge: 0,
      path: '/api/youtube/oauth-callback',
    })
    return response
  }

  const userId = await getUserId()
  const expectedState = request.cookies.get(YOUTUBE_OAUTH_STATE_COOKIE)?.value
  if (!userId || !state || !expectedState || state !== expectedState) {
    return redirectToChannelAudit('error', 'invalid_state')
  }
  if (oauthError) return redirectToChannelAudit('error', oauthError)
  if (!code) return redirectToChannelAudit('error', 'missing_code')

  try {
    const oauth2Client = getOAuth2Client(getOAuthCallbackRedirectUri(origin))
    const { tokens } = await oauth2Client.getToken(code)

    if (!tokens.refresh_token) {
      // A Google csak AKKOR ad refresh_token-t, ha ez az elso engedelyezes,
      // vagy ha access_type=offline + prompt=consent volt kuldve (ez a mi
      // esetunkben mindig igy van, ld. lib/youtube-analytics.ts buildGoogleAuthUrl) —
      // ha megis hianyzik, a user mar korabban engedelyezte anelkul, hogy
      // a mi appunk eltarolta volna; ujra kell probalnia "Kapcsolat bontasa"
      // utan a Google Fiok engedelyeinel is (myaccount.google.com/permissions).
      return redirectToChannelAudit('error', 'no_refresh_token')
    }

    await saveYoutubeOAuthTokens({
      userId,
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token || null,
      expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      scope: YOUTUBE_OAUTH_SCOPES.join(' '),
    })

    // Ha a userneknek meg nincs publikus (onboardingban megadott) csatornaja,
    // vagy mar van es EGYEZIK az OAuth csatornaval, azonnal szinkronizaljuk
    // a profiles kijelzo-mezoit, hogy a Header Card frissen mutassa. Ha
    // ELTER, SOSEM iratjuk felul automatikusan — a profil oldal mismatch
    // kartyaja varja a user dontesét (app/api/youtube/resolve-mismatch).
    const connectionType = await detectChannelConnectionType(userId)
    if (connectionType !== 'mismatch') {
      await syncChannelProfileFromOAuth(userId)
    }

    return redirectToChannelAudit('connected')
  } catch (error) {
    console.error('[YouTube OAuth] oauth-callback error:', error)
    return redirectToChannelAudit('error', 'exchange_failed')
  }
}
