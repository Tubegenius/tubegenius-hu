// ============================================================
// WILLVIRAL — Channel Audit elokeszites (Phase 2 #8)
// ============================================================
// A mesterterv szerint a teljes Channel Audit kesobbi (YouTube OAuth-hoz
// kotott, Phase 3), de "elo kell keszíteni" — ez a mar meglevo Video Audit
// (egyenkenti audit) es Video Idea adatokbol aggregal, backend-szamolt
// atlagokkal (nem AI-becsles), es csak a "kovetkezo 10 video javaslat"
// resz hasznal AI-t, azt is a valos aggregalt adatra alapozva.

export interface DimensionAverages {
  hook_strength: number
  retention_potential: number
  engagement_quality: number
  platform_fit: number
  packaging_quality: number
}

export interface AuditSummaryItem {
  id: string
  video_title: string
  overall_score: number
  overall_label: string
  created_at: string
}

export function computeDimensionAverages(audits: Array<{ final_scores: Record<string, unknown> | null }>): DimensionAverages | null {
  if (audits.length === 0) return null
  const keys: (keyof DimensionAverages)[] = ['hook_strength', 'retention_potential', 'engagement_quality', 'platform_fit', 'packaging_quality']
  const sums: DimensionAverages = { hook_strength: 0, retention_potential: 0, engagement_quality: 0, platform_fit: 0, packaging_quality: 0 }
  let count = 0

  for (const audit of audits) {
    if (!audit.final_scores) continue
    count++
    for (const key of keys) {
      const value = Number(audit.final_scores[key] ?? 0)
      sums[key] += value
    }
  }
  if (count === 0) return null

  const averages = {} as DimensionAverages
  for (const key of keys) averages[key] = Math.round(sums[key] / count)
  return averages
}

export function findWeakestDimension(averages: DimensionAverages): { key: string; label: string; value: number } {
  const labels: Record<keyof DimensionAverages, string> = {
    hook_strength: 'Hook erősség',
    retention_potential: 'Retenciós potenciál',
    engagement_quality: 'Engagement minőség',
    platform_fit: 'Platform illeszkedés',
    packaging_quality: 'Csomagolás minőség',
  }
  const entries = Object.entries(averages) as [keyof DimensionAverages, number][]
  const weakest = entries.reduce((min, curr) => (curr[1] < min[1] ? curr : min), entries[0])
  return { key: weakest[0], label: labels[weakest[0]], value: weakest[1] }
}

export function computePublishRhythm(publishedIdeas: Array<{ updated_at: string }>): Array<{ month: string; count: number }> {
  const counts = new Map<string, number>()
  for (const idea of publishedIdeas) {
    const month = idea.updated_at.slice(0, 7)
    counts.set(month, (counts.get(month) || 0) + 1)
  }
  return Array.from(counts.entries())
    .map(([month, count]) => ({ month, count }))
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-6)
}

export function buildNextVideosPrompt(input: {
  weakestDimension: string
  strongTopics: string[]
  weakTopics: string[]
  niche: string
}): string {
  return `Egy magyar tartalomgyártó eddigi videói alapján kell javaslatot adnod a következő videóira.

NICHE: ${input.niche || 'általános'}
LEGGYENGÉBB TERÜLET AZ EDDIGI VIDEÓKBAN: ${input.weakestDimension}
LEGERŐSEBBEN TELJESÍTŐ KORÁBBI TÉMÁK: ${input.strongTopics.join(', ') || 'nincs adat'}
LEGGYENGÉBBEN TELJESÍTŐ KORÁBBI TÉMÁK: ${input.weakTopics.join(', ') || 'nincs adat'}

FELADAT:
Javasolj 10 konkrét videótémát, amik:
1. Építenek a jól teljesítő témák mintázatára (de NE ismételd meg szó szerint).
2. Tudatosan kerülik a gyenge témák hibáit.
3. Kifejezetten segítenek a leggyengébb területen (${input.weakestDimension}) javítani.

Minden javaslathoz adj egy rövid, 1 mondatos magyar indoklást, hogy MIÉRT ezt javaslod (hivatkozz a fenti mintázatokra).

KRITIKUS SZABÁLYOK:
- SOHA ne használj idézőjelet a JSON string értékek BELSEJÉBEN.

Válaszolj KIZÁRÓLAG valid JSON tömbben:
[{"topic": "konkrét videótéma", "reasoning": "1 mondatos magyar indoklás"}]`
}
