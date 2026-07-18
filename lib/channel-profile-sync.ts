// ============================================================
// WILLVIRAL — Csatorna-profil szinkron (public URL/handle VAGY OAuth)
// ============================================================
// Ket fuggetlen modon szerezhetunk csatorna-azonossagot:
//  1. "public" — onboardingban megadott URL/handle/channelId, API-kulcsos
//     hivassal (lib/competitor-tracker.ts resolveChannel(), nincs OAuth).
//  2. "oauth"  — a Channel Audit oldalon vegzett Google OAuth osszekapcsolas
//     (lib/youtube-analytics.ts fetchOwnChannelInfo()).
// Mindket ut UGYANAZOKBA a profiles kijelzo-oszlopokba ir (channel_name,
// youtube_channel_id, subscriber_count, video_count, total_view_count,
// channel_avatar_url, youtube_channel_url, youtube_handle,
// channel_published_at, channel_synced_at) — igy a Channel Header Card
// mindig egyetlen forrasbol (profiles) olvashat, fuggetlenul attol, hogy a
// user OAuth-ozott-e valaha. Ha a ket forras eltero channelId-t ad, SOSEM
// irjuk felul automatikusan egymast — csak detectChannelConnectionType()
// jelzi a "mismatch" allapotot, a tenyleges dontes a userre var
// (app/api/youtube/resolve-mismatch/route.ts).

import { createAdminClient } from '@/lib/supabase-server'
import { resolveChannel, type ChannelSnapshot } from '@/lib/competitor-tracker'
import { fetchOwnChannelInfo, getYoutubeOAuthTokens, type OwnChannelInfo } from '@/lib/youtube-analytics'
import type { ChannelConnectionType } from '@/types'
import { requiresNicheReview } from '@/lib/channel-scope'

function deriveHandleAndUrl(customUrl: string | null, channelId: string): { handle: string | null; url: string } {
  if (customUrl) {
    const handle = customUrl.replace(/^@/, '')
    return { handle, url: `https://www.youtube.com/@${handle}` }
  }
  return { handle: null, url: `https://www.youtube.com/channel/${channelId}` }
}

interface ChannelDisplayFields {
  channel_name: string | null
  youtube_channel_id: string
  subscriber_count: number | null
  video_count: number | null
  total_view_count: number | null
  channel_avatar_url: string | null
  youtube_channel_url: string
  youtube_handle: string | null
  channel_published_at: string | null
  channel_synced_at: string
}

function fieldsFromSnapshot(snapshot: ChannelSnapshot): ChannelDisplayFields {
  const { handle, url } = deriveHandleAndUrl(snapshot.customUrl, snapshot.channelId)
  return {
    channel_name: snapshot.title || null,
    youtube_channel_id: snapshot.channelId,
    subscriber_count: snapshot.subscriberCount,
    video_count: snapshot.videoCount,
    total_view_count: snapshot.totalViewCount,
    channel_avatar_url: snapshot.thumbnailHigh || snapshot.thumbnail,
    youtube_channel_url: url,
    youtube_handle: handle,
    channel_published_at: snapshot.publishedAt,
    channel_synced_at: new Date().toISOString(),
  }
}

function fieldsFromOwnChannelInfo(info: OwnChannelInfo): ChannelDisplayFields {
  const { handle, url } = deriveHandleAndUrl(info.customUrl, info.channelId)
  return {
    channel_name: info.title,
    youtube_channel_id: info.channelId,
    subscriber_count: info.subscriberCount,
    video_count: info.videoCount,
    total_view_count: info.viewCount,
    channel_avatar_url: info.thumbnailUrl,
    youtube_channel_url: url,
    youtube_handle: handle,
    channel_published_at: info.publishedAt,
    channel_synced_at: new Date().toISOString(),
  }
}

// Publikus (URL/handle/channelId, nincs OAuth) csatorna feloldasa es
// elmentese a profiles kijelzo-mezoibe. Az onboarding "Csatorna elemzese"
// es a kesobbi "Ujraelemzes" gomb is ezt hivja.
export async function syncChannelProfileFromPublic(
  userId: string,
  channelInput: string
): Promise<{ snapshot: ChannelSnapshot; connectionType: ChannelConnectionType | null } | { error: string }> {
  const snapshot = await resolveChannel(channelInput)
  if (!snapshot) return { error: 'channel_not_found' }

  const admin = createAdminClient()
  const fields = fieldsFromSnapshot(snapshot)
  const { data: savedProfile, error } = await admin.from('profiles').update(fields).eq('user_id', userId).select('user_id').single()
  if (error || !savedProfile) return { error: 'save_failed' }

  const connectionType = await detectChannelConnectionType(userId)
  return { snapshot, connectionType }
}

// OAuth-alapu (a Channel Audit oldalon osszekapcsolt) csatorna szinkronja
// a profiles kijelzo-mezoibe — igy a Header Card OAuth nelkuli userekkel
// azonos modon olvashato.
export async function syncChannelProfileFromOAuth(
  userId: string
): Promise<{ info: OwnChannelInfo; connectionType: ChannelConnectionType | null } | { error: string }> {
  const info = await fetchOwnChannelInfo(userId)
  if (!info) return { error: 'not_connected' }

  const admin = createAdminClient()
  const fields = fieldsFromOwnChannelInfo(info)
  const { data: savedProfile, error } = await admin.from('profiles').update(fields).eq('user_id', userId).select('user_id').single()
  if (error || !savedProfile) return { error: 'save_failed' }

  const connectionType = await detectChannelConnectionType(userId)
  return { info, connectionType }
}

// Osszehasonlitja a profiles.youtube_channel_id-t (public/onboarding forras)
// az youtube_oauth_tokens.channel_id-vel (OAuth forras). Beallitja
// profiles.channel_connection_type-ot es — csak akkor, ha NEM mismatch —
// az active_channel_id-t is. Mismatch eseten az active_channel_id-t
// ERINTETLENUL hagyja, amig a user nem dont (app/api/youtube/resolve-mismatch).
export async function detectChannelConnectionType(userId: string): Promise<ChannelConnectionType | null> {
  const admin = createAdminClient()
  const [{ data: profile, error: profileError }, oauthTokens] = await Promise.all([
    admin.from('profiles').select('youtube_channel_id, active_channel_id, channel_connection_type').eq('user_id', userId).single(),
    getYoutubeOAuthTokens(userId),
  ])
  if (profileError || !profile) throw profileError || new Error('Profile not found')

  const publicChannelId = profile?.youtube_channel_id || null
  const oauthChannelId = oauthTokens?.channel_id || null

  let connectionType: ChannelConnectionType | null = null
  let activeChannelId = profile?.active_channel_id || null

  if (!publicChannelId && !oauthChannelId) {
    connectionType = null
    activeChannelId = null
  } else if (publicChannelId && oauthChannelId && publicChannelId !== oauthChannelId) {
    connectionType = 'mismatch'
    // active_channel_id valtozatlan marad, amig a user nem dont
  } else if (oauthChannelId) {
    connectionType = 'oauth'
    activeChannelId = oauthChannelId
  } else if (publicChannelId) {
    connectionType = 'public'
    activeChannelId = publicChannelId
  }

  const updateFields: Record<string, unknown> = {
    channel_connection_type: connectionType,
    active_channel_id: activeChannelId,
  }
  if (requiresNicheReview(profile?.active_channel_id || null, activeChannelId)) {
    updateFields.niche_needs_review = true
  }

  const { data: updatedProfile, error: updateError } = await admin.from('profiles')
    .update(updateFields)
    .eq('user_id', userId).select('user_id').single()
  if (updateError || !updatedProfile) throw updateError || new Error('Channel connection state update failed')

  return connectionType
}
