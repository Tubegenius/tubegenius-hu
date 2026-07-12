// ============================================================
// WILLVIRAL — YouTube OAuth + valos Channel Analytics
// ============================================================
// A Channel Audit eddig kizarolag a user altal kezzel bevitt, AI-ertekelt
// video_audits sorokra epult (lib/channel-audit.ts). Ez a modul egy ONALLO,
// a Supabase Authtol FUGGETLEN Google OAuth2 folyamatot hasznal (sajat
// googleapis kliens, sajat callback route: app/api/youtube/oauth-callback),
// hogy a sajat csatorna VALOS YouTube Analytics adatait (nezettseg, watch
// time, feliratkozo-valtozas, videonkenti teljesitmeny) lekerje —
// kiegeszitve, nem lecserelve a meglevo kezi audit-folyamatot.
//
// FONTOS, korabban rossz iranyban probaltuk: a Supabase Auth linkIdentity()
// API bejelentkezesi-modszer hozzaadasara valo, NEM harmadik feles API-hoz
// szukseges access/refresh token megszerzesere — sikeres linkeles utan sem
// ad vissza provider_token/provider_refresh_token-t, ha a munkamenet aktiv
// bejelentkezesi modja nem maga a linkelt provider (nalunk email marad).
// Ezert egy sajat, Google-hoz kozvetlenul beszelo OAuth2 korre van szukseg.

import { google } from 'googleapis'
import { createAdminClient } from '@/lib/supabase-server'

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET

export const YOUTUBE_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/yt-analytics.readonly',
  'https://www.googleapis.com/auth/youtube.readonly',
]

export function getOAuthCallbackRedirectUri(origin: string): string {
  return `${origin}/api/youtube/oauth-callback`
}

export function getOAuth2Client(redirectUri?: string) {
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, redirectUri)
}

export function buildGoogleAuthUrl(origin: string, state: string): string {
  const oauth2Client = getOAuth2Client(getOAuthCallbackRedirectUri(origin))
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: YOUTUBE_OAUTH_SCOPES,
    state,
  })
}

export interface YoutubeOAuthTokenRow {
  user_id: string
  refresh_token: string
  access_token: string | null
  access_token_expires_at: string | null
  scope: string | null
  channel_id: string | null
  channel_title: string | null
  connected_at: string
}

export async function saveYoutubeOAuthTokens(params: {
  userId: string
  refreshToken: string
  accessToken?: string | null
  expiresAt?: Date | null
  scope?: string | null
}): Promise<void> {
  const supabase = createAdminClient()
  const { error } = await supabase.from('youtube_oauth_tokens').upsert({
    user_id: params.userId,
    refresh_token: params.refreshToken,
    access_token: params.accessToken || null,
    access_token_expires_at: params.expiresAt ? params.expiresAt.toISOString() : null,
    scope: params.scope || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' })
  if (error) throw error
}

async function updateChannelInfo(userId: string, channelId: string, channelTitle: string | null): Promise<void> {
  const supabase = createAdminClient()
  await supabase.from('youtube_oauth_tokens')
    .update({ channel_id: channelId, channel_title: channelTitle, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
}

export async function getYoutubeOAuthTokens(userId: string): Promise<YoutubeOAuthTokenRow | null> {
  const supabase = createAdminClient()
  const { data } = await supabase.from('youtube_oauth_tokens').select('*').eq('user_id', userId).maybeSingle()
  return (data as YoutubeOAuthTokenRow | null) || null
}

export async function deleteYoutubeOAuthTokens(userId: string): Promise<void> {
  const supabase = createAdminClient()
  await supabase.from('youtube_oauth_tokens').delete().eq('user_id', userId)
}

async function getValidOAuthClient(userId: string): Promise<InstanceType<typeof google.auth.OAuth2> | null> {
  const tokens = await getYoutubeOAuthTokens(userId)
  if (!tokens) return null

  const oauth2Client = getOAuth2Client()
  oauth2Client.setCredentials({ refresh_token: tokens.refresh_token })

  const expiresAt = tokens.access_token_expires_at ? new Date(tokens.access_token_expires_at).getTime() : 0
  const stillValid = !!tokens.access_token && expiresAt > Date.now() + 60_000
  if (stillValid) {
    oauth2Client.setCredentials({ refresh_token: tokens.refresh_token, access_token: tokens.access_token })
    return oauth2Client
  }

  const { credentials } = await oauth2Client.refreshAccessToken()
  if (!credentials.access_token) return null
  oauth2Client.setCredentials(credentials)

  await saveYoutubeOAuthTokens({
    userId,
    refreshToken: tokens.refresh_token,
    accessToken: credentials.access_token,
    expiresAt: credentials.expiry_date ? new Date(credentials.expiry_date) : null,
    scope: tokens.scope,
  })

  return oauth2Client
}

export interface OwnChannelInfo {
  channelId: string
  title: string | null
  subscriberCount: number | null
  viewCount: number | null
  videoCount: number | null
}

export async function fetchOwnChannelInfo(userId: string): Promise<OwnChannelInfo | null> {
  const oauth2Client = await getValidOAuthClient(userId)
  if (!oauth2Client) return null

  const youtube = google.youtube({ version: 'v3', auth: oauth2Client })
  const res = await youtube.channels.list({ part: ['id', 'snippet', 'statistics'], mine: true })
  const channel = res.data.items?.[0]
  if (!channel?.id) return null

  const info: OwnChannelInfo = {
    channelId: channel.id,
    title: channel.snippet?.title || null,
    subscriberCount: channel.statistics?.subscriberCount ? Number(channel.statistics.subscriberCount) : null,
    viewCount: channel.statistics?.viewCount ? Number(channel.statistics.viewCount) : null,
    videoCount: channel.statistics?.videoCount ? Number(channel.statistics.videoCount) : null,
  }
  await updateChannelInfo(userId, info.channelId, info.title)
  return info
}

export interface ChannelVideoPerformance {
  videoId: string
  title: string | null
  views: number
  estimatedMinutesWatched: number
  averageViewDuration: number
}

export interface ChannelAnalyticsSummary {
  channelId: string
  channelTitle: string | null
  rangeStart: string
  rangeEnd: string
  totals: { views: number; estimatedMinutesWatched: number; subscribersGained: number; subscribersLost: number }
  topVideos: ChannelVideoPerformance[]
  weakestVideos: ChannelVideoPerformance[]
}

async function fetchVideoTitles(oauth2Client: InstanceType<typeof google.auth.OAuth2>, videoIds: string[]): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  if (videoIds.length === 0) return titles
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client })
  const res = await youtube.videos.list({ part: ['snippet'], id: videoIds })
  for (const item of res.data.items || []) {
    if (item.id && item.snippet?.title) titles.set(item.id, item.snippet.title)
  }
  return titles
}

export async function fetchChannelAnalytics(userId: string, days = 28): Promise<ChannelAnalyticsSummary | null> {
  const oauth2Client = await getValidOAuthClient(userId)
  if (!oauth2Client) return null

  const channelInfo = await fetchOwnChannelInfo(userId)
  if (!channelInfo) return null

  const youtubeAnalytics = google.youtubeAnalytics({ version: 'v2', auth: oauth2Client })
  const endDate = new Date()
  const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000)
  const fmt = (d: Date) => d.toISOString().slice(0, 10)

  // A YouTube Analytics API video-dimenzios reportnal NEM tamogatja a
  // novekvo rendezest ("sort: views" -> 400 "query is not supported") —
  // csak csokkeno ("-views"). Ezert EGY lekerdezesbol (nagyobb maxResults)
  // szamoljuk a top ES a leggyengebb videokat is, nem kulon hivassal.
  const [totalsRes, videosRes] = await Promise.all([
    youtubeAnalytics.reports.query({
      ids: 'channel==MINE',
      startDate: fmt(startDate),
      endDate: fmt(endDate),
      metrics: 'views,estimatedMinutesWatched,subscribersGained,subscribersLost',
    }),
    youtubeAnalytics.reports.query({
      ids: 'channel==MINE',
      startDate: fmt(startDate),
      endDate: fmt(endDate),
      metrics: 'views,estimatedMinutesWatched,averageViewDuration',
      dimensions: 'video',
      sort: '-views',
      maxResults: 50,
    }),
  ])

  const totalsRow = totalsRes.data.rows?.[0] || [0, 0, 0, 0]

  const toPerformance = (rows: unknown[][] | undefined | null) => (rows || []).map(row => ({
    videoId: String(row[0]),
    views: Number(row[1]) || 0,
    estimatedMinutesWatched: Number(row[2]) || 0,
    averageViewDuration: Number(row[3]) || 0,
  }))

  const allVideos = toPerformance(videosRes.data.rows)
  const topVideos = allVideos.slice(0, 10)
  const weakestVideos = allVideos.slice(-10).reverse()

  const allVideoIds = Array.from(new Set([...topVideos, ...weakestVideos].map(v => v.videoId)))
  const titles = await fetchVideoTitles(oauth2Client, allVideoIds)

  return {
    channelId: channelInfo.channelId,
    channelTitle: channelInfo.title,
    rangeStart: fmt(startDate),
    rangeEnd: fmt(endDate),
    totals: {
      views: Number(totalsRow[0]) || 0,
      estimatedMinutesWatched: Number(totalsRow[1]) || 0,
      subscribersGained: Number(totalsRow[2]) || 0,
      subscribersLost: Number(totalsRow[3]) || 0,
    },
    topVideos: topVideos.map(v => ({ ...v, title: titles.get(v.videoId) || null })),
    weakestVideos: weakestVideos.map(v => ({ ...v, title: titles.get(v.videoId) || null })),
  }
}
