import { createServerSupabaseClient } from '@/lib/supabase-server'
import { saveYoutubeOAuthTokens, YOUTUBE_OAUTH_SCOPES } from '@/lib/youtube-analytics'
import { NextResponse } from 'next/server'

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')

  if (code) {
    const supabase = createServerSupabaseClient()
    const { data, error } = await supabase.auth.exchangeCodeForSession(code)

    // A Google-linkIdentity (YouTube csatorna osszekapcsolasa, ld.
    // lib/youtube-analytics.ts) ugyanerre a callback route-ra fut ki, es
    // csak ITT, kozvetlenul az OAuth-redirekt utan erheto el a
    // provider_refresh_token — kesobbi bejelentkezeseknel mar nem.
    if (!error && data.session?.provider_refresh_token && data.user) {
      await saveYoutubeOAuthTokens({
        userId: data.user.id,
        refreshToken: data.session.provider_refresh_token,
        accessToken: data.session.provider_token || null,
        expiresAt: null,
        scope: YOUTUBE_OAUTH_SCOPES,
      }).catch(err => console.error('[YouTube OAuth] token mentés sikertelen:', err))
    }
  }

  return NextResponse.redirect(`${origin}/dashboard`)
}
