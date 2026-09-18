import type { CreatorLane } from '@/lib/creator-lane-presentation'

export type ChannelAuditDimensionKey =
  | 'hook_strength'
  | 'retention_potential'
  | 'engagement_quality'
  | 'platform_fit'
  | 'packaging_quality'

export type ChannelAuditDimensionAverages = Record<ChannelAuditDimensionKey, number>

export const CHANNEL_AUDIT_DIMENSION_LABELS: Record<ChannelAuditDimensionKey, string> = {
  hook_strength: 'Hook erőssége',
  retention_potential: 'Megtartási potenciál',
  engagement_quality: 'Aktivitás minősége',
  platform_fit: 'Platformilleszkedés',
  packaging_quality: 'Csomagolás minősége',
}

export const CHANNEL_AUDIT_LANE_COPY: Record<CreatorLane, { lens: string; headline: string; support: string }> = {
  evidence: {
    lens: 'Bizonyítékvezérelt csatornanézet',
    headline: 'Lásd, melyik alkotói döntésedet támasztja alá a legerősebb minta.',
    support: 'A diagnosztikai profil a beküldött videóauditokat rendezi döntési képpé.',
  },
  entertainment: {
    lens: 'Élményvezérelt csatornanézet',
    headline: 'Lásd, hol erős a nézői impulzus, és hol veszít lendületet a csatorna.',
    support: 'A diagnosztikai profil a beküldött videóauditokat rendezi kreatív döntési képpé.',
  },
}

export interface ChannelAuditFocusInput {
  loading: boolean
  loadError: boolean
  generating: boolean
  suggestionError: boolean
  nicheReviewRequired: boolean
  channelConnected: boolean | null
  hasChannelProfile: boolean
  hasEnoughData: boolean
  canGenerateSuggestions: boolean
  auditCount: number
  minimumAudits: number
  relevantAuditCount: number
  minimumRelevantAudits: number
  suggestionCount: number
}

export type ChannelAuditFocusKind =
  | 'loading'
  | 'load_error'
  | 'niche_review'
  | 'generating'
  | 'suggestion_error'
  | 'connect'
  | 'build_evidence'
  | 'build_relevance'
  | 'ready'
  | 'suggestions'

export interface ChannelAuditFocus {
  kind: ChannelAuditFocusKind
  label: string
  title: string
  description: string
  progressCurrent?: number
  progressTarget?: number
}

export function deriveChannelAuditFocus(input: ChannelAuditFocusInput): ChannelAuditFocus {
  if (input.loading || input.channelConnected === null) return { kind: 'loading', label: 'Elemzés', title: 'A csatornakép összeáll…', description: '' }
  if (input.loadError) return { kind: 'load_error', label: 'Betöltési hiba', title: 'A csatornakép most nem érhető el.', description: 'Próbáld újra; a korábbi adatok ettől nem változnak.' }
  if (input.nicheReviewRequired) return { kind: 'niche_review', label: 'Döntés szükséges', title: 'Erősítsd meg, melyik niche-hez tartozik ez a csatorna.', description: 'A döntésig nem indul fizetős témagenerálás.' }
  if (input.generating) return { kind: 'generating', label: 'Elemzés folyamatban', title: 'A következő tartalomirányok készülnek.', description: 'Az auditmintázatból épülő javaslatokat rendezzük.' }
  if (input.suggestionError) return { kind: 'suggestion_error', label: 'Javaslathiba', title: 'A tartalomirányok most nem készültek el.', description: 'A diagnosztikai adatok megmaradtak; újraindíthatod a kérést.' }
  if (input.channelConnected === false) return {
    kind: 'connect',
    label: input.hasChannelProfile ? 'Publikus csatornakép' : 'Csatornakapcsolat',
    title: input.hasChannelProfile ? 'Nyisd meg a valós teljesítménypulzust.' : 'Kapcsold össze a YouTube-csatornád.',
    description: 'A privát analitika megtekintést, watch time-ot és feliratkozói mozgást ad a diagnosztikai profil mellé.',
  }
  if (!input.hasEnoughData) return {
    kind: 'build_evidence', label: 'Diagnosztikai alap', title: 'Építs megbízható csatornamintát.',
    description: `Legalább ${input.minimumAudits} Videódiagnózis szükséges a mintázat-elemzéshez.`,
    progressCurrent: input.auditCount, progressTarget: input.minimumAudits,
  }
  if (!input.canGenerateSuggestions && input.suggestionCount === 0) return {
    kind: 'build_relevance', label: 'Relevanciaalap', title: 'Még niche-releváns diagnózisokra van szükség.',
    description: 'Az előzetes ellenőrzés ingyenes; témagenerálás még nem indul.',
    progressCurrent: input.relevantAuditCount, progressTarget: input.minimumRelevantAudits,
  }
  if (input.suggestionCount > 0) return { kind: 'suggestions', label: 'Következő irány', title: `${input.suggestionCount} tartalomirány készen áll.`, description: 'A javaslatok az aktuális auditmintázatból származnak.' }
  return { kind: 'ready', label: 'Következő irány', title: 'A csatornaminta készen áll a következő lépésre.', description: `${input.auditCount} audit alapján kérhetsz új tartalomirányokat.` }
}

export function presentChannelAuditDimensions(averages: ChannelAuditDimensionAverages, weakestKey?: string) {
  return (Object.keys(CHANNEL_AUDIT_DIMENSION_LABELS) as ChannelAuditDimensionKey[]).map(key => {
    const raw = averages[key]
    return {
      key,
      label: CHANNEL_AUDIT_DIMENSION_LABELS[key],
      value: Math.max(0, Math.min(100, Number.isFinite(raw) ? raw : 0)),
      isWeakest: key === weakestKey,
    }
  })
}
