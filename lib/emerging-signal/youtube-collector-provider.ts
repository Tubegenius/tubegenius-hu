// Direct YouTube Data API adapter for the background collector. It deliberately
// bypasses the interactive in-memory cache/budget because the collector has its
// own atomic DB ledger. No backup key, Serper or AI fallback exists here.

import { ExternalServiceTimeoutError, fetchExternal } from '@/lib/external-fetch'
import type { DiscoveryProvider, DiscoveryProviderResult, DiscoverySearchRequest } from './discovery-worker'
import type { ObservationProvider, ObservationProviderResult, ObservationVideoStats } from './observation-worker'
import type { ScheduledDiscoveryVideo } from './capture'

interface YouTubeCollectorProviders {
  discovery: DiscoveryProvider
  observation: ObservationProvider
}

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null
}

function quotaReason(payload: unknown): boolean {
  const root = object(payload)
  const error = object(root?.error)
  const errors = Array.isArray(error?.errors) ? error.errors : []
  const reasons = errors
    .map(item => object(item)?.reason)
    .filter((reason): reason is string => typeof reason === 'string')
  return reasons.some(reason => ['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded'].includes(reason))
}

async function json(response: Response): Promise<unknown | null> {
  try { return await response.json() } catch { return null }
}

function transportFailure(error: unknown): Extract<DiscoveryProviderResult, { outcome: 'outcome_unknown' }> {
  return {
    outcome: 'outcome_unknown',
    errorClass: error instanceof ExternalServiceTimeoutError ? 'timeout' : 'connection_lost',
  }
}

function parseSearchItems(payload: unknown): ScheduledDiscoveryVideo[] | null {
  const root = object(payload)
  if (!Array.isArray(root?.items)) return null
  const result: ScheduledDiscoveryVideo[] = []
  for (const raw of root.items) {
    const item = object(raw)
    const id = object(item?.id)
    const snippet = object(item?.snippet)
    if (
      typeof id?.videoId !== 'string' || typeof snippet?.title !== 'string' ||
      typeof snippet.channelId !== 'string' || typeof snippet.channelTitle !== 'string' ||
      typeof snippet.publishedAt !== 'string'
    ) return null
    result.push({
      videoId: id.videoId,
      title: snippet.title,
      description: typeof snippet.description === 'string' ? snippet.description : undefined,
      channelId: snippet.channelId,
      channelTitle: snippet.channelTitle,
      publishedAt: snippet.publishedAt,
    })
  }
  return result
}

function count(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

function parseStatsItems(payload: unknown): ObservationVideoStats[] | null {
  const root = object(payload)
  if (!Array.isArray(root?.items)) return null
  const result: ObservationVideoStats[] = []
  for (const raw of root.items) {
    const item = object(raw)
    const statistics = object(item?.statistics)
    const viewCount = count(statistics?.viewCount)
    if (typeof item?.id !== 'string' || viewCount === undefined) return null
    result.push({
      videoId: item.id,
      viewCount,
      likeCount: count(statistics?.likeCount),
      commentCount: count(statistics?.commentCount),
    })
  }
  return result
}

export function createYouTubeCollectorProviders(input: {
  apiKey: string
  fetchImpl?: typeof fetch
  now?: () => Date
}): YouTubeCollectorProviders {
  const apiKey = input.apiKey.trim()
  const fetchImpl = input.fetchImpl ?? fetch
  const now = input.now ?? (() => new Date())

  const discovery: DiscoveryProvider = {
    async search(request: DiscoverySearchRequest): Promise<DiscoveryProviderResult> {
      if (!apiKey) return { outcome: 'failure', errorClass: 'provider_rejected' }
      const current = now()
      if (!Number.isFinite(current.getTime())) return { outcome: 'failure', errorClass: 'invalid_response' }
      const url = new URL('https://www.googleapis.com/youtube/v3/search')
      url.searchParams.set('part', 'snippet')
      url.searchParams.set('q', request.query)
      url.searchParams.set('type', 'video')
      url.searchParams.set('order', 'date')
      url.searchParams.set('maxResults', String(request.maxResults))
      url.searchParams.set('relevanceLanguage', request.language)
      url.searchParams.set('publishedAfter', new Date(current.getTime() - 30 * 24 * 60 * 60_000).toISOString())
      if (request.region !== 'BOTH') url.searchParams.set('regionCode', request.region)
      url.searchParams.set('key', apiKey)
      try {
        const response = await fetchExternal('YouTube', url, {}, 15_000, fetchImpl)
        const payload = await json(response)
        if (quotaReason(payload)) return { outcome: 'quota_exhausted' }
        if (!response.ok) return { outcome: 'failure', errorClass: 'provider_rejected' }
        const videos = parseSearchItems(payload)
        return videos ? { outcome: 'success', videos } : { outcome: 'failure', errorClass: 'invalid_response' }
      } catch (error) {
        return transportFailure(error)
      }
    },
  }

  const observation: ObservationProvider = {
    async fetchVideoStats(videoIds): Promise<ObservationProviderResult> {
      if (!apiKey) return { outcome: 'failure', errorClass: 'provider_rejected' }
      if (videoIds.length < 1 || videoIds.length > 50) return { outcome: 'failure', errorClass: 'invalid_response' }
      const url = new URL('https://www.googleapis.com/youtube/v3/videos')
      url.searchParams.set('part', 'statistics')
      url.searchParams.set('id', videoIds.join(','))
      url.searchParams.set('key', apiKey)
      try {
        const response = await fetchExternal('YouTube', url, {}, 15_000, fetchImpl)
        const payload = await json(response)
        if (quotaReason(payload)) return { outcome: 'quota_exhausted' }
        if (!response.ok) return { outcome: 'failure', errorClass: 'provider_rejected' }
        const videos = parseStatsItems(payload)
        return videos ? { outcome: 'success', videos } : { outcome: 'failure', errorClass: 'invalid_response' }
      } catch (error) {
        const failure = transportFailure(error)
        return failure
      }
    },
  }

  return { discovery, observation }
}
