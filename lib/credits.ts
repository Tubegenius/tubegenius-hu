// ============================================================
// WILLVIRAL — Credit System Helper
// ============================================================
// Anthropic Claude árazás (kb. USD/millió token)
// Sonnet: $3 input / $15 output
// Haiku:  $0.25 input / $1.25 output (~12x olcsóbb)

import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export type FeatureName =
  | 'video_package_shorts'
  | 'video_package_long'
  | 'viral_score'
  | 'opportunity_explain'
  | 'script_extract'
  | 'video_audit'
  | 'hashtag_caption'

// Credit költségek funkciónként (a spec szerint)
export const CREDIT_COSTS: Record<FeatureName, number> = {
  hashtag_caption: 0.5,
  opportunity_explain: 1,
  viral_score: 1,
  video_package_shorts: 2,
  script_extract: 3,
  video_audit: 4,
  video_package_long: 6,
}

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-3-5-haiku-20241022': { input: 0.25, output: 1.25 },
}

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING['claude-sonnet-4-5']
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

  const newBalance = Number(current.balance) - cost
  const newTotalUsed = Number(current.total_used) + cost

  const { error: updateErr } = await admin
    .from('user_credits')
    .update({ balance: newBalance, total_used: newTotalUsed })
    .eq('user_id', userId)

  if (updateErr) {
    return { success: false, error: updateErr.message }
  }

  // Összesítő log a charge-ról
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

  return { success: true, new_balance: newBalance }
}
