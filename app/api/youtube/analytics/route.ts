import { NextResponse } from 'next/server'
import { getUserId } from '@/lib/credits'
import { fetchChannelAnalytics } from '@/lib/youtube-analytics'
import { createAdminClient } from '@/lib/supabase-server'
import { syncChannelProfileFromPublic, syncChannelProfileFromOAuth } from '@/lib/channel-profile-sync'

const CACHE_MAX_AGE_HOURS = 24

interface ChannelProfileResponse {
  youtube_channel_id: string | null
  channel_name: string | null
  channel_avatar_url: string | null
  youtube_channel_url: string | null
  youtube_handle: string | null
  subscriber_count: number | null
  total_view_count: number | null
  video_count: number | null
  channel_published_at: string | null
  channel_synced_at: string | null
  channel_connection_type: 'public' | 'oauth' | 'mismatch' | null
}

// GET — (A) a Channel Header Card publikus csatorna-kijelzo adatai
// (profiles tabla, OAuth NELKUL is elerheto, legfeljebb 24 orankent
// frissitve), es (B) a sajat, OAuth-hoz kotott YouTube csatorna valos
// analitikaja (nezettseg, watch time, feliratkozo-valtozas, top 10 video)
// az elmult 28 napra, ha van OAuth-kapcsolat. Kredit nelkul mindketto —
// nem generalast, csak mar meglevo/publikus adatot olvas ki.
export async function GET() {
  try {
    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const admin = createAdminClient()
    let { data: profile } = await admin
      .from('profiles')
      .select('youtube_channel_id, channel_name, channel_avatar_url, youtube_channel_url, youtube_handle, subscriber_count, total_view_count, video_count, channel_published_at, channel_synced_at, channel_connection_type')
      .eq('user_id', userId)
      .single()

    const analytics = await fetchChannelAnalytics(userId)

    const profileSelect = 'youtube_channel_id, channel_name, channel_avatar_url, youtube_channel_url, youtube_handle, subscriber_count, total_view_count, video_count, channel_published_at, channel_synced_at, channel_connection_type'

    if (profile?.youtube_channel_id) {
      const syncedAt = profile.channel_synced_at ? new Date(profile.channel_synced_at).getTime() : 0
      const isStale = Date.now() - syncedAt > CACHE_MAX_AGE_HOURS * 60 * 60 * 1000
      if (isStale) {
        const refreshed = profile.channel_connection_type === 'oauth'
          ? await syncChannelProfileFromOAuth(userId)
          : await syncChannelProfileFromPublic(userId, profile.youtube_channel_url || profile.youtube_channel_id)
        if (!('error' in refreshed)) {
          const { data: refreshedProfile } = await admin.from('profiles').select(profileSelect).eq('user_id', userId).single()
          profile = refreshedProfile
        }
      }
    } else if (analytics) {
      // Bootstrap: a user MAR OAuth-osszekapcsolt volt, mielott ez a
      // funkcio elkeszult (profiles.youtube_channel_id meg sosem lett
      // kitoltve az o eseteben) — most, hogy amugy is van friss analytics
      // hivasunk, egy legyintessel szinkronizaljuk a kijelzo-mezoket is,
      // hogy a Header Card ne maradjon orokre ures a regi userekre.
      const synced = await syncChannelProfileFromOAuth(userId)
      if (!('error' in synced)) {
        const { data: syncedProfile } = await admin.from('profiles').select(profileSelect).eq('user_id', userId).single()
        profile = syncedProfile
      }
    }

    const channelProfile: ChannelProfileResponse | null = profile?.youtube_channel_id ? {
      youtube_channel_id: profile.youtube_channel_id,
      channel_name: profile.channel_name,
      channel_avatar_url: profile.channel_avatar_url,
      youtube_channel_url: profile.youtube_channel_url,
      youtube_handle: profile.youtube_handle,
      subscriber_count: profile.subscriber_count,
      total_view_count: profile.total_view_count,
      video_count: profile.video_count,
      channel_published_at: profile.channel_published_at,
      channel_synced_at: profile.channel_synced_at,
      channel_connection_type: profile.channel_connection_type,
    } : null

    if (!channelProfile && !analytics) {
      return NextResponse.json({ error: 'not_connected', message: 'Nincs összekapcsolt vagy megadott YouTube csatorna.' }, { status: 404 })
    }

    return NextResponse.json({ channel_profile: channelProfile, ...(analytics || {}), analytics_available: !!analytics })
  } catch (error) {
    console.error('[YouTube Analytics] GET error:', error)
    return NextResponse.json({ error: 'A csatorna-analitika lekérése sikertelen. Próbáld újra, vagy kapcsold össze újra a csatornát.' }, { status: 500 })
  }
}
