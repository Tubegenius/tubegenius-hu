// ============================================================
// WILLVIRAL — Credit System Helper
// ============================================================
// Anthropic Claude árazás (kb. USD/millió token)
// Sonnet: $3 input / $15 output
// Haiku:  $0.25 input / $1.25 output (~12x olcsóbb)

import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { MODELS } from '@/lib/models'

export type FeatureName =
  | 'video_package_shorts'
  | 'video_package_long'
  | 'viral_score'
  | 'opportunity_explain'
  | 'script_extract'
  | 'transcript_extract'
  | 'video_audit'
  | 'hashtag_caption'
  | 'trend_deep_refresh'
  | 'keyword_research'
  | 'competitor_add'
  | 'competitor_deep_analysis'
  | 'outlier_scan'
  | 'title_studio'
  | 'thumbnail_studio'
  | 'seo_optimizer'
  | 'content_gap_finder'

// Credit költségek funkciónként (a spec szerint)
export const CREDIT_COSTS: Record<FeatureName, number> = {
  hashtag_caption: 0.5,
  opportunity_explain: 1,
  viral_score: 1,
  video_package_shorts: 2,
  script_extract: 3,
  transcript_extract: 3,
  trend_deep_refresh: 1,
  video_audit: 4,
  video_package_long: 6,
  keyword_research: 1,
  competitor_add: 1,
  competitor_deep_analysis: 2,
  outlier_scan: 1,
  title_studio: 1,
  thumbnail_studio: 1,
  seo_optimizer: 1,
  content_gap_finder: 2,
}

// A kulcsok a lib/models.ts MODELS ertekeivel egyeznek — korabban itt elavult
// modellnevek (claude-sonnet-4-5, claude-3-5-haiku-20241022) szerepeltek, amik
// sosem talaltak talalatot, ezert minden hivas csendben a Sonnet-arral lett
// beccsulve, a Haiku-hivasok is.
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  [MODELS.primary]: { input: 3, output: 15 },
  [MODELS.fast]: { input: 0.25, output: 1.25 },
}

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING[MODELS.primary]
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output
}

function adminClient() {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { cookies: { getAll() { return [] }, setAll() {} } }
  )
}

export async function getUserId(): Promise<string | null> {
  const cookieStore = cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { cookies: { getAll() { return cookieStore.getAll() }, setAll() {} } }
  )
  const { data: { user } } = await supabase.auth.getUser()
  return user?.id || null
}

export async function getCreditBalance(userId: string): Promise<{ balance: number; plan: string } | null> {
  const admin = adminClient()
  const { data, error } = await admin
    .from('user_credits')
    .select('balance, plan')
    .eq('user_id', userId)
    .single()

  if (error || !data) return null
  return { balance: Number(data.balance), plan: data.plan }
}

export async function hasEnoughCredits(userId: string, feature: FeatureName): Promise<boolean> {
  const credits = await getCreditBalance(userId)
  if (!credits) return false
  return credits.balance >= CREDIT_COSTS[feature]
}

// ─── Csak USAGE LOG (nem von le kreditet) — több AI hívás logolásához egy feature-ön belül ───
export async function logUsage(
  userId: string,
  feature: FeatureName,
  model: string,
  inputTokens: number,
  outputTokens: number,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  const admin = adminClient()
  const estimatedCostUsd = estimateCost(model, inputTokens, outputTokens)

  await admin.from('ai_usage_logs').insert({
    user_id: userId,
    feature_name: feature,
    model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    estimated_cost_usd: estimatedCostUsd,
    credits_charged: 0, // a tényleges levonás külön történik
    metadata,
  })
}

// ─── Kredit levonás egyszer, a feature teljes díja ───
export async function chargeFeature(
  userId: string,
  feature: FeatureName,
  metadata: Record<string, unknown> = {}
): Promise<{ success: boolean; new_balance?: number; error?: string }> {
  const admin = adminClient()
  const cost = CREDIT_COSTS[feature]

  const { data: current, error: fetchErr } = await admin
    .from('user_credits')
    .select('balance, total_used')
    .eq('user_id', userId)
    .single()

  if (fetchErr || !current) {
    return { success: false, error: 'Kredit egyenleg nem található' }
  }

  const currentBalance = Number(current.balance)
  const currentTotalUsed = Number(current.total_used ?? 0)

  if (currentBalance < cost) {
    return { success: false, new_balance: currentBalance, error: 'Nincs elég kredit' }
  }

  const newBalance = currentBalance - cost
  const newTotalUsed = currentTotalUsed + cost

  const { data: updated, error: updateErr } = await admin
    .from('user_credits')
    .update({ balance: newBalance, total_used: newTotalUsed })
    .eq('user_id', userId)
    .eq('balance', currentBalance)
    .gte('balance', cost)
    .select('balance')
    .single()

  if (updateErr || !updated) {
    return {
      success: false,
      new_balance: currentBalance,
      error: updateErr?.message || 'A kredit levonás nem sikerült. Próbáld újra.',
    }
  }

  await admin.from('ai_usage_logs').insert({
    user_id: userId,
    feature_name: feature,
    model: 'combined',
    input_tokens: 0,
    output_tokens: 0,
    estimated_cost_usd: 0,
    credits_charged: cost,
    metadata: { ...metadata, type: 'charge' },
  })

  return { success: true, new_balance: Number(updated.balance) }
}
