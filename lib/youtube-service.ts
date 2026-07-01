// lib/youtube-service.ts
// WillViral — Központi YouTube API szolgáltatás
// Query budget, cache, quota guard, API key fallback

// ── Query Budget ─────────────────────────────────────────────

export const YOUTUBE_QUERY_BUDGET = {
  similarVideos: 3,
  opportunityEngine: 5,
  manualTopicSearch: 5,
  dashboardRefresh: 5,
  videoPackage: 0,
} as const

export type EndpointType = keyof typeof YOUTUBE_QUERY_BUDGET

// ── Quota Guard ──────────────────────────────────────────────

interface QuotaState {
  searchCount: number
  statsCount: number
  date: string
  endpointCounts: Record<string, number>
  quotaExceededAt: string | null
  usingBackupKey: boolean
}

const DAILY_SEARCH_LIMIT = 100
const THROTTLE_AT_PERCENT = 80
const THROTTLE_SEARCH_LIMIT = Math.floor(DAILY_SEARCH_LIMIT * THROTTLE_AT_PERCENT / 100)

let quotaState: QuotaState = {
  searchCount: 0,
  statsCount: 0,
  date: new Date().toISOString().slice(0, 10),
  endpointCounts: {},
  quotaExceededAt: null,
  usingBackupKey: false,
}

function resetIfNewDay() {
  const today = new Date().toISOString().slice(0, 10)
  if (quotaState.date !== today) {
    quotaState = {
      searchCount: 0,
      statsCount: 0,
      date: today,
      endpointCounts: {},
      quotaExceededAt: null,
      usingBackupKey: false,
    }
  }
}

export function getQuotaState() {
  resetIfNewDay()
  return { ...quotaState }
}

export function isThrottled(): boolean {
  resetIfNewDay()
  return quotaState.searchCount >= THROTTLE_SEARCH_LIMIT
}

export function isExhausted(): boolean {
  resetIfNewDay()
  return quotaState.quotaExceededAt !== null && !quotaState.usingBackupKey
}

export function getEffectiveBudget(endpoint: EndpointType): number {
  resetIfNewDay()
  const baseBudget = YOUTUBE_QUERY_BUDGET[endpoint]
  if (baseBudget === 0) return 0
  if (quotaState.quotaExceededAt && !quotaState.usingBackupKey) return 0
  if (isThrottled()) {
    if (endpoint === 'similarVideos') return 1
    if (endpoint === 'opportunityEngine') return 2
    if (endpoint === 'dashboardRefresh') return 0
    return Math.min(baseBudget, 2)
  }
  return baseBudget
}

// Per-request budget tracking
let currentRequestId = ''
const requestSearchCounts = new Map<string, number>()

export function startNewRequest(requestId: string) {
  currentRequestId = requestId
  requestSearchCounts.set(requestId, 0)
}

function getRequestSearchCount(endpoint: string): number {
  return requestSearchCounts.get(currentRequestId) || 0
}

function recordSearch(endpoint: string) {
  resetIfNewDay()
  quotaState.searchCount++
  quotaState.endpointCounts[endpoint] = (quotaState.endpointCounts[endpoint] || 0) + 1
  requestSearchCounts.set(currentRequestId, (requestSearchCounts.get(currentRequestId) || 0) + 1)
  // Cleanup old request IDs
  if (requestSearchCounts.size > 50) {
    const keys = Array.from(requestSearchCounts.keys())
    keys.slice(0, keys.length - 20).forEach(k => requestSearchCounts.delete(k))
  }
}

function recordStats() {
  resetIfNewDay()
  quotaState.statsCount++
}

function recordQuotaExceeded() {
  quotaState.quotaExceededAt = new Date().toISOString()
}

// ── API Key Management ───────────────────────────────────────

function getPrimaryKey(): string {
  return process.env.YOUTUBE_API_KEY || ''
}

function getBackupKey(): string {
  return process.env.YOUTUBE_API_KEY_DEV_BACKUP || ''
}

export function getActiveApiKey(): string {
  resetIfNewDay()
  if (quotaState.usingBackupKey) {
    const backup = getBackupKey()
    if (backup) return backup
  }
  return getPrimaryKey()
}

function getActiveKey(): string {
  if (quotaState.usingBackupKey) {
    const backup = getBackupKey()
    if (backup) return backup
  }
  return getPrimaryKey()
}

// Dev módban: gyors teszt az induláskor, hogy a primary kulcs él-e
let primaryKeyTested = false
async function ensureActiveKey(): Promise<string> {
  const isDev = process.env.NODE_ENV === 'development'
  const backup = getBackupKey()
  if (!isDev || !backup || primaryKeyTested || quotaState.usingBackupKey) {
    return getActiveKey()
  }
  primaryKeyTested = true
  const primary = getPrimaryKey()
  if (!primary) { quotaState.usingBackupKey = true; return backup }
  try {
    const res = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&q=test&type=video&maxResults=1&key=${primary}`)
    const data = await res.json()
    if (data.error?.errors?.[0]?.reason === 'rateLimitExceeded' || data.error?.errors?.[0]?.reason === 'dailyLimitExceeded') {
      console.log('[YouTube] Primary key quota exceeded, switching to DEV_BACKUP')
      quotaState.usingBackupKey = true
      recordQuotaExceeded()
      return backup
    }
  } catch {}
  return primary
}

function switchToBackupKey(): boolean {
  const backup = getBackupKey()
  if (!backup) return false
  const isDev = process.env.NODE_ENV === 'development'
  if (!isDev) return false
  quotaState.usingBackupKey = true
  console.log('[YouTube] Switched to DEV_BACKUP API key')
  return true
}

// ── YouTube Search Cache ─────────────────────────────────────

interface CachedSearchResult {
  items: YouTubeSearchItem[]
  timestamp: number
  ttlMs: number
}

const searchCache = new Map<string, CachedSearchResult>()
const MAX_CACHE_SIZE = 200

function getCacheTtlMs(category?: string): number {
  if (category === 'news_current') return 6 * 60 * 60 * 1000
  if (category === 'tech_ai') return 12 * 60 * 60 * 1000
  if (category === 'science_medical' || category === 'psychology') return 24 * 60 * 60 * 1000
  if (category === 'history_strange' || category === 'space_discovery') return 3 * 24 * 60 * 60 * 1000
  return 24 * 60 * 60 * 1000
}

function buildCacheKey(query: string, regionCode: string, lang: string, publishedAfterDays: number): string {
  const dayBucket = Math.floor(publishedAfterDays / 30)
  return `yt:${query.toLowerCase().trim()}:${regionCode}:${lang}:${dayBucket}`
}

function getCachedSearch(key: string): YouTubeSearchItem[] | null {
  const cached = searchCache.get(key)
  if (!cached) return null
  if (Date.now() - cached.timestamp > cached.ttlMs) {
    searchCache.delete(key)
    return null
  }
  return cached.items
}

function setCachedSearch(key: string, items: YouTubeSearchItem[], category?: string) {
  if (searchCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = searchCache.keys().next().value
    if (oldestKey) searchCache.delete(oldestKey)
  }
  searchCache.set(key, {
    items,
    timestamp: Date.now(),
    ttlMs: getCacheTtlMs(category),
  })
}

// ── Types ────────────────────────────────────────────────────

export interface YouTubeSearchItem {
  id: { videoId: string }
  snippet: {
    title: string
    description?: string
    channelTitle: string
    channelId?: string
    publishedAt: string
    thumbnails: { medium?: { url: string }; default?: { url: string } }
  }
}

export interface YouTubeStatsItem {
  id: string
  statistics: { viewCount?: string; likeCount?: string; commentCount?: string }
  contentDetails?: { duration?: string }
}

// ── Core YouTube API calls ───────────────────────────────────

async function rawYouTubeSearch(
  query: string,
  regionCode: string,
  lang: string,
  publishedAfterDays: number,
  maxResults: number,
  apiKey: string,
): Promise<{ items: YouTubeSearchItem[]; quotaExceeded: boolean }> {
  const publishedAfter = new Date(Date.now() - publishedAfterDays * 24 * 60 * 60 * 1000).toISOString()
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&order=relevance&maxResults=${maxResults}&regionCode=${regionCode}&relevanceLanguage=${lang}&publishedAfter=${publishedAfter}&key=${apiKey}`

  try {
    const res = await fetch(url)
    const data = await res.json()
    if (data.error) {
      const reason = data.error.errors?.[0]?.reason || ''
      if (reason === 'rateLimitExceeded' || reason === 'dailyLimitExceeded' || reason === 'quotaExceeded') {
        return { items: [], quotaExceeded: true }
      }
      console.warn('[YouTube] Search error:', reason, data.error.message)
      return { items: [], quotaExceeded: false }
    }
    return { items: (data.items || []) as YouTubeSearchItem[], quotaExceeded: false }
  } catch (e) {
    console.warn('[YouTube] Search fetch error:', e)
    return { items: [], quotaExceeded: false }
  }
}

export async function youtubeSearch(
  query: string,
  regionCode: string,
  lang: string,
  publishedAfterDays: number,
  maxResults: number,
  endpoint: EndpointType,
  options?: { category?: string },
): Promise<YouTubeSearchItem[]> {
  resetIfNewDay()

  // Cache check
  const cacheKey = buildCacheKey(query, regionCode, lang, publishedAfterDays)
  const cached = getCachedSearch(cacheKey)
  if (cached) {
    console.log(`[YouTube] Cache hit: "${query}" (${cached.length} items)`)
    return cached
  }

  // Budget check — per request, nem per day
  const budget = getEffectiveBudget(endpoint)
  const usedThisRequest = getRequestSearchCount(endpoint)
  if (usedThisRequest >= budget) {
    console.log(`[YouTube] Budget exhausted for ${endpoint} this request: ${usedThisRequest}/${budget}`)
    return []
  }

  // Quota exhausted — try backup key
  if (quotaState.quotaExceededAt && !quotaState.usingBackupKey) {
    if (!switchToBackupKey()) {
      console.log('[YouTube] Quota exceeded, no backup key available')
      return []
    }
  }

  // Execute search — dev módban ellenőrzi, hogy a primary kulcs él-e
  const apiKey = await ensureActiveKey()
  if (!apiKey) return []

  recordSearch(endpoint)
  const { items, quotaExceeded } = await rawYouTubeSearch(query, regionCode, lang, publishedAfterDays, maxResults, apiKey)

  if (quotaExceeded) {
    recordQuotaExceeded()
    // Try backup key in development
    if (!quotaState.usingBackupKey && switchToBackupKey()) {
      const backup = getBackupKey()
      const retry = await rawYouTubeSearch(query, regionCode, lang, publishedAfterDays, maxResults, backup)
      if (!retry.quotaExceeded && retry.items.length > 0) {
        setCachedSearch(cacheKey, retry.items, options?.category)
        return retry.items
      }
    }
    return []
  }

  // Cache result
  if (items.length > 0) {
    setCachedSearch(cacheKey, items, options?.category)
  }

  console.log(`[YouTube] Search: "${query}" → ${items.length} items (${endpoint} ${usedThisRequest + 1}/${budget}, daily ${quotaState.searchCount}/${DAILY_SEARCH_LIMIT})`)
  return items
}

export async function youtubeStats(videoIds: string[]): Promise<Map<string, YouTubeStatsItem>> {
  if (videoIds.length === 0) return new Map()
  const apiKey = getActiveKey()
  if (!apiKey) return new Map()

  const ids = videoIds.join(',')
  try {
    recordStats()
    const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails&id=${ids}&key=${apiKey}`)
    const data = await res.json()
    if (data.error) {
      const reason = data.error.errors?.[0]?.reason || ''
      if (reason === 'rateLimitExceeded' || reason === 'dailyLimitExceeded') {
        recordQuotaExceeded()
        if (!quotaState.usingBackupKey && switchToBackupKey()) {
          const backup = getBackupKey()
          const retry = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails&id=${ids}&key=${backup}`)
          const retryData = await retry.json()
          if (!retryData.error) {
            return new Map((retryData.items || []).map((item: YouTubeStatsItem) => [item.id, item]))
          }
        }
      }
      return new Map()
    }
    return new Map((data.items || []).map((item: YouTubeStatsItem) => [item.id, item]))
  } catch {
    return new Map()
  }
}

// ── Quota info endpoint helper ───────────────────────────────

export function quotaSummary() {
  resetIfNewDay()
  return {
    date: quotaState.date,
    searches_today: quotaState.searchCount,
    search_limit: DAILY_SEARCH_LIMIT,
    throttle_at: THROTTLE_SEARCH_LIMIT,
    is_throttled: isThrottled(),
    is_exhausted: isExhausted(),
    using_backup_key: quotaState.usingBackupKey,
    quota_exceeded_at: quotaState.quotaExceededAt,
    endpoint_counts: { ...quotaState.endpointCounts },
    estimated_units_used: quotaState.searchCount * 100 + quotaState.statsCount,
  }
}
