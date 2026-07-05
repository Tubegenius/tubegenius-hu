// lib/viral-score-cache.ts
// WillViral — Perzisztens, user-szintű Viral Score eredmény-cache.
// Cél: ha a user egyszer már kifizetett egy Viral Score elemzést egy témára,
// az újranyitás (más session, más nap, akár hetekkel később) mindig ingyenes
// legyen — csak az explicit "Frissítés" (force_refresh) indít új, fizetős
// elemzést. A "friss" vs. "korábbi mentett" állapot csak egy UI-jelzés,
// SOHA nem fizetési határ. Ugyanaz a minta, mint lib/similar-videos-cache.ts.

import { createServerClient } from '@supabase/ssr'

function adminClient() {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { cookies: { getAll() { return [] }, setAll() {} } }
  )
}

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
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface ViralScoreContextInput {
  userId: string
  topic: string
  platform?: string | null
  region?: string | null
}

export function buildViralScoreHash(input: ViralScoreContextInput): string {
  const parts = [
    input.userId,
    normalizeTopic(input.topic),
    input.platform || '',
    input.region || '',
  ].join('|')
  return simpleHash(parts)
}

export type ViralScoreCacheStatus = 'fresh' | 'stale_saved' | 'miss'

// A "friss" ablak csak jelzés — a user szemének, nem fizetési határ.
const FRESH_WINDOW_MS = 6 * 60 * 60 * 1000

export function cacheStatusFor(lastRefreshedAt: string): ViralScoreCacheStatus {
  const age = Date.now() - new Date(lastRefreshedAt).getTime()
  return age <= FRESH_WINDOW_MS ? 'fresh' : 'stale_saved'
}

export interface CachedViralScore {
  id: string
  result: unknown
  score: number | null
  created_at: string
  updated_at: string
  last_opened_at: string
  last_refreshed_at: string
}

export async function getCachedViralScore(hash: string, userId: string): Promise<CachedViralScore | null> {
  try {
    const admin = adminClient()
    const { data } = await admin
      .from('viral_score_searches')
      .select('id, result, score, created_at, updated_at, last_opened_at, last_refreshed_at')
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
    await admin.from('viral_score_searches').update({ last_opened_at: new Date().toISOString() }).eq('id', id)
  } catch (e) {
    console.warn('[viral-score-cache] touchLastOpened failed (non-blocking):', e)
  }
}

export interface SaveViralScoreInput {
  userId: string
  hash: string
  normalizedTopic: string
  originalTopic: string
  region?: string | null
  platform?: string | null
  result: unknown
  score: number
  creditCost: number
}

// Eredmény mentése/frissítése — kredit levonás UTÁN hívjuk. Ha ez hibázik,
// azt élesen logoljuk (a user már fizetett érte, ez kritikus hiba, de nem
// törhet el a válasz visszaadását — a usernek meg kell kapnia, amiért fizetett).
export async function saveViralScoreResult(input: SaveViralScoreInput): Promise<{ success: boolean; error?: string }> {
  try {
    const admin = adminClient()
    const now = new Date().toISOString()
    const { error } = await admin.from('viral_score_searches').upsert({
      user_id: input.userId,
      search_context_hash: input.hash,
      normalized_topic: input.normalizedTopic,
      original_topic: input.originalTopic,
      region: input.region || null,
      platform: input.platform || null,
      result: input.result,
      score: input.score,
      credit_cost: input.creditCost,
      status: 'completed',
      updated_at: now,
      last_opened_at: now,
      last_refreshed_at: now,
    }, { onConflict: 'user_id,search_context_hash' })

    if (error) {
      console.error('[viral-score-cache] KRITIKUS: saveViralScoreResult hiba — a user fizetett, de a mentés hibázott:', error)
      return { success: false, error: error.message }
    }
    return { success: true }
  } catch (e) {
    console.error('[viral-score-cache] KRITIKUS: saveViralScoreResult exception — a user fizetett, de a mentés hibázott:', e)
    return { success: false, error: e instanceof Error ? e.message : 'unknown error' }
  }
}
