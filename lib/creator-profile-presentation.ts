import type { CreatorLane } from '@/lib/creator-lane-presentation'

export const CREATOR_PROFILE_LANE_GUIDE: Record<CreatorLane, { label: string; role: string; headline: string; signals: readonly string[] }> = {
  evidence: {
    label: 'Bizonyítékvezérelt',
    role: 'Amikor a tartalom állításokra és bizonyítható összefüggésekre épül.',
    headline: 'A kutatás, az állítás és a magyarázat együtt tartja a videót.',
    signals: ['Kutatási igény', 'Tényállítások', 'Forráskapu'],
  },
  entertainment: {
    label: 'Élményvezérelt',
    role: 'Amikor a tartalom elsődleges értéke a szórakozás, a jelenet vagy az impulzus.',
    headline: 'A nyitás, az élményív és a kifizetés együtt tartja a videót.',
    signals: ['Nyitási impulzus', 'Jelenetritmus', 'Kifizetés'],
  },
}

export type CreatorProfileFocusKind = 'needs_focus' | 'niche_review' | 'ready'

export function deriveCreatorProfileFocus(input: { specificFocus: string; nicheNeedsReview: boolean }): {
  kind: CreatorProfileFocusKind
  label: string
  title: string
  description: string
} {
  if (input.nicheNeedsReview) return {
    kind: 'niche_review', label: 'Döntés szükséges', title: 'Erősítsd meg, melyik niche tartozik az aktív csatornához.',
    description: 'A döntésig a rendszer nem kezeli automatikusan érvényesnek a korábbi niche-t az új csatornához.',
  }
  if (!input.specificFocus.trim()) return {
    kind: 'needs_focus', label: 'Profilmag', title: 'Nevezd meg a konkrét tartalmi fókuszt.',
    description: 'Ez az egyetlen kötelező profilmező, és ez szűkíti a személyre szabott lehetőségkeresést.',
  }
  return {
    kind: 'ready', label: 'Profilmag', title: input.specificFocus.trim(),
    description: 'A konkrét fókusz mentésre kész; a többi mező tovább finomítja a személyre szabást.',
  }
}

export function creatorProfileMarketLabel(region: string, language: string): string {
  if (region === 'HU') return 'Magyar piac · hu'
  if (region === 'US') return 'Globális · en'
  return `Több piac · ${language}`
}
