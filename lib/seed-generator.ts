// lib/seed-generator.ts
// WillViral — Dinamikus seed generálás Claude alapján v2
// HU régióban MINDIG magyar seedek
// US régióban MINDIG angol seedek

import type { NicheCategory } from './niche-seeds'

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!

export interface GeneratedSeeds {
  seeds: string[]
  freshness_window_days: number
  category: NicheCategory
  is_time_sensitive: boolean
  language_note: string
}

function extractJson(text: string): unknown {
  let cleaned = text.replace(/```json|```/g, '').trim()
  const firstBrace = cleaned.indexOf('{')
  const lastBrace = cleaned.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1)
  }
  try { return JSON.parse(cleaned) }
  catch { return null }
}

export async function generateSeedsForNiche(
  nicheText: string,
  region: 'HU' | 'US',
  maxSeeds = 5,
): Promise<GeneratedSeeds> {

  const regionRules = region === 'HU'
    ? `RÉGIÓ: HU — Magyar piac
KRITIKUS SEED SZABÁLYOK HU RÉGIÓHOZ:
- A seed keywordök KÖTELEZŐEN magyar nyelvűek legyenek
- A seedek magyar piacra, magyar közönségre, magyar tartalomra irányuljanak
- NE generálj angol seed-et HU régióhoz
- Tilos ezek a globális/angol seedek: "latest news", "breaking news", "current events", "global politics", "trending now"
- Helyes HU seed példák: "magyar hírek ma", "aktuális magyar politika", "friss technológiai hírek", "magyar egészségügyi kutatás"
- A YouTube keresés regionCode=HU és relevanceLanguage=hu paraméterekkel fog futni`
    : `RÉGIÓ: US — Globális/angol piac
KRITIKUS SEED SZABÁLYOK US RÉGIÓHOZ:
- A seed keywordök KÖTELEZŐEN angol nyelvűek legyenek
- Globális, amerikai és angol nyelvű piacra irányuljanak
- Helyes US seed példák: "breaking news explained", "AI breakthrough 2026", "science discovery today"`

  const prompt = `Te egy YouTube creator intelligence rendszer seed generátora vagy.

FELADAT: A megadott creator NICHE alapján generálj konkrét keresési kifejezéseket, amelyekkel megtaláljuk a niche-en belüli AKTUÁLIS trendi témákat.

FONTOS: A niche NEM keresési kifejezés, hanem a creator tartalomkategóriája. Értsd meg, milyen típusú tartalmakat készít ez a creator, és generálj olyan keresőkifejezéseket, amelyek az ő niche-én belüli TRENDI, AKTUÁLIS témákat találják meg.

Példa: ha a niche "autók", NE "autók" legyen a seed, hanem pl. "új villanyautó teszt 2026", "autóipar hír", "legjobb SUV összehasonlítás".

NICHE: "${nicheText}"
${regionRules}

SEED GENERÁLÁSI SZABÁLYOK:
1. Értsd meg a niche-t: milyen ALTÉMÁK trendiek most ezen a területen?
2. Minden seed legyen KONKRÉT altéma vagy trend — ne az eredeti niche szó ismétlése
3. A seedek 2-5 szó hosszúak legyenek
4. Keresőoptimalizált kifejezések legyenek (ahogy valaki YouTube-on keresne)
5. Fedjenek le KÜLÖNBÖZŐ altémákat a niche-en belül
6. Kerüld az általános szavakat önmagukban: "news", "facts", "interesting", "viral", "trending"
7. Ha a niche időérzékeny (hírek, crypto, politika) → rövidebb freshness window
8. Ha evergreen (történelem, pszichológia, életmód) → hosszabb freshness window

FRESHNESS WINDOW:
- Napi hírek, crypto, tőzsde: 7-14 nap
- Tech, AI, tudomány: 30-60 nap
- Egészség, pszichológia, sport: 60-120 nap
- Történelem, életmód, evergreen: 180-365 nap

KRITIKUS JSON SZABÁLYOK:
- SOHA ne használj idézőjelet a JSON string értékek BELSEJÉBEN
- Minden string érték egy soros legyen
- Csak pure JSON-t adj vissza

Válaszolj KIZÁRÓLAG valid JSON-ban:
{
  "seeds": ["seed1", "seed2", "seed3", "seed4", "seed5"],
  "freshness_window_days": 60,
  "category": "news_current",
  "is_time_sensitive": false,
  "language_note": "magyar seedek HU régióhoz"
}

Lehetséges category értékek: news_current, tech_ai, science_medical, space_discovery, psychology, health_wellness, finance_crypto, history_strange, gaming, entertainment, default`

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    const data = await res.json()
    const text = data.content?.[0]?.text || ''
    const parsed = extractJson(text) as GeneratedSeeds | null

    if (parsed && parsed.seeds && parsed.seeds.length > 0) {
      // Validálás: HU régióban ne legyenek angol seedek
      let seeds = parsed.seeds.slice(0, maxSeeds)
      if (region === 'HU') {
        seeds = validateHungarianSeeds(seeds, nicheText)
      }
      return {
        seeds,
        freshness_window_days: parsed.freshness_window_days || 60,
        category: (parsed.category as NicheCategory) || 'default',
        is_time_sensitive: parsed.is_time_sensitive || false,
        language_note: parsed.language_note || '',
      }
    }
  } catch (e) {
    console.error('Seed generator error:', e)
  }

  return fallbackSeedGeneration(nicheText, region)
}

// HU régióban ellenőrzés: ha angol seed csúszik be, cseréljük magyarra
function validateHungarianSeeds(seeds: string[], nicheText: string): string[] {
  // Tiltott generic seedek — HU régióban ezek irreleváns globális zajt hoznak
const BANNED_HU_SEEDS = [
  'latest political developments', 'breaking news', 'current events',
  'global politics', 'latest news today', 'trending now', 'viral content',
  'news today', 'top news', 'world news',
]

const BANNED_GENERIC_PATTERNS = /^(news|science|technology|facts|interesting|viral|trending|latest|current|breaking|top|world|global)$/i

function isBannedSeed(seed: string): boolean {
  const lower = seed.toLowerCase().trim()
  if (BANNED_GENERIC_PATTERNS.test(lower)) return true
  if (BANNED_HU_SEEDS.some(b => lower.includes(b.toLowerCase()))) return true
  // Túl rövid seed (1-2 szó generic) is tiltott
  if (lower.split(/s+/).length <= 1 && lower.length < 6) return true
  return false
}

const englishPatterns = /(news|latest|breaking|current|today|explained|update|review|guide|how to|what is|why|best)/i
  const year = new Date().getFullYear()
  const nicheWords = nicheText.split(/\s+/).slice(0, 2).join(' ')

  return seeds.map(seed => {
    if (englishPatterns.test(seed)) {
      // Angol seed → magyar fallback
      return `${nicheWords} ${year}`
    }
    return seed
  })
}

function fallbackSeedGeneration(nicheText: string, region: 'HU' | 'US'): GeneratedSeeds {
  const words = nicheText.trim().split(/\s+/).slice(0, 3).join(' ')
  const year = new Date().getFullYear()

  const seeds = region === 'HU'
    ? [
        `magyar ${words} ${year}`,
        `${words} hírek`,
        `aktuális ${words}`,
        `${words} kutatás`,
        `friss ${words} témák`,
      ]
    : [
        `${words} ${year}`,
        `${words} news`,
        `${words} explained`,
        `${words} research`,
        `${words} update`,
      ]

  return {
    seeds: seeds.slice(0, 5),
    freshness_window_days: 60,
    category: 'default',
    is_time_sensitive: false,
    language_note: `fallback generálás - ${region} régió`,
  }
}
