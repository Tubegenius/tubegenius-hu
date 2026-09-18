import type { CreatorLane } from '@/lib/creator-lane-presentation'
import type { Platform } from '@/lib/video-audit-scoring'

export type VideoAuditTone = 'strong' | 'developing' | 'critical'

export const VIDEO_AUDIT_PLATFORM_META: Record<Platform, { label: string; shortLabel: string; format: string; inputMode: 'url' | 'manual' }> = {
  youtube_long: { label: 'YouTube Long', shortLabel: 'YouTube', format: 'Hosszú videó', inputMode: 'url' },
  youtube_shorts: { label: 'YouTube Shorts', shortLabel: 'Shorts', format: 'Rövid videó', inputMode: 'url' },
  tiktok: { label: 'TikTok', shortLabel: 'TikTok', format: 'Rövid videó', inputMode: 'manual' },
  instagram_reels: { label: 'Instagram Reels', shortLabel: 'Reels', format: 'Rövid videó', inputMode: 'manual' },
  facebook_reels: { label: 'Facebook Reels', shortLabel: 'Facebook', format: 'Rövid videó', inputMode: 'manual' },
}

export const VIDEO_AUDIT_DIMENSIONS = [
  { key: 'hook_strength', label: 'Hook erőssége', weight: '25%' },
  { key: 'retention_potential', label: 'Megtartási potenciál', weight: '25%' },
  { key: 'engagement_quality', label: 'Aktivitás minősége', weight: '20%' },
  { key: 'platform_fit', label: 'Platformilleszkedés', weight: '15%' },
  { key: 'packaging_quality', label: 'Csomagolás minősége', weight: '15%' },
] as const

export const VIDEO_AUDIT_LANE_COPY: Record<CreatorLane, { lens: string; headline: string; support: string }> = {
  evidence: {
    lens: 'Bizonyítékvezérelt diagnosztikai nézet',
    headline: 'A legerősebb és a leggyengébb jelből legyen védhető alkotói döntés.',
    support: 'A Creator Lane a döntés olvasatát vezeti; az audit pontozását nem írja át.',
  },
  entertainment: {
    lens: 'Élményvezérelt diagnosztikai nézet',
    headline: 'Lásd, hol törik meg az impulzus, a tempó vagy a nézői élmény.',
    support: 'A Creator Lane a döntés olvasatát vezeti; az audit pontozását nem írja át.',
  },
}

export function videoAuditScoreTone(score: number): VideoAuditTone {
  if (score >= 75) return 'strong'
  if (score >= 60) return 'developing'
  return 'critical'
}

export function presentVideoAuditScore(score: number): number {
  if (!Number.isFinite(score)) return 0
  return Math.max(0, Math.min(100, Math.round(score)))
}

export function videoAuditFormReadiness(input: {
  platform: Platform
  videoUrl: string
  topic: string
  title: string
  durationSeconds: number
}): { ready: boolean; hint: string } {
  const mode = VIDEO_AUDIT_PLATFORM_META[input.platform].inputMode
  if (mode === 'url') {
    return input.videoUrl.trim()
      ? { ready: true, hint: 'A YouTube-link készen áll az ellenőrzésre.' }
      : { ready: false, hint: 'Illeszd be az elemezni kívánt YouTube-videó linkjét.' }
  }
  if (!input.topic.trim()) return { ready: false, hint: 'Add meg a videó témáját.' }
  if (!input.title.trim()) return { ready: false, hint: 'Add meg a videó címét vagy captionjét.' }
  if (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0) return { ready: false, hint: 'Adj meg érvényes videóhosszt.' }
  return { ready: true, hint: 'A manuális teljesítményadatok készen állnak.' }
}

export interface VideoAuditDecisionInput {
  decision?: string
  weakestDimension?: string
  reason?: string
  overallAction?: string
  overallMeaning?: string
}

export function presentVideoAuditDecision(input: VideoAuditDecisionInput) {
  const decision = input.decision || 'Remix'
  const map: Record<string, { title: string; action: string; note: string }> = {
    Folytatás: { title: 'Skálázd tovább', action: 'Készíts folytatást vagy közeli változatot ugyanarra az ígéretre.', note: 'A szerkezet működik; az ismétlés és a tudatos variálás többet érhet egy teljes újratervezésnél.' },
    Reupload: { title: 'Töltsd újra finomhangolva', action: 'Tartsd meg az alapötletet, de javíts a címen, a nyitáson vagy a csomagoláson.', note: 'Az alap megtartható, a belépési pontokon lehet még nyerni.' },
    Rehook: { title: 'Írd újra a nyitást', action: 'Az első 3–5 másodpercben indíts erősebb konfliktussal vagy ígérettel.', note: 'A téma menthető, de a nézőnek hamarabb kell okot adni a maradásra.' },
    Repackage: { title: 'Csomagold újra', action: 'Cseréld a címet, a thumbnail szövegét, a captiont és az első képi ígéretet.', note: 'A tartalom értéke és a külső ígéret jelenleg nincs elég közel egymáshoz.' },
    Remix: { title: 'Vágd újra', action: 'Húzd előre a legerősebb részt, és vedd ki a lassú bevezetést.', note: 'Van menthető jel, de a tempó vagy a felépítés nem elég feszes.' },
    Replatform: { title: 'Válts formátumot', action: 'Tartsd meg az ötletet, de építsd újra a célplatform logikájára.', note: 'A téma helyett a forma és a platformilleszkedés lehet a szűk keresztmetszet.' },
    Abandon: { title: 'Ne erre építs tovább', action: 'Válassz új témát vagy teljesen más szöget, mielőtt további gyártási időt teszel bele.', note: 'A jelenlegi forma túl sok fő ponton gyenge ahhoz, hogy ez legyen a legjobb következő lépés.' },
  }
  const selected = map[decision] || map.Remix
  const weakest = input.weakestDimension && input.weakestDimension !== '-' ? input.weakestDimension : null

  return {
    decision,
    ...selected,
    weakest,
    reason: input.reason || input.overallAction || input.overallMeaning || 'A döntés a kapott auditpontszámok és dimenziók alapján készült.',
  }
}
