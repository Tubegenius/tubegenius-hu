// ============================================================
// WILLVIRAL — Keyword Research (Phase 2 #1)
// ============================================================
// Cel: ne csak SEO-lista legyen, hanem creator dontesi eszkoz — valos
// YouTube+web jelekbol, nem talalt szamokbol.

import { youtubeSearch, youtubeStats } from '@/lib/youtube-service'
import type { YouTubeVideoStats } from '@/lib/opportunity-scoring'

const SERPER_API_KEY = process.env.SERPER_API_KEY

// Megosztott YouTube-adatgyujto — a Keyword Research es a Content Gap Finder
// (Phase 2 #1 es #10) is ugyanezt hasznalja egy kulcsszo/tema valos
// YouTube-jelenletenek felmereserehez.
export async function fetchSeedVideoStats(seedKeyword: string, region: string): Promise<{ videos: YouTubeVideoStats[]; totalResults: number }> {
  const regionCode = region === 'HU' ? 'HU' : 'US'
  const language = region === 'HU' ? 'hu' : 'en'
  const items = await youtubeSearch(seedKeyword, regionCode, language, 365, 25, 'manualTopicSearch')
  if (items.length === 0) return { videos: [], totalResults: 0 }

  const videoIds = items.map(i => i.id.videoId)
  const statsMap = await youtubeStats(videoIds)

  const videos: YouTubeVideoStats[] = items.map(item => {
    const stats = statsMap.get(item.id.videoId)
    return {
      videoId: item.id.videoId,
      title: item.snippet.title,
      channelTitle: item.snippet.channelTitle,
      publishedAt: item.snippet.publishedAt,
      viewCount: parseInt(stats?.statistics?.viewCount || '0'),
      likeCount: parseInt(stats?.statistics?.likeCount || '0'),
      commentCount: parseInt(stats?.statistics?.commentCount || '0'),
      thumbnailUrl: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || '',
    }
  })

  return { videos, totalResults: items.length }
}

export interface KeywordSignals {
  relatedSearches: string[]
  peopleAlsoAsk: string[]
}

// A meglevo lib/trend-radar.ts fetchSerperWeb-je csak az organic talalatokat
// hasznositja — a Keyword Research-hez pont a Google "relatedSearches" es
// "peopleAlsoAsk" mezoi a hasznosak (ezek VALOS, nem AI altal talalt
// kulcsszo-jelek), ezert onallo, dedikalt hivas.
export async function fetchKeywordSignals(query: string, region: string): Promise<KeywordSignals> {
  if (!SERPER_API_KEY) return { relatedSearches: [], peopleAlsoAsk: [] }
  try {
    const gl = region === 'HU' ? 'hu' : 'us'
    const hl = region === 'HU' ? 'hu' : 'en'
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, gl, hl, num: 10 }),
    })
    const data = await res.json()
    if (!res.ok || data.statusCode || data.message) return { relatedSearches: [], peopleAlsoAsk: [] }

    const relatedSearches = ((data.relatedSearches || []) as Array<{ query?: string }>)
      .map(r => r.query)
      .filter((q): q is string => !!q)
      .slice(0, 8)

    const peopleAlsoAsk = ((data.peopleAlsoAsk || []) as Array<{ question?: string }>)
      .map(r => r.question)
      .filter((q): q is string => !!q)
      .slice(0, 6)

    return { relatedSearches, peopleAlsoAsk }
  } catch {
    return { relatedSearches: [], peopleAlsoAsk: [] }
  }
}

export interface RelatedKeywordSuggestion {
  keyword: string
  angle: string
  content_format_hint: string
}

export function buildKeywordClusterPrompt(input: {
  seedKeyword: string
  niche: string
  platform: string
  language: string
  relatedSearches: string[]
  peopleAlsoAsk: string[]
  seedVideoCount: number
  seedCompetition: number
}): string {
  return `Egy magyar tartalomgyártó ezt a kulcsszót kutatja: "${input.seedKeyword}"

NICHE: ${input.niche || 'általános'}
PLATFORM: ${input.platform}

VALÓS ADATOK (ezekre támaszkodj, ne találgass számokat):
- YouTube találatok száma erre a kulcsszóra: ${input.seedVideoCount}
- Backend-számolt verseny szint: ${input.seedCompetition}/100
- Google kapcsolódó keresések: ${input.relatedSearches.length > 0 ? input.relatedSearches.join(', ') : 'nincs adat'}
- "Emberek ezt is kérdezik" (Google): ${input.peopleAlsoAsk.length > 0 ? input.peopleAlsoAsk.join(' | ') : 'nincs adat'}

FELADAT:
A fenti VALÓS jelek alapján javasolj 8-12 konkrét, hosszabb (long-tail) kulcsszó/téma variációt, amit a creator feldolgozhat. Minden javaslathoz adj egy rövid, 1 mondatos magyar feldolgozási szöget (mi legyen a videó fókusza).

FONTOS SZABÁLYOK:
- NE találj ki keresési volument vagy statisztikát — ha nincs rá adat, ne mondj számot.
- Támaszkodj a fenti kapcsolódó keresésekre és kérdésekre, ha vannak — ezek valós Google-jelek.
- A javaslatok legyenek KONKRÉTABBAK, mint az eredeti kulcsszó (ne ismételd meg általánosan).
- content_format_hint: rövid javaslat a formátumra (pl. "listázós", "reakció", "how-to", "összehasonlítás", "mítosz-oszlatás").

Válaszolj KIZÁRÓLAG valid JSON tömbben:
[{"keyword": "konkrét hosszabb kulcsszó", "angle": "1 mondatos magyar feldolgozási szög", "content_format_hint": "rövid formátum-javaslat"}]`
}
