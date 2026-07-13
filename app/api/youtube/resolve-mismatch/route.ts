import { NextRequest, NextResponse } from 'next/server'
import { getUserId } from '@/lib/credits'
import { createAdminClient } from '@/lib/supabase-server'
import { syncChannelProfileFromOAuth } from '@/lib/channel-profile-sync'
import { getYoutubeOAuthTokens } from '@/lib/youtube-analytics'

const VALID_CHOICES = ['use_oauth', 'keep_previous', 'keep_both'] as const
type Choice = (typeof VALID_CHOICES)[number]

// POST — a public (onboardingban megadott) es az OAuth-osszekapcsolt
// csatorna-azonossag eltereset ("mismatch") oldja fel a user dontese
// alapjan. SOSE ir felul semmit automatikusan — csak explicit valasztasra.
export async function POST(request: NextRequest) {
  try {
    const { choice } = await request.json()
    if (!VALID_CHOICES.includes(choice)) {
      return NextResponse.json({ error: 'Érvénytelen választás.' }, { status: 400 })
    }

    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const admin = createAdminClient()
    const { data: profile } = await admin.from('profiles').select('youtube_channel_id, channel_connection_type').eq('user_id', userId).single()
    if (profile?.channel_connection_type !== 'mismatch') {
      return NextResponse.json({ error: 'Nincs feloldandó csatorna-eltérés.' }, { status: 400 })
    }

    const c = choice as Choice

    if (c === 'use_oauth') {
      // Felulirja a profiles kijelzo-mezoit az OAuth-csatorna adataival —
      // ez a EGYETLEN eset, amikor automatikus felulirasrol van szo, de
      // ez itt kifejezett user-dontes, nem hattermukodes.
      const result = await syncChannelProfileFromOAuth(userId)
      if ('error' in result) {
        return NextResponse.json({ error: result.error, message: 'Az OAuth-csatorna adatainak lekérése sikertelen.' }, { status: 500 })
      }
      return NextResponse.json({ connection_type: result.connectionType })
    }

    if (c === 'keep_previous') {
      // A publikus (korabban megadott) csatorna marad az aktiv — az OAuth
      // token es channel_id valtozatlanul megmarad a youtube_oauth_tokens
      // tablaban, csak mar nem "aktiv" azonossagkent kezeljuk.
      await admin.from('profiles').update({
        channel_connection_type: 'public',
        active_channel_id: profile.youtube_channel_id,
      }).eq('user_id', userId)
      return NextResponse.json({ connection_type: 'public' })
    }

    // keep_both — mindket azonossag megmarad kulon jelolve, nincs felulirast,
    // az active_channel_id valtozatlan (marad a publikus, ha eddig is az volt).
    const oauthTokens = await getYoutubeOAuthTokens(userId)
    await admin.from('profiles').update({
      channel_connection_type: 'mismatch',
      active_channel_id: profile.youtube_channel_id,
    }).eq('user_id', userId)
    return NextResponse.json({ connection_type: 'mismatch', oauth_channel_id: oauthTokens?.channel_id || null })
  } catch (error) {
    console.error('[YouTube resolve-mismatch] error:', error)
    return NextResponse.json({ error: 'A csatorna-eltérés feloldása sikertelen. Próbáld újra.' }, { status: 500 })
  }
}
