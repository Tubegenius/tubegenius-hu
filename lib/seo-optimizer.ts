// ============================================================
// WILLVIRAL — SEO / Upload Optimizer (Phase 2 #6)
// ============================================================
// A merheto reszek (cim/leiras hossz, kulcsszo lefedettseg az elso sorokban,
// tag-szam) backend-szamoltak — objektiv checklist, nem AI-becsles.

import { STAY_ON_TOPIC_RULE } from './niche-relevance'

export interface SeoHeuristics {
  title_length: number
  title_length_flag: 'ok' | 'too_long' | 'too_short'
  description_first_line_length: number
  description_first_line_has_keyword: boolean
  keyword_coverage_in_title: number
  tag_count: number
  tag_count_flag: 'ok' | 'too_few' | 'too_many'
}

export function computeSeoHeuristics(input: {
  title: string
  description: string
  keywords: string[]
  tags: string[]
}): SeoHeuristics {
  const titleLower = input.title.toLowerCase()
  const keywordsPresent = input.keywords.filter(k => titleLower.includes(k.toLowerCase())).length
  const firstLine = (input.description.split('\n')[0] || '').trim()
  const firstLineLower = firstLine.toLowerCase()

  return {
    title_length: input.title.length,
    title_length_flag: input.title.length > 70 ? 'too_long' : input.title.length < 15 ? 'too_short' : 'ok',
    description_first_line_length: firstLine.length,
    description_first_line_has_keyword: input.keywords.some(k => firstLineLower.includes(k.toLowerCase())),
    keyword_coverage_in_title: input.keywords.length > 0 ? Math.round((keywordsPresent / input.keywords.length) * 100) : 0,
    tag_count: input.tags.length,
    tag_count_flag: input.tags.length < 5 ? 'too_few' : input.tags.length > 15 ? 'too_many' : 'ok',
  }
}

export interface SeoPackage {
  seo_title: string
  description: string
  tags: string[]
  hashtags: string[]
  chapters: Array<{ timestamp: string; label: string }>
  playlist_suggestion: string
  pinned_comment: string
  end_screen_cta: string
}

export function computeSeoScore(h: SeoHeuristics): number {
  return Math.round((h.title_length_flag === 'ok' ? 25 : 10) + (h.description_first_line_has_keyword ? 25 : 10) + Math.max(0, Math.min(25, h.keyword_coverage_in_title / 4)) + (h.tag_count_flag === 'ok' ? 25 : 10))
}

export function isValidSeoPackage(value: unknown): value is SeoPackage {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  const text = (key: string, max: number) => typeof v[key] === 'string' && (v[key] as string).length <= max
  const strings = (key: string, count: number, max: number) => Array.isArray(v[key]) && (v[key] as unknown[]).length <= count && (v[key] as unknown[]).every(x => typeof x === 'string' && x.length <= max)
  return text('seo_title', 120) && text('description', 10000) && strings('tags', 20, 100) && strings('hashtags', 10, 100) && Array.isArray(v.chapters) && v.chapters.length <= 20 && v.chapters.every(c => !!c && typeof c === 'object' && typeof (c as Record<string, unknown>).timestamp === 'string' && typeof (c as Record<string, unknown>).label === 'string') && text('playlist_suggestion', 500) && text('pinned_comment', 1000) && text('end_screen_cta', 500)
}

export function buildSeoOptimizerPrompt(input: { topic: string; existingTitle?: string; niche: string; useNiche: boolean; platform: string }): string {
  return `Egy magyar tartalomgyártónak kell egy teljes SEO/feltöltési csomagot írnod ehhez a videóhoz.

TÉMA: "${input.topic}"
${input.existingTitle ? `CÍM: "${input.existingTitle}"` : ''}
${input.useNiche && input.niche ? `NICHE: ${input.niche}\n` : ''}PLATFORM: ${input.platform}

FELADAT — adj meg MINDENT az alábbiakból:
- seo_title: kulcsszó-optimalizált cím (ha volt megadott cím, finomítsd, ne cseréld le teljesen)
- description: 3-5 bekezdéses magyar leírás, az ELSŐ SOR tartalmazza a fő kulcsszót és keltsen kíváncsiságot (ez jelenik meg keresésben)
- tags: 8-12 releváns YouTube tag (kulcsszavak, ne hashtag formátumban)
- hashtags: 3-5 hashtag (#-tel), amik a leírás alá kerülnek
- chapters: 4-6 fejezet időbélyeg-becsléssel (pl. "0:00", "1:30"), realisztikus időzítéssel egy átlagos videóhoz
- playlist_suggestion: milyen lejátszási listába illene ez a videó
- pinned_comment: 1-2 mondatos kitűzhető komment, ami beszélgetést indít
- end_screen_cta: 1 mondatos végképernyő szöveg-javaslat (mire kattintson a néző)

KRITIKUS SZABÁLYOK:
- SOHA ne használj idézőjelet a JSON string értékek BELSEJÉBEN.
- A description bekezdései sortöréssel (\\n) legyenek elválasztva.
- ${STAY_ON_TOPIC_RULE}
- A szöveg teljesen magyar nyelvű legyen, idegen szavak nélkül (kivéve közismert márkanév vagy szakkifejezés).

Válaszolj KIZÁRÓLAG valid JSON objektumban:
{"seo_title": "...", "description": "...", "tags": ["..."], "hashtags": ["..."], "chapters": [{"timestamp": "0:00", "label": "..."}], "playlist_suggestion": "...", "pinned_comment": "...", "end_screen_cta": "..."}`
}
