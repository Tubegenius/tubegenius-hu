// lib/niche-fit.ts
// WillViral — Niche Semantic Fit rendszer
// Bármilyen vesszős niche-et szétbont és semantic matching-gel értékeli a videó illeszkedést
//
// FONTOS, user által élőben talált hiba (2026-07-13): a NICHE_SEMANTIC_MAP csak
// 17 kategóriát ismer fel szinonima-listával — minden MÁS niche (pl. "futónövények
// gondozása", "kutyanevelés lakásban") a findMatchingCategories() fallback ágára esik,
// ami KIZÁRÓLAG a niche saját szavainak SZÓ SZERINTI előfordulását keresi a jelölt
// cím/leírás szövegében. Egy valóban releváns jelölt (pl. "Borostyán szobanövény
// betegségei" a "futónövények gondozása" niche-hez) szinte sosem tartalmazza szó
// szerint a niche szavait, ezért score=0 lett — ez pedig blokkolta a "Gyártható most"
// döntést (decide.ts nicheFit>=60 küszöb), a usernek több körben, kredit árán kellett
// újrapróbálkoznia. Ez a modul EZUTÁN SEM query-generálásra való (ld. lenti megjegyzés) —
// csak a findMatchingCategories() fallback lett puhábbá (tokenizált/prefix-alapú
// egyezés, lib/niche-relevance.ts újrahasznosításával) és a "relevance contradiction
// guard" működik matchedCategories nélkül is, ha a felsőbb szintű (topic-specifikus,
// FÜGGETLENÜL számolt) relevance_average már önmagában erős jelet ad.
//
// query_source: mindig 'dynamic_expansion' (lib/niche-expansion.ts) — ez a fájl
// SOHA nem használható keresési seed/query előállítására, kizárólag már megtalált
// jelöltek relevancia-pontozására (scoring_source: 'niche_fit').

import { tokenize, sharedPrefixLength } from './niche-relevance'

export const NICHE_SEMANTIC_MAP: Record<string, string[]> = {
  tudomany: ['science', 'scientific', 'research', 'study', 'experiment', 'discovery', 'breakthrough', 'physics', 'biology', 'chemistry', 'astronomy', 'space', 'archaeology', 'quantum', 'nasa', 'kutatas', 'felfedezes', 'kiserlet'],
  egeszseg: ['health', 'medical', 'medicine', 'doctor', 'clinical', 'disease', 'virus', 'brain', 'body', 'nutrition', 'mental health', 'sleep', 'diet', 'fitness', 'wellness', 'orvos', 'betegseg', 'egeszseg', 'alvas', 'taplalkozas'],
  erdekesseg: ['interesting', 'strange', 'weird', 'mystery', 'facts', 'explained', 'why', 'unknown', 'surprising', 'bizarre', 'curious', 'amazing', 'incredible', 'erdekes', 'furcsa', 'rejtely', 'meglepo'],
  hir: ['news', 'latest', 'breaking', 'update', 'current', '2025', '2026', 'today', 'report', 'aktualis', 'friss', 'ujdonsag'],
  tech: ['technology', 'tech', 'ai', 'artificial intelligence', 'software', 'startup', 'gadget', 'future', 'robot', 'app', 'digital', 'innovation', 'technologia', 'mesterseges intelligencia'],
  uzlet: ['business', 'money', 'startup', 'company', 'market', 'sales', 'entrepreneur', 'finance', 'investing', 'economy', 'penz', 'vallalkozas', 'befektetes'],
  sport: ['sport', 'football', 'soccer', 'world cup', 'transfer', 'training', 'match', 'team', 'athlete', 'championship', 'foci', 'bajnoksag', 'edzes', 'csapat'],
  tortenelem: ['history', 'ancient', 'archaeology', 'war', 'empire', 'civilization', 'historical', 'medieval', 'discovery', 'tortenelem', 'regeszet', 'haboru', 'okori'],
  pszichologia: ['psychology', 'mind', 'brain', 'behavior', 'cognitive', 'mental', 'experiment', 'emotion', 'memory', 'perception', 'pszichologia', 'agy', 'viselkedes', 'emlekezet'],
  motivacio: ['motivation', 'self improvement', 'mindset', 'success', 'habit', 'discipline', 'goals', 'productivity', 'motivacio', 'onismeret', 'siker', 'szokasok'],
  gasztro: ['cooking', 'recipe', 'food', 'restaurant', 'chef', 'kitchen', 'meal', 'cuisine', 'nutrition', 'fozas', 'recept', 'konyha', 'etel'],
  gaming: ['game', 'gaming', 'esports', 'playstation', 'xbox', 'nintendo', 'pc', 'stream', 'jatek'],
  film: ['movie', 'film', 'series', 'netflix', 'cinema', 'actor', 'director', 'review', 'mozi', 'sorozat'],
  zene: ['music', 'song', 'album', 'artist', 'concert', 'band', 'singer', 'zene', 'eloado', 'koncert'],
  utazas: ['travel', 'destination', 'tourism', 'trip', 'explore', 'country', 'city', 'utazas', 'latnivalo'],
  termeszet: ['nature', 'animal', 'wildlife', 'planet', 'environment', 'climate', 'ocean', 'termeszet', 'allat', 'kornyezet'],
  ur: ['space', 'nasa', 'james webb', 'planet', 'asteroid', 'galaxy', 'cosmos', 'universe', 'star', 'ur', 'urkutatas', 'bolygo'],
}

export function parseUserNiche(niche: string): string[] {
  return niche
    .split(/[,;\/]+/)
    .map(item => item.trim().toLowerCase())
    .filter(s => s.length > 1)
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

function findMatchingCategories(nicheCategories: string[]): Array<{ category: string; semanticTerms: string[]; isFallback: boolean }> {
  const results: Array<{ category: string; semanticTerms: string[]; isFallback: boolean }> = []

  for (const cat of nicheCategories) {
    const normalized = normalizeForMatch(cat)
    let matched = false

    for (const [key, terms] of Object.entries(NICHE_SEMANTIC_MAP)) {
      if (normalized.includes(key) || key.includes(normalized.slice(0, Math.min(normalized.length, 6)))) {
        results.push({ category: cat, semanticTerms: terms, isFallback: false })
        matched = true
        break
      }
    }

    if (!matched) {
      results.push({ category: cat, semanticTerms: [normalized, ...normalized.split(/\s+/)], isFallback: true })
    }
  }

  return results
}

// A NICHE_SEMANTIC_MAP-en KÍVÜLI (barmilyen, a 17 hardcode-olt kategorian tuli)
// niche-hez nincs szinonima-lista — a szo szerinti includes() szinte sosem talal
// (pl. "Borostyan szobanoveny betegsegei" cim nem tartalmazza szo szerint a
// "futonovenyek" szot). Puhabb, hardcode-mentes tartalek: token-szintu egyezes
// vagy legalabb 5 karakteres kozos prefix a niche es a jelolt szoveg tokenjei
// kozott — ugyanaz a mintazat, mint a lib/niche-relevance.ts prompt-injekcios
// kapujaban, csak itt pontozashoz hasznaljuk, nem query-generalashoz.
function fuzzyTokenMatch(nicheText: string, videoText: string): boolean {
  const nicheTokens = tokenize(nicheText)
  const videoTokens = tokenize(videoText)
  for (const n of nicheTokens) {
    if (n.length < 3) continue
    for (const v of videoTokens) {
      if (v.length < 3) continue
      if (n === v || sharedPrefixLength(n, v) >= 5) return true
    }
  }
  return false
}

export interface NicheFitResult {
  score: number
  matchedCategories: string[]
  matchedTerms: string[]
  label: string
  reason: string
}

export function calculateNicheFit(
  video: { title: string; description?: string; channelTitle?: string },
  niche: string,
  relevanceScore?: number,
): NicheFitResult {
  if (!niche || niche.length < 2) {
    return { score: 0, matchedCategories: [], matchedTerms: [], label: '', reason: '' }
  }

  const nicheCategories = parseUserNiche(niche)
  if (nicheCategories.length === 0) {
    return { score: 0, matchedCategories: [], matchedTerms: [], label: '', reason: '' }
  }

  const categoryProfiles = findMatchingCategories(nicheCategories)
  const videoText = normalizeForMatch(`${video.title} ${video.description || ''} ${video.channelTitle || ''}`)

  const matchedCategories: string[] = []
  const matchedTerms: string[] = []
  let totalMatches = 0
  let hasFallbackFuzzyMatch = false

  for (const profile of categoryProfiles) {
    let categoryMatched = false
    for (const term of profile.semanticTerms) {
      if (term.length >= 3 && videoText.includes(term)) {
        if (!categoryMatched) {
          matchedCategories.push(profile.category)
          categoryMatched = true
        }
        if (!matchedTerms.includes(term)) {
          matchedTerms.push(term)
        }
        totalMatches++
      }
    }
    // A hardcode-olt NICHE_SEMANTIC_MAP-en kivuli kategoriaknal (isFallback)
    // a szo szerinti egyezes szinte sosem talal — token-szintu/prefix-alapu
    // tartalek próba, hogy a "futónövények" niche a "Borostyán szobanövény
    // betegségei" cimhez is passzoljon (kozos "növény" gyok), ne csak a
    // szo szerinti egyezes.
    if (!categoryMatched && profile.isFallback && fuzzyTokenMatch(profile.category, videoText)) {
      matchedCategories.push(profile.category)
      hasFallbackFuzzyMatch = true
      totalMatches++
    }
  }

  // Score calculation
  const categoryRatio = nicheCategories.length > 0 ? matchedCategories.length / nicheCategories.length : 0
  const termScore = Math.min(100, totalMatches * 15)
  let score = Math.round(categoryRatio * 50 + Math.min(50, termScore))

  // Relevance contradiction guard — a relevanceScore FÜGGETLENÜL számolt
  // (lib/trend-radar.ts scoreVideoRelevanceForTopic, a konkrét TÉMÁHOZ, nem
  // a niche-hez viszonyítva), ezért önmagában is valid jelzés akkor is, ha a
  // hardcode-olt NICHE_SEMANTIC_MAP és a fuzzy tartalék egyike sem talált
  // semmit (pl. teljesen új, korábban nem látott niche). Korábban ez a
  // védőháló KIZÁRÓLAG matchedCategories.length>0 esetén működött, ami pont
  // azoknál a niche-eknél hagyta 0-n a score-t, amikre a legjobban kellett
  // volna — élő hiba, a user találta: minden a 17 hardcode-olt kategórián
  // kívüli niche (pl. "futónövények gondozása") minden jelöltje "Kutatandó
  // irány"-nál ragadt, sose "Gyártható most", mert a nicheFit>=60 küszöböt
  // 0 pontszámmal sosem lehetett elérni (decide.ts).
  if (relevanceScore !== undefined && relevanceScore >= 85 && score < 60) {
    score = Math.max(score, matchedCategories.length > 0 ? 65 : 60)
  } else if (relevanceScore !== undefined && relevanceScore >= 75 && score < 55) {
    score = Math.max(score, matchedCategories.length > 0 ? 55 : 55)
  } else if (relevanceScore !== undefined && relevanceScore >= 60 && score < 50) {
    score = Math.max(score, matchedCategories.length > 0 ? 50 : 45)
  } else if (relevanceScore !== undefined && relevanceScore >= 45 && score === 0) {
    // Meg akkor is adjunk nem nulla alapot, ha sem a térkép, sem a fuzzy
    // tartalék nem talált semmit, de a topic-specifikus relevancia már
    // közepes — így legalább a "research_required" küszöböt átlépheti,
    // nem ragad automatikusan elutasításnál.
    score = 25
  }
  if (hasFallbackFuzzyMatch && score < 45) {
    score = Math.max(score, 45)
  }

  // Label
  let label: string
  let reason: string

  if (score >= 80) {
    label = 'Erősen niche-releváns'
    reason = `Kapcsolódik a profilodhoz: ${matchedCategories.join(', ')}.`
  } else if (score >= 60) {
    label = 'Niche-releváns'
    reason = `Kapcsolódik: ${matchedCategories.join(', ')}.`
  } else if (score >= 40) {
    label = 'Adaptálható inspiráció'
    reason = matchedCategories.length > 0
      ? `Részben illeszkedik: ${matchedCategories.join(', ')}. A formátum adaptálható.`
      : 'Nem közvetlen niche-találat, de a formátum adaptálható.'
  } else {
    label = 'Nem niche-specifikus'
    reason = 'Globálisan érdekes, de nem kapcsolódik közvetlenül a niche-edhez.'
  }

  return { score, matchedCategories, matchedTerms, label, reason }
}
