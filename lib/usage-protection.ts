import { createServerClient } from '@supabase/ssr'

// ── Free user limitek ────────────────────────────────────────

export const FREE_LIMITS = {
  similar_videos: { daily: 3, weekly: 0, hardLimitDaily: 50, creditCost: 1 },
  // Napi 1 ingyenes Opportunity Engine / Trend Feed futtatás — ez a
  // termékszabály (DashboardClient.tsx "Napi 1 ingyenes auto-frissítés"),
  // NEM heti. (Korábban tévesen weekly:1 volt beállítva, ami miatt a heti
  // keret gyorsan elfogyott és a napi ingyenes ajánlás fizetőssé vált.)
  opportunity_engine: { daily: 1, weekly: 0, hardLimitDaily: 20, creditCost: 2 },
} as const

export type ProtectedFeature = keyof typeof FREE_LIMITS

export interface UsageCheckResult {
  feature: string
  cost: number
  currency: 'free' | 'credit'
  currentCredits: number
  remainingCreditsAfterRun: number
  freeRunsLeftToday?: number
  freeRunsLeftThisWeek?: number
  requiresConfirmation: boolean
  canRun: boolean
  reason?: 'free_limit' | 'insufficient_credits' | 'hard_limit' | 'quota_exhausted'
  message?: string
}

function adminClient() {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { cookies: { getAll() { return [] }, setAll() {} } }
  )
}

async function getUserPlan(userId: string): Promise<string> {
  const admin = adminClient()
  const { data } = await admin
    .from('user_credits')
    .select('plan')
    .eq('user_id', userId)
    .single()
  return data?.plan || 'free'
}

async function getCreditBalance(userId: string): Promise<number> {
  const admin = adminClient()
  const { data } = await admin
    .from('user_credits')
    .select('balance')
    .eq('user_id', userId)
    .single()
  return Number(data?.balance ?? 0)
}

async function getTodayUsageCount(userId: string, feature: string): Promise<number> {
  const admin = adminClient()
  const today = new Date().toISOString().slice(0, 10)
  const { count } = await admin
    .from('youtube_search_logs')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('feature_name', feature)
    .gte('created_at', `${today}T00:00:00Z`)
  return count || 0
}

// ── Fő check: futtathat-e a user? ────────────────────────────

export async function checkUsagePermission(
  userId: string,
  feature: ProtectedFeature,
): Promise<UsageCheckResult> {
  const [plan, balance, todayCount] = await Promise.all([
    getUserPlan(userId),
    getCreditBalance(userId),
    getTodayUsageCount(userId, feature),
  ])

  const limits = FREE_LIMITS[feature]
  const isPaid = plan !== 'free' && plan !== 'beta'

  // Hard limit check (free usereknek)
  if (!isPaid && todayCount >= limits.hardLimitDaily) {
    return {
      feature,
      cost: limits.creditCost,
      currency: 'credit',
      currentCredits: balance,
      remainingCreditsAfterRun: balance,
      freeRunsLeftToday: 0,
      requiresConfirmation: true,
      canRun: false,
      reason: 'hard_limit',
      message: feature === 'similar_videos'
        ? `A napi maximum ${limits.hardLimitDaily} Similar Videos futtatast elereted. Probald ujra holnap.`
        : `A napi maximum ${limits.hardLimitDaily} Opportunity Engine futtatast elereted. Probald ujra holnap.`,
    }
  }

  // Free limit check
  if (feature === 'similar_videos') {
    const freeLeft = Math.max(0, limits.daily - todayCount)
    if (freeLeft > 0) {
      return {
        feature,
        cost: 0,
        currency: 'free',
        currentCredits: balance,
        remainingCreditsAfterRun: balance,
        freeRunsLeftToday: freeLeft,
        requiresConfirmation: false,
        canRun: true,
      }
    }
  }

  if (feature === 'opportunity_engine') {
    const freeLeft = Math.max(0, limits.daily - todayCount)
    if (freeLeft > 0) {
      return {
        feature,
        cost: 0,
        currency: 'free',
        currentCredits: balance,
        remainingCreditsAfterRun: balance,
        freeRunsLeftToday: freeLeft,
        requiresConfirmation: false,
        canRun: true,
      }
    }
  }

  // Paid usereknek nincs free limit, de kredit kell
  // Free usereknek a free keret elfogyott, kredit kell
  if (balance < limits.creditCost) {
    return {
      feature,
      cost: limits.creditCost,
      currency: 'credit',
      currentCredits: balance,
      remainingCreditsAfterRun: balance,
      freeRunsLeftToday: 0,
      requiresConfirmation: true,
      canRun: false,
      reason: 'insufficient_credits',
      message: `Nincs eleg kredited ehhez a muvelethez. ${limits.creditCost} kredit szukseges, neked ${balance} van.`,
    }
  }

  return {
    feature,
    cost: limits.creditCost,
    currency: 'credit',
    currentCredits: balance,
    remainingCreditsAfterRun: balance - limits.creditCost,
    freeRunsLeftToday: 0,
    requiresConfirmation: true,
    canRun: true,
    message: feature === 'similar_videos'
      ? `A napi 3 ingyenes Similar Videos keresesed elfogyott. Ez a futtatas ${limits.creditCost} kreditbe kerul.`
      : `A napi ingyenes Opportunity Engine futtatásod elfogyott. Ez a futtatas ${limits.creditCost} kreditbe kerul.`,
  }
}

// ── YouTube search log ───────────────────────────────────────

export async function logYouTubeSearch(params: {
  userId: string
  featureName: string
  query: string
  searchCount: number
  wasCached: boolean
  planType: string
}) {
  const admin = adminClient()
  await admin.from('youtube_search_logs').insert({
    user_id: params.userId,
    feature_name: params.featureName,
    query: params.query,
    search_count: params.searchCount,
    was_cached: params.wasCached,
    plan_type: params.planType,
    created_at: new Date().toISOString(),
  })
}

// ── Kredit levonás (protected feature) ───────────────────────

export async function chargeProtectedFeature(
  userId: string,
  feature: ProtectedFeature,
): Promise<{ success: boolean; newBalance: number; error?: string }> {
  const admin = adminClient()
  const cost = FREE_LIMITS[feature].creditCost

  const { data: current } = await admin
    .from('user_credits')
    .select('balance, total_used')
    .eq('user_id', userId)
    .single()

  if (!current || Number(current.balance) < cost) {
    return { success: false, newBalance: Number(current?.balance ?? 0), error: 'Nincs eleg kredit' }
  }

  const newBalance = Number(current.balance) - cost
  const newTotalUsed = Number(current.total_used) + cost

  const { error } = await admin
    .from('user_credits')
    .update({ balance: newBalance, total_used: newTotalUsed })
    .eq('user_id', userId)

  if (error) return { success: false, newBalance: Number(current.balance), error: error.message }

  await admin.from('ai_usage_logs').insert({
    user_id: userId,
    feature_name: feature,
    model: 'youtube_search',
    input_tokens: 0,
    output_tokens: 0,
    estimated_cost_usd: 0,
    credits_charged: cost,
    metadata: { type: 'protected_feature_charge', feature },
  })

  return { success: true, newBalance }
}

// ── Globális YouTube quota check ─────────────────────────────

export function getGlobalQuotaLevel(): 'normal' | 'throttled' | 'critical' | 'exhausted' {
  const { getQuotaState } = require('./youtube-service')
  const state = getQuotaState()
  const pct = (state.searchCount / 100) * 100
  if (pct >= 100) return 'exhausted'
  if (pct >= 95) return 'critical'
  if (pct >= 80) return 'throttled'
  return 'normal'
}

export function canUserSearch(isPaid: boolean): { allowed: boolean; cacheOnly: boolean; message?: string } {
  const level = getGlobalQuotaLevel()

  if (level === 'exhausted') {
    return {
      allowed: false,
      cacheOnly: true,
      message: 'A friss keresesek jelenleg nem erhetoek el. Probald ujra kesobb.',
    }
  }
  if (level === 'critical' && !isPaid) {
    return {
      allowed: false,
      cacheOnly: true,
      message: 'A friss keresesek jelenleg korlatozva vannak. Most cache-bol mutatjuk az elerheto talalatokat.',
    }
  }
  if (level === 'throttled' && !isPaid) {
    return {
      allowed: false,
      cacheOnly: true,
      message: 'A friss keresesek jelenleg korlatozva vannak. Most cache-bol mutatjuk az elerheto talalatokat. Probald ujra kesobb.',
    }
  }

  return { allowed: true, cacheOnly: false }
}
