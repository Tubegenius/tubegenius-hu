// lib/search/query-variants.ts
// WillViral — Determinisztikus query variáns generálás a strukturált
// search contextből. Ez a "gyors" alapréteg (nem AI-hívás) — a Trend Radar /
// Opportunity Engine ezen felül AI-alapú seed generálást is futtat
// (lib/seed-generator.ts), de mindkettő ugyanabból a SearchContextből indul.

import type { SearchContext } from './search-context'

export type QueryType =
  | 'trend_radar'
  | 'serper_validation'
  | 'youtube_validation'
  | 'similar_videos'
  | 'video_package_sources'

const HU_SUFFIX_BY_TYPE: Record<QueryType, string[]> = {
  trend_radar: ['', ' friss kutatás', ' hír'],
  serper_validation: [' friss kutatás', ' hír'],
  youtube_validation: [''],
  similar_videos: [' videó'],
  video_package_sources: [' friss hír', ' kutatás'],
}

const EN_SUFFIX_BY_TYPE: Record<QueryType, string[]> = {
  trend_radar: ['', ' explained', ' new research'],
  serper_validation: [' new research', ' news'],
  youtube_validation: [' explained'],
  similar_videos: [' explained'],
  video_package_sources: [' news', ' research'],
}

export function generateQueryVariants(context: SearchContext, queryType: QueryType): string[] {
  const focus = context.specific_focus.trim()
  if (!focus) return []

  const suffixes = context.language === 'hu' ? HU_SUFFIX_BY_TYPE[queryType] : EN_SUFFIX_BY_TYPE[queryType]

  const variants = suffixes.map(suffix => `${focus}${suffix}`.trim())

  // Duplikátumok kiszűrése, megtartva a sorrendet
  return Array.from(new Set(variants))
}
