import { MODELS } from './models'

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!

export interface SimilarQueryExpansion {
  interpreted_topic: string
  hu_queries: string[]
  en_queries: string[]
  global_adaptable: boolean
  reason: string
}

// ── Cache ────────────────────────────────────────────────────

interface CachedExpansion {
  result: SimilarQueryExpansion
  timestamp: number
  ttlMs: number
}

const expansionCache = new Map<string, CachedExpansion>()
const MAX_CACHE_SIZE = 100

function getCacheTtl(category?: string): number {
  if (category === 'news_current') return 6 * 60 * 60 * 1000
  if (category === 'tech_ai' || category === 'finance_crypto') return 12 * 60 * 60 * 1000
  if (category === 'history_strange' || category === 'default') return 3 * 24 * 60 * 60 * 1000
  return 24 * 60 * 60 * 1000
}

function buildCacheKey(input: string, region: string, language: string): string {
  return `sqe:${input.toLowerCase().trim()}:${region}:${language}`
}

// ── Fallback ─────────────────────────────────────────────────

function fallbackExpansion(input: string): SimilarQueryExpansion {
  const stripped = input.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
  return {
    interpreted_topic: input,
    hu_queries: [input],
    en_queries: [stripped, `${stripped} explained`],
    global_adaptable: true,
    reason: 'Fallback — Claude nem volt elerheto.',
  }
}

// ── Haiku hívás ──────────────────────────────────────────────

export async function generateSimilarVideoQueries(
  input: string,
  region: 'HU' | 'US',
  language: string,
  topicCategory?: string,
): Promise<SimilarQueryExpansion> {
  const cacheKey = buildCacheKey(input, region, language)
  const cached = expansionCache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < cached.ttlMs) {
    return cached.result
  }

  if (!ANTHROPIC_API_KEY) return fallbackExpansion(input)

  const prompt = `Te egy YouTube keresesi query generator vagy.

A user beirt egy temat: "${input}"
Regio: ${region}
Nyelv: ${language}

FELADAT: Generalj celzott YouTube keresesi query-ket ehhez a temahoz.

SZABALYOK:
- Maximum 2 magyar (hu) es 3 angol (en) query
- Rovid, 2-5 szavas YouTube keresesi kifejezesek
- NE hasznalj generic szavakat onmagukban: news, viral, trending, science, technology, interesting, facts
- YouTube keresesre optimalizalt legyen (ahogy egy ember keresne)
- Az angol query-k globalisan is mukodjenek
- Ertelmezd a temat: ne szo szerint forditsd, hanem ertsd meg MIRE kereses a user

KRITIKUS JSON SZABALYOK:
- SOHA ne hasznalj idezojelet a JSON string ertekek BELSEJEBEN
- Minden string ertek egy soros legyen
- Csak pure JSON-t adj vissza, semmi mast

{
  "interpreted_topic": "a tema ertelmezese roviden",
  "hu_queries": ["magyar query 1", "magyar query 2"],
  "en_queries": ["english query 1", "english query 2", "english query 3"],
  "global_adaptable": true,
  "reason": "rovid indoklas miert ezek a query-k"
}`

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODELS.fast,
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    const data = await res.json()
    const text = data.content?.[0]?.text || ''

    let cleaned = text.replace(/```json|```/g, '').trim()
    const firstBrace = cleaned.indexOf('{')
    const lastBrace = cleaned.lastIndexOf('}')
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1)
    }

    const parsed = JSON.parse(cleaned) as SimilarQueryExpansion

    if (!parsed.hu_queries || !parsed.en_queries) {
      return fallbackExpansion(input)
    }

    parsed.hu_queries = parsed.hu_queries.slice(0, 2)
    parsed.en_queries = parsed.en_queries.slice(0, 3)

    const result = parsed

    if (expansionCache.size >= MAX_CACHE_SIZE) {
      const oldestKey = expansionCache.keys().next().value
      if (oldestKey) expansionCache.delete(oldestKey)
    }
    expansionCache.set(cacheKey, {
      result,
      timestamp: Date.now(),
      ttlMs: getCacheTtl(topicCategory),
    })

    console.log(`[QueryExpansion] "${input}" → hu:[${result.hu_queries.join(', ')}] en:[${result.en_queries.join(', ')}]`)
    return result
  } catch (e) {
    console.error('[QueryExpansion] Haiku error:', e)
    return fallbackExpansion(input)
  }
}
