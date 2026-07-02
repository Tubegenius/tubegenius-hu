// lib/similar-videos-cache.ts
// WillViral — Perzisztens Similar Videos eredmény-cache.
// Cél: ha a user egyszer már kifizetett egy keresést egy témára, az
// újranyitás (más session, más nap) mindig ingyenes legyen — csak az
// explicit "Frissítés" (force_refresh) indít új, fizetős keresést.

import { createServerClient } from '@supabase/ssr'

function adminClient() {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { cookies: { getAll() { return [] }, setAll() {} } }
  )
}

// Kis, determinisztikus hash (nem kriptográfiai célra) — ugyanaz mint a
// trend-radar.ts-ben használt egyszerű hash, csak itt önálló másolatban,
// hogy a modul ne függjön a trend-radar belső state-jétől.
function simpleHash(input: string): string {
  let hash = 0
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0
  }
  return Math.abs(hash).toString(36)
}

export function normalizeTopic(topic: string): string {
  return topic
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // ékezet-normalizálás
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface SearchContextInput {
  userId: string
  topic: string
  region?: string | null
  language?: string | null
  platform?: string | null
  mainCategory?: string | null
  specificFocus?: string | null
}

export function buildSearchContextHash(input: SearchContextInput): string {
  const normalizedTopic = normalizeTopic(input.topic)
  const parts = [
    input.userId,
    normalizedTopic,
    input.region || '',
    input.language || '',
    input.platform || '',
    input.mainCategory || '',
    input.specificFocus || '',
  ].join('|')
  return simpleHash(parts)
}

export interface CachedSearchResult {
  id: string
  results: unknown
  result_count: number
  credit_cost: number
  created_at: string
  updated_at: string
  last_opened_at: string
  last_refreshed_at: string
  original_topic: string
}

// Meglévő, completed cache lekérése — nem indít semmilyen külső hívást.
export async function getCachedSearch(hash: string, userId: string): Promise<CachedSearchResult | null> {
  try {
    const admin = adminClient()
    const { data } = await admin
      .from('similar_video_searches')
      .select('id, results, result_count, credit_cost, created_at, updated_at, last_opened_at, last_refreshed_at, original_topic')
      .eq('user_id', userId)
      .eq('search_context_hash', hash)
      .eq('status', 'completed')
      .single()
    return data
  } catch {
    return null
  }
}

export async function touchLastOpened(id: string): Promise<void> {
  try {
    const admin = adminClient()
    await admin.from('similar_video_searches').update({ last_opened_at: new Date().toISOString() }).eq('id', id)
  } catch (e) {
    console.warn('[similar-videos-cache] touchLastOpened failed (non-blocking):', e)
  }
}

export interface SaveSearchInput {
  userId: string
  hash: string
  normalizedTopic: string
  originalTopic: string
  region?: string | null
  language?: string | null
  platform?: string | null
  queryVariants: unknown[]
  results: unknown[]
  creditCost: number
}

// Eredmény mentése/frissítése — kredit levonás UTÁN hívjuk. Ha ez hibázik,
// azt élesen logoljuk (a user már fizetett érte, ez kritikus hiba, de nem
// törhet el a válasz visszaadását — a usernek meg kell kapnia, amiért fizetett).
export async function saveSearchResult(input: SaveSearchInput): Promise<{ success: boolean; error?: string }> {
  try {
    const admin = adminClient()
    const now = new Date().toISOString()
    const { error } = await admin.from('similar_video_searches').upsert({
      user_id: input.userId,
      search_context_hash: input.hash,
      normalized_topic: input.normalizedTopic,
      original_topic: input.originalTopic,
      region: input.region || null,
      language: input.language || null,
      platform: input.platform || null,
      query_variants: input.queryVariants,
      results: input.results,
      result_count: input.results.length,
      credit_cost: input.creditCost,
      status: 'completed',
      updated_at: now,
      last_opened_at: now,
      last_refreshed_at: now,
    }, { onConflict: 'user_id,search_context_hash' })

    if (error) {
      console.error('[similar-videos-cache] KRITIKUS: saveSearchResult hiba — a user fizetett, de a mentés hibázott:', error)
      return { success: false, error: error.message }
    }
    return { success: true }
  } catch (e) {
    console.error('[similar-videos-cache] KRITIKUS: saveSearchResult exception — a user fizetett, de a mentés hibázott:', e)
    return { success: false, error: e instanceof Error ? e.message : 'unknown error' }
  }
}
