import type { NicheCategory } from './niche-seeds'
import { buildNicheExpansion } from './niche-expansion'

export type NicheIntent = 'specific_topic' | 'broad_niche'

export interface BroadDiscoveryPack {
  label: string
  category: NicheCategory
  seeds: string[]
  freshnessWindowDays: number
  searchRegion: 'HU' | 'US'
}

function normalize(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const BROAD_FACT_PATTERNS = [
  /\berdekes\s+tenyek\b/i,
  /\btudtad\b/i,
  /\btudtad\s+hogy\b/i,
  /\bfun\s+facts\b/i,
  /\binteresting\s+facts\b/i,
  /\bdid\s+you\s+know\b/i,
  /\bfacts\b/i,
  /\btop\s+10\b/i,
  /\blisticle\b/i,
]

const GENERIC_NICHE_WORDS = new Set([
  'erdekes', 'tenyek', 'dolgok', 'videok', 'facts', 'interesting', 'viral', 'trend', 'trending', 'shorts',
])

const BROAD_NICHE_CATEGORIES = new Set([
  'autok', 'auto', 'cars', 'automotive',
  'sport', 'sports', 'foci', 'focilab', 'futball', 'football', 'soccer',
  'gaming', 'jatek', 'jatekok', 'games',
  'zene', 'music', 'zenei',
  'film', 'filmek', 'movies', 'sorozat', 'sorozatok', 'series',
  'horror', 'krimi', 'thriller', 'mystery', 'true crime',
  'egeszseg', 'health', 'fitness', 'edzes', 'workout',
  'penzugy', 'finance', 'money', 'penz', 'befektetes', 'investing', 'crypto', 'kripto',
  'tech', 'technology', 'technologia', 'it',
  'tudomany', 'science',
  'tortenelem', 'history', 'tortenet',
  'pszichologia', 'psychology', 'lelelek', 'mental',
  'utazas', 'travel', 'travelling',
  'fozas', 'cooking', 'recept', 'konyha', 'food',
  'divat', 'fashion', 'beauty', 'szepseg',
  'allatok', 'animals', 'pets', 'termeszet', 'nature',
  'urteknologia', 'space', 'ur', 'urkutatas',
  'motivacio', 'motivation', 'onismeret', 'selfhelp',
  'hirek', 'news', 'politika', 'politics',
  'oktatas', 'education', 'tanulas', 'learning',
  'diy', 'barkacs', 'crafts',
  'meme', 'memes', 'humor', 'comedy', 'vicc',
  'rejtely', 'rejtelyek', 'mysteries', 'paranormal',
  'hadtortenet', 'military', 'haboru', 'war',
])

export function detectNicheIntent(niche: string): NicheIntent {
  const value = normalize(niche)
  if (!value) return 'specific_topic'
  if (BROAD_FACT_PATTERNS.some(pattern => pattern.test(value))) return 'broad_niche'

  const commaSegments = niche.split(/[,;\/]+/).map(s => s.trim()).filter(s => s.length > 1)
  if (commaSegments.length >= 2) {
    const broadCount = commaSegments.filter(seg => {
      const norm = normalize(seg)
      return BROAD_NICHE_CATEGORIES.has(norm) || norm.split(/\s+/).some(w => BROAD_NICHE_CATEGORIES.has(w))
    }).length
    if (broadCount >= 2) return 'broad_niche'
  }

  const words = value.split(/\s+/).filter(Boolean)
  const genericCount = words.filter(word => GENERIC_NICHE_WORDS.has(word)).length
  if (words.length <= 3 && genericCount >= Math.max(1, words.length - 1)) return 'broad_niche'

  if (words.length <= 2 && words.some(w => BROAD_NICHE_CATEGORIES.has(w))) return 'broad_niche'
  if (words.length === 1 && words[0].length <= 15) return 'broad_niche'
  if (words.length <= 3 && !value.includes('2025') && !value.includes('2026') && !/\d{4,}/.test(value)) {
    const hasSpecificEntity = /[A-ZÁÉÍÓÖŐÚÜŰ]/.test(niche.trim().slice(1))
    if (!hasSpecificEntity) return 'broad_niche'
  }

  return 'specific_topic'
}

function inferNicheCategory(niche: string): NicheCategory {
  const n = normalize(niche)
  if (/auto|car|jarm/.test(n)) return 'tech_ai'
  if (/sport|foci|futball|football/.test(n)) return 'entertainment'
  if (/gaming|jatek|game/.test(n)) return 'entertainment'
  if (/film|movie|sorozat|series|horror|krimi/.test(n)) return 'entertainment'
  if (/penz|finance|crypto|kripto|befektet|invest/.test(n)) return 'finance_crypto'
  if (/tech|it|ai|program/.test(n)) return 'tech_ai'
  if (/tudomany|science|kutatas/.test(n)) return 'science_medical'
  if (/tortenel|history|haboru|war|military/.test(n)) return 'history_strange'
  if (/egeszseg|health|fitness|edzes/.test(n)) return 'health_wellness'
  if (/pszich|mental|psychology|motivac/.test(n)) return 'psychology'
  if (/ur|space|bolygok|nasa/.test(n)) return 'space_discovery'
  if (/zene|music/.test(n)) return 'entertainment'
  if (/hir|news|politika|politic/.test(n)) return 'news_current'
  if (/foz|cook|recept|food|konyha/.test(n)) return 'health_wellness'
  if (/utaz|travel/.test(n)) return 'default'
  if (/allat|animal|termeszet|nature/.test(n)) return 'default'
  return 'default'
}

function inferFreshnessWindow(niche: string): number {
  const n = normalize(niche)
  if (/hir|news|politika|politic|crypto|kripto|toz/.test(n)) return 14
  if (/tech|ai|it|program|gaming|game/.test(n)) return 60
  if (/sport|foci|futball|football/.test(n)) return 30
  if (/film|movie|sorozat|series/.test(n)) return 90
  if (/auto|car/.test(n)) return 90
  if (/tudomany|science|kutatas|egeszseg|health/.test(n)) return 120
  if (/tortenel|history|horror|krimi|rejtely/.test(n)) return 365
  return 120
}

export function buildDrilldownSeedsForDirection(direction: string): {
  seeds: string[]
  freshnessWindowDays: number
  category: NicheCategory
} {
  const category = inferNicheCategory(direction)
  const freshnessWindowDays = Math.max(120, inferFreshnessWindow(direction))
  const base = normalize(direction)
    .replace(/\b(explained|new research|breakthrough|study|why|how|facts|trending|viral)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || direction

  const seeds = [
    direction,
    `${base} explained`,
    `${base} new research`,
    `${base} breakthrough`,
    `why ${base} matters`,
    `${base} surprising facts`,
    `${base} case study`,
    `${base} documentary`,
  ]

  return {
    seeds: [...new Set(seeds.map(seed => seed.trim()).filter(Boolean))].slice(0, 6),
    freshnessWindowDays,
    category,
  }
}

// Barmilyen niche-re (tag "fact/erdekesseg" mintazatura is) dinamikusan
// generalt, tematikusan csoportositott seed-csomagok — a korabbi, ~13
// hardcode-olt topickulcsos subtopicMap es a kulon hardcode-olt
// "fact discovery" 10 csomagja helyett EGYETLEN, mindig a Niche Expansion
// Engine-t (lib/niche-expansion.ts) hasznalo, hardcode-mentes ut.
export async function buildBroadNicheDiscoveryPacks(niche: string, region: 'HU' | 'US'): Promise<BroadDiscoveryPack[]> {
  const searchRegion: 'HU' | 'US' = region === 'HU' ? 'US' : region
  const category = inferNicheCategory(niche)
  const freshnessWindowDays = Math.max(inferFreshnessWindow(niche), 180)

  // searchRegion mindig 'US' (a tag discovery szandekosan globalis/angol
  // forrasokat keres, fuggetlenul az eredeti regiotol — ld. fenti sor).
  const expansion = await buildNicheExpansion({ niche, region: searchRegion, language: 'en' })

  const packs: BroadDiscoveryPack[] = expansion.packs.map(pack => ({
    label: pack.label,
    category: (expansion.category as NicheCategory) || category,
    freshnessWindowDays: Math.max(freshnessWindowDays, expansion.freshness_window_days),
    searchRegion,
    seeds: pack.seeds.slice(0, 5),
  }))

  if (packs.length > 0) return packs.slice(0, 5)

  // Ha az AI nem adott vissza csoportositott packet (pl. fallback-agon fut),
  // essunk vissza a nyers validation_seedekre, egyetlen packkent.
  return expansion.validation_seeds.length > 0
    ? [{ label: niche, category: (expansion.category as NicheCategory) || category, freshnessWindowDays, searchRegion, seeds: expansion.validation_seeds.slice(0, 5) }]
    : []
}
