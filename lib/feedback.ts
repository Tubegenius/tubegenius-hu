// ============================================================
// WILLVIRAL — Feedback Loop (KÖR 1)
// Egyszerű, szabályalapú tanulás a topic_feedback adatokból
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export const REJECT_REASONS = [
  'Nem illik a csatornámhoz',
  'Túl komoly',
  'Túl unalmas',
  'Túl sokan feldolgozták',
  'Túl nehéz megcsinálni',
  'Nem elég aktuális',
  'Nem érzem virálisnak',
  'Már csináltam hasonlót',
  'Egyéb',
] as const

export type RejectReason = typeof REJECT_REASONS[number]

export interface FeedbackAdjustments {
  /** Ezeket a kategóriákat kerüljük a kulcsszógenerálásnál (3+ "Nem illik" / "Túl komoly" elutasítás) */
  excludedCategories: Set<string>
  /** Ezekre a kategóriákra extra competition büntetés (3+ "Túl sokan feldolgozták") */
  competitionBoostCategories: Set<string>
  /** Globális freshness súly-bónusz (2+ "Nem elég aktuális") */
  freshnessBoost: number
  /** Globális "nehézség" büntetés kategóriánként (2+ "Túl nehéz megcsinálni") */
  difficultyPenaltyCategories: Set<string>
}

const CATEGORY_PENALTY_REASONS: RejectReason[] = ['Nem illik a csatornámhoz', 'Túl komoly', 'Túl unalmas', 'Már csináltam hasonlót']
const COMPETITION_REASONS: RejectReason[] = ['Túl sokan feldolgozták']
const FRESHNESS_REASONS: RejectReason[] = ['Nem elég aktuális']
const DIFFICULTY_REASONS: RejectReason[] = ['Túl nehéz megcsinálni']

const EXCLUDE_THRESHOLD = 3
const BOOST_THRESHOLD = 2

/**
 * A user korábbi feedbackjéből (utolsó 30 reject) levezetjük a súlymódosításokat.
 * Ez egyszerű szabályalapú logika — NEM ML, NEM Claude-alapú.
 */
export async function computeFeedbackAdjustments(admin: SupabaseClient, userId: string): Promise<FeedbackAdjustments> {
  const { data } = await admin
    .from('topic_feedback')
    .select('reason, niche_cluster')
    .eq('user_id', userId)
    .eq('feedback_type', 'reject')
    .order('created_at', { ascending: false })
    .limit(30)

  const items = data || []

  const categoryPenaltyCounts: Record<string, number> = {}
  const competitionCounts: Record<string, number> = {}
  const difficultyCounts: Record<string, number> = {}
  let freshnessCount = 0

  for (const item of items) {
    const reason = item.reason as RejectReason | null
    const cluster = item.niche_cluster as string | null
    if (!reason) continue

    if (cluster && CATEGORY_PENALTY_REASONS.includes(reason)) {
      categoryPenaltyCounts[cluster] = (categoryPenaltyCounts[cluster] || 0) + 1
    }
    if (cluster && COMPETITION_REASONS.includes(reason)) {
      competitionCounts[cluster] = (competitionCounts[cluster] || 0) + 1
    }
    if (cluster && DIFFICULTY_REASONS.includes(reason)) {
      difficultyCounts[cluster] = (difficultyCounts[cluster] || 0) + 1
    }
    if (FRESHNESS_REASONS.includes(reason)) {
      freshnessCount++
    }
  }

  const excludedCategories = new Set(
    Object.entries(categoryPenaltyCounts).filter(([, c]) => c >= EXCLUDE_THRESHOLD).map(([cat]) => cat)
  )
  const competitionBoostCategories = new Set(
    Object.entries(competitionCounts).filter(([, c]) => c >= BOOST_THRESHOLD).map(([cat]) => cat)
  )
  const difficultyPenaltyCategories = new Set(
    Object.entries(difficultyCounts).filter(([, c]) => c >= BOOST_THRESHOLD).map(([cat]) => cat)
  )

  // Freshness boost: minél több "nem elég aktuális" jelzés, annál nagyobb a bónusz (max +20)
  const freshnessBoost = Math.min(20, freshnessCount * 5)

  return { excludedCategories, competitionBoostCategories, freshnessBoost, difficultyPenaltyCategories }
}

/**
 * Score-módosítás alkalmazása a feedback alapján.
 * Ez NEM Claude — tisztán backend aritmetika.
 */
export function applyFeedbackToScore(
  baseTotal: number,
  category: string,
  freshness: number,
  adjustments: FeedbackAdjustments
): number {
  let adjusted = baseTotal

  // "Túl sokan feldolgozták" -> extra büntetés erre a kategóriára
  if (adjustments.competitionBoostCategories.has(category)) {
    adjusted -= 10
  }

  // "Túl nehéz megcsinálni" -> kategória büntetés
  if (adjustments.difficultyPenaltyCategories.has(category)) {
    adjusted -= 8
  }

  // "Nem elég aktuális" -> friss témák extra bónuszt kapnak
  if (adjustments.freshnessBoost > 0 && freshness >= 60) {
    adjusted += adjustments.freshnessBoost * 0.3
  }

  return Math.round(Math.max(0, Math.min(100, adjusted)))
}
