// ============================================================
// WILLVIRAL — Credit System Helper
// ============================================================
// Anthropic Claude árazás (kb. USD/millió token)
// Sonnet: $3 input / $15 output
// Haiku:  $0.25 input / $1.25 output (~12x olcsóbb)

import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { MODELS } from '@/lib/models'
import { checkDailySoftLimit, type DailySoftLimitDecision } from '@/lib/daily-soft-limit'
import { randomUUID } from 'crypto'

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
  | 'channel_audit'
  | 'niche_discovery_refresh'

export type UsageFeatureName = FeatureName | 'opportunity_engine' | 'similar_videos'

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
  channel_audit: 2,
  niche_discovery_refresh: 1,
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

export interface CreditChargeReceipt {
  credit_transaction_id: string
  subscription_spent: number
  purchased_spent: number
}

export async function getUserId(): Promise<string | null> {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { cookies: { getAll() { return cookieStore.getAll() }, setAll() {} } }
  )
  const { data: { user } } = await supabase.auth.getUser()
  return user?.id || null
}

export async function getCreditBalance(userId: string): Promise<{ balance: number; plan: string; subscription_balance: number; purchased_balance: number } | null> {
  const admin = adminClient()
  const { data, error } = await admin
    .from('user_credits')
    .select('balance, plan, subscription_credit_balance, purchased_credit_balance')
    .eq('user_id', userId)
    .single()

  if (error || !data) return null
  return {
    balance: Number(data.balance),
    plan: data.plan,
    subscription_balance: Number(data.subscription_credit_balance ?? 0),
    purchased_balance: Number(data.purchased_credit_balance ?? 0),
  }
}

export async function hasEnoughCredits(userId: string, feature: FeatureName): Promise<boolean> {
  const credits = await getCreditBalance(userId)
  if (!credits) return false
  return credits.balance >= CREDIT_COSTS[feature]
}

// ─── Csak USAGE LOG (nem von le kreditet) — több AI hívás logolásához egy feature-ön belül ───
export async function logUsage(
  userId: string,
  feature: UsageFeatureName,
  model: string,
  inputTokens: number,
  outputTokens: number,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  const admin = adminClient()
  const estimatedCostUsd = estimateCost(model, inputTokens, outputTokens)

  const { error: usageLogError } = await admin.from('ai_usage_logs').insert({
    user_id: userId,
    feature_name: feature,
    model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    estimated_cost_usd: estimatedCostUsd,
    credits_charged: 0, // a tényleges levonás külön történik
    metadata,
  })
  if (usageLogError) console.error('[Credits] usage telemetry log failed:', usageLogError)
}

// ─── Kredit levonás egyszer, a feature teljes díja ───
export async function chargeFeature(
  userId: string,
  feature: FeatureName,
  metadata: Record<string, unknown> = {}
): Promise<{ success: boolean; new_balance?: number; error?: string } & Partial<CreditChargeReceipt>> {
  const admin = adminClient()
  const cost = CREDIT_COSTS[feature]
  const { data, error } = await admin.rpc('spend_credits', {
    p_user_id: userId,
    p_cost: cost,
    p_feature: feature,
    p_external_ref: `spend:${randomUUID()}`,
    p_metadata: metadata,
  })
  if (error || !data) {
    const current = await getCreditBalance(userId)
    const insufficient = String(error?.message || '').includes('insufficient credits')
    if (error && !insufficient) console.error('[Credits] spend_credits RPC hiba:', error)
    return { success: false, new_balance: current?.balance, error: insufficient ? 'Nincs elég kredit' : 'A kredit levonás nem sikerült.' }
  }
  const receipt = data as Record<string, unknown>
  const transactionId = String(receipt.transaction_id || '')
  const updatedBalance = Number(receipt.total_balance)
  if (!transactionId || !Number.isFinite(updatedBalance)) return { success: false, error: 'A kredit tranzakció válasza hibás.' }

  const { error: chargeLogError } = await admin.from('ai_usage_logs').insert({
    user_id: userId,
    feature_name: feature,
    model: 'combined',
    input_tokens: 0,
    output_tokens: 0,
    estimated_cost_usd: 0,
    credits_charged: cost,
    metadata: { ...metadata, type: 'charge', credit_transaction_id: transactionId },
  })
  if (chargeLogError) {
    console.error('[Credits] charge audit log failed, refunding:', chargeLogError)
    const refund = await refundCreditsAfterPersistenceFailure(userId, feature, cost, { ...metadata, reason: 'charge_audit_log_failed' }, transactionId)
    return { success: false, new_balance: refund.new_balance, error: refund.success ? 'A kreditművelet naplózása sikertelen volt, a kreditet visszaadtuk.' : 'A kreditművelet helyreállítása sikertelen.' }
  }

  return {
    success: true,
    new_balance: updatedBalance,
    credit_transaction_id: transactionId,
    subscription_spent: Number(receipt.subscription_spent || 0),
    purchased_spent: Number(receipt.purchased_spent || 0),
  }
}

export async function refundCreditsAfterPersistenceFailure(
  userId: string,
  feature: string,
  cost: number,
  metadata: Record<string, unknown> = {},
  creditTransactionId?: string,
): Promise<{ success: boolean; new_balance?: number }> {
  const admin = adminClient()
  if (!creditTransactionId) {
    console.error('[Credits] bucket refund refused without original transaction id', { userId, feature })
    return { success: false }
  }
  const { data, error } = await admin.rpc('refund_credit_spend', {
    p_user_id: userId,
    p_spend_transaction_id: creditTransactionId,
    p_external_ref: `refund:${creditTransactionId}`,
    p_metadata: { ...metadata, feature, expected_cost: cost },
  })
  if (error || !data) {
    console.error('[Credits] refund_credit_spend RPC hiba:', error)
    return { success: false }
  }
  const refund = data as Record<string, unknown>
  const { error: refundLogError } = await admin.from('ai_usage_logs').insert({
    user_id: userId, feature_name: feature, model: 'system_refund', input_tokens: 0,
    output_tokens: 0, estimated_cost_usd: 0, credits_charged: -cost,
    metadata: { ...metadata, type: 'persistence_failure_refund', credit_transaction_id: creditTransactionId },
  })
  if (refundLogError) console.error('[Credits] refund audit log failed:', refundLogError)
  return { success: true, new_balance: Number(refund.total_balance) }
}

export async function checkPaidFeatureAccess(
  userId: string,
  feature: FeatureName,
  overrideSoftLimit = false
): Promise<{ allowed: boolean; reason?: 'insufficient_credits' | 'daily_soft_limit'; dailyLimit?: DailySoftLimitDecision }> {
  const credits = await getCreditBalance(userId)
  if (!credits || credits.balance < CREDIT_COSTS[feature]) {
    return { allowed: false, reason: 'insufficient_credits' }
  }
  const dailyLimit = await checkDailySoftLimit(userId, CREDIT_COSTS[feature], overrideSoftLimit)
  if (!dailyLimit.allowed) return { allowed: false, reason: 'daily_soft_limit', dailyLimit }
  return { allowed: true, dailyLimit }
}
