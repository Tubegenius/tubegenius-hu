// ============================================================
// WILLVIRAL — Creator profil niche-kontextus (channel_usage_mode-tudatos)
// ============================================================
// Egyetlen belepesi pont minden AI-generalo route szamara, ami eldonti,
// hogy a profil niche-e bekerulhet-e a promptba. A meglevo shouldUseProfileNiche()
// (lib/niche-relevance.ts) relevancia-kapuja valtozatlan marad — ez a modul
// csak egy elozetes rovidzarlatot told ele: ha a user a "Csak statisztikai
// elemzesre hasznalja" (stats_only) modot valasztotta az onboardingban, a
// csatorna/profil niche-e SOSE szivaroghat be generalo promptba, meg akkor
// sem, ha a temaval egyebkent releváns lenne — csak a Channel Audit sajat
// audit-history szurese (lib/channel-audit.ts effectiveNiche) olvashatja.

import { shouldUseProfileNiche } from '@/lib/niche-relevance'

export function resolveCreatorNicheContext(input: {
  topic: string
  channelUsageMode?: string | null
  niche?: string | null
  mainCategory?: string | null
  specificFocus?: string | null
}): { niche: string; useNiche: boolean } {
  const niche = input.niche || ''

  if (input.channelUsageMode === 'stats_only') {
    return { niche, useNiche: false }
  }

  const useNiche = shouldUseProfileNiche({
    topic: input.topic,
    profileNiche: niche,
    mainCategory: input.mainCategory,
    specificFocus: input.specificFocus,
  })

  return { niche, useNiche }
}
