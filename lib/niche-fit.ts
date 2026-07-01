// lib/niche-fit.ts
// WillViral — Niche Semantic Fit rendszer
// Bármilyen vesszős niche-et szétbont és semantic matching-gel értékeli a videó illeszkedést

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

function findMatchingCategories(nicheCategories: string[]): Array<{ category: string; semanticTerms: string[] }> {
  const results: Array<{ category: string; semanticTerms: string[] }> = []

  for (const cat of nicheCategories) {
    const normalized = normalizeForMatch(cat)
    let matched = false

    for (const [key, terms] of Object.entries(NICHE_SEMANTIC_MAP)) {
      if (normalized.includes(key) || key.includes(normalized.slice(0, Math.min(normalized.length, 6)))) {
        results.push({ category: cat, semanticTerms: terms })
        matched = true
        break
      }
    }

    if (!matched) {
      results.push({ category: cat, semanticTerms: [normalized, ...normalized.split(/\s+/)] })
    }
  }

  return results
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
  }

  // Score calculation
  const categoryRatio = nicheCategories.length > 0 ? matchedCategories.length / nicheCategories.length : 0
  const termScore = Math.min(100, totalMatches * 15)
  let score = Math.round(categoryRatio * 50 + Math.min(50, termScore))

  // Relevance contradiction guard
  if (relevanceScore !== undefined && relevanceScore >= 80 && score < 40 && matchedCategories.length > 0) {
    score = Math.max(score, 50)
  }
  if (relevanceScore !== undefined && relevanceScore >= 70 && matchedCategories.length > 0 && score < 60) {
    score = Math.max(score, 45)
  }

  // Label
  let label: string
  let reason: string

  if (score >= 80) {
    label = 'Erosen niche-relevans'
    reason = `Kapcsolodik a profilodhoz: ${matchedCategories.join(', ')}.`
  } else if (score >= 60) {
    label = 'Niche-relevans'
    reason = `Kapcsolodik: ${matchedCategories.join(', ')}.`
  } else if (score >= 40) {
    label = 'Adaptalhato inspiracio'
    reason = matchedCategories.length > 0
      ? `Reszben illeszkedik: ${matchedCategories.join(', ')}. A formatum adaptalhato.`
      : 'Nem kozvetlen niche-talalat, de a formatum adaptalhato.'
  } else {
    label = 'Nem niche-specifikus'
    reason = 'Globalisan erdekes, de nem kapcsolodik kozvetlenul a niche-edhez.'
  }

  return { score, matchedCategories, matchedTerms, label, reason }
}
