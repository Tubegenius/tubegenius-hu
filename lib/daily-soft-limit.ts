import { createServerClient } from '@supabase/ssr'
import { PAID_PLAN_DAILY_SOFT_LIMITS, type PaidPlanName } from '@/lib/plan-limits'

export interface DailySoftLimitDecision {
  allowed: boolean
  requiresOverride: boolean
  plan: string
  limit: number | null
  usedToday: number
  projectedUsage: number
}

export function evaluateDailySoftLimit(input: {
  plan: string
  usedToday: number
  cost: number
  override?: boolean
}): DailySoftLimitDecision {
  const plan = input.plan.toLowerCase()
  const limit = plan in PAID_PLAN_DAILY_SOFT_LIMITS ? PAID_PLAN_DAILY_SOFT_LIMITS[plan as PaidPlanName] : null
  const usedToday = Math.max(0, Number(input.usedToday) || 0)
  const projectedUsage = usedToday + Math.max(0, Number(input.cost) || 0)
  const exceeded = limit !== null && projectedUsage > limit
  return {
    allowed: !exceeded || input.override === true,
    requiresOverride: exceeded && input.override !== true,
    plan,
    limit,
    usedToday,
    projectedUsage,
  }
}

function adminClient() {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { cookies: { getAll() { return [] }, setAll() {} } }
  )
}

function budapestDateKey(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Budapest', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date)
}

export async function checkDailySoftLimit(
  userId: string,
  cost: number,
  override = false
): Promise<DailySoftLimitDecision> {
  const admin = adminClient()
  const [{ data: credits }, { data: recentCharges }] = await Promise.all([
    admin.from('user_credits').select('plan').eq('user_id', userId).single(),
    admin.from('ai_usage_logs')
      .select('credits_charged,created_at')
      .eq('user_id', userId)
      .gt('credits_charged', 0)
      .gte('created_at', new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString()),
  ])
  const today = budapestDateKey(new Date())
  const usedToday = (recentCharges || []).reduce((sum, row) => {
    return budapestDateKey(new Date(row.created_at)) === today
      ? sum + Number(row.credits_charged || 0)
      : sum
  }, 0)
  return evaluateDailySoftLimit({ plan: credits?.plan || 'free', usedToday, cost, override })
}

export function dailySoftLimitError(decision: DailySoftLimitDecision) {
  return {
    error: 'daily_soft_limit',
    message: `Elérted a ${decision.limit} kredites napi ajánlott keretet. Kifejezett jóváhagyással folytathatod.`,
    requires_soft_limit_override: true,
    daily_usage: decision.usedToday,
    daily_limit: decision.limit,
    projected_usage: decision.projectedUsage,
  }
}
