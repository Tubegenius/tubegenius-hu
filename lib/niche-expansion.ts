// ============================================================
// WILLVIRAL — Niche Expansion Engine
// ============================================================
// Kozponti, GLOBALISAN barmilyen niche-re mukodo seed-generalasi reteg.
// A niche STRATEGIAI TARTALOMIRANY, nem direkt keresesi kifejezes — ez a
// modul bontja fel dinamikus, kereshetohipotezisekre (seedekre), amiket
// csak validacio utan (YouTube/Serper bizonyitek) lathat a user.
//
// FONTOS: ez a modul SOSE tartalmazhat topic-specifikus hardcode-olt
// query-t vagy peldat (pl. "Great Pyramid vibration" tipusu fix stringet).
// Az AI-alapu generalas (lib/seed-generator.ts generateSeedsForNiche())
// es a szabaly-alapu, a user SAJAT szoveget sablonozo generikus expanzio
// (lib/topic-expansion.ts expandTopicQueries()) egyutt adja a "szabaly +
// AI hibrid" seed generaciot, ahogy a termek-specifikacio kifejezetten
// keri.

import { generateSeedsForNiche, type GeneratedSeeds } from './seed-generator'
import { expandTopicQueries } from './topic-expansion'
import type { NicheCategory } from './niche-seeds'

export interface NicheExpansionPack {
  label: string
  seeds: string[]
}

export interface NicheExpansionResult {
  original_niche: string
  seeds: string[]
  validation_seeds: string[]
  rejected_seed_topics: string[]
  packs: NicheExpansionPack[]
  category: NicheCategory
  freshness_window_days: number
  is_time_sensitive: boolean
  source: 'ai' | 'fallback'
}

function asciiFold(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Egy seed tul altalanos/gyenge ahhoz, hogy validaciora erdemes legyen
// elkuldeni — egyetlen rovid, generikus szo, vagy tul rovid a teljes string.
const GENERIC_STANDALONE_WORDS = new Set([
  'news', 'hirek', 'facts', 'tenyek', 'interesting', 'erdekes', 'viral', 'trending',
  'trend', 'video', 'videos', 'videok', 'content', 'tartalom', 'topic', 'tema',
])

function isWeakSeed(seed: string): boolean {
  const trimmed = seed.trim()
  if (trimmed.length < 4) return true
  const folded = asciiFold(trimmed)
  const words = folded.split(' ').filter(Boolean)
  if (words.length === 1 && GENERIC_STANDALONE_WORDS.has(words[0])) return true
  return false
}

function dedupeSeeds(seeds: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const seed of seeds) {
    const key = asciiFold(seed)
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(seed.trim())
  }
  return result
}

export interface NicheExpansionInput {
  niche: string
  main_category?: string | null
  specific_focus?: string | null
  platform?: string
  region: 'HU' | 'US'
  language: 'hu' | 'en'
  creator_profile?: { audience?: string | null; avoid_topics?: string | null } | null
  channel_usage_mode?: string | null
  maxSeeds?: number
  maxValidationSeeds?: number
}

// A niche ertelmezese -> dinamikus seed topic generalas -> gyenge
// jeloltek kiszurese -> (opcionalis) klaszterezheto csoportositas (packs).
// A tenyleges YouTube/Serper validacio (lib/trend-radar.ts buildTrendCandidates)
// es a bizonyitek-alapu pontozas (lib/core-trust-engine) EZUTAN, kulon
// lepesben tortenik — ez a modul csak a HIPOTEZIS-generalasert felel.
export async function buildNicheExpansion(input: NicheExpansionInput): Promise<NicheExpansionResult> {
  const niche = input.niche.trim()
  const maxSeeds = input.maxSeeds || 18
  const maxValidationSeeds = input.maxValidationSeeds || 12

  // generateSeedsForNiche() sose dob hibat — sikertelen AI-hivas eseten
  // sajat, hardcode-mentes fallbackSeedGeneration()-t ad vissza (jelezve
  // a language_note "fallback generalas" prefixevel), ezert itt nincs
  // kulon try/catch, csak a forras felismerese a mar visszakapott objektumbol.
  const generated: GeneratedSeeds = await generateSeedsForNiche(niche, input.region, maxSeeds)
  const source: 'ai' | 'fallback' = generated.language_note.startsWith('fallback') ? 'fallback' : 'ai'

  // Szabaly-alapu, hardcode-mentes kiegeszito reteg — a user sajat
  // szoveget sablonozza (nem topic-specifikus tartalom), ld. genericQueries().
  const ruleBasedQueries = expandTopicQueries(niche, input.region).queries.map(q => q.query)

  const allCandidates = dedupeSeeds([...generated.seeds, ...ruleBasedQueries])
  const rejected: string[] = []
  const acceptedSeeds: string[] = []
  for (const seed of allCandidates) {
    if (isWeakSeed(seed)) rejected.push(seed)
    else acceptedSeeds.push(seed)
  }

  const packs: NicheExpansionPack[] = (generated.packs || [])
    .map(p => ({ label: p.label, seeds: p.seed_indexes.map(i => generated.seeds[i]).filter(Boolean) }))
    .filter(p => p.seeds.length > 0)

  // A validacios halmaz: elobb a legjobb (AI-generalt) seedek, csak utana a
  // szabaly-alapuak — igy a draga YouTube/Serper hivasok a legerosebb
  // jeloltekre koncentralnak, korlatozott (koltseg-parit fenntarto) darabszamon.
  const prioritized = dedupeSeeds([...generated.seeds.filter(s => !isWeakSeed(s)), ...acceptedSeeds])
  const validationSeeds = prioritized.slice(0, maxValidationSeeds)

  return {
    original_niche: niche,
    seeds: acceptedSeeds,
    validation_seeds: validationSeeds.length > 0 ? validationSeeds : [niche],
    rejected_seed_topics: rejected,
    packs,
    category: generated.category,
    freshness_window_days: generated.freshness_window_days,
    is_time_sensitive: generated.is_time_sensitive,
    source,
  }
}
