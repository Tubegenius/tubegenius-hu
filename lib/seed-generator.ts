// lib/seed-generator.ts
// WillViral — Dinamikus seed generálás Claude alapján v2
// HU régióban MINDIG magyar seedek
// US régióban MINDIG angol seedek

import type { NicheCategory } from './niche-seeds'
import { callAIProvider, extractJson } from './services/ai-provider-service'

export interface GeneratedSeedPack {
  label: string
  seed_indexes: number[]
}

export interface GeneratedSeeds {
  seeds: string[]
  freshness_window_days: number
  category: NicheCategory
  is_time_sensitive: boolean
  language_note: string
  packs: GeneratedSeedPack[]
}

export async function generateSeedsForNiche(
  nicheText: string,
  region: 'HU' | 'US',
  maxSeeds = 18,
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
5. Fedjenek le KÜLÖNBÖZŐ altémákat a niche-en belül — generálj ${maxSeeds} DIVERZ seedet, ne ismételd ugyanazt a gondolatot más szavakkal
6. Kerüld az általános szavakat önmagukban: "news", "facts", "interesting", "viral", "trending"
7. Ha a niche időérzékeny (hírek, crypto, politika) → rövidebb freshness window
8. Ha evergreen (történelem, pszichológia, életmód) → hosszabb freshness window
9. Ez a mechanizmus BÁRMILYEN niche-re működnie kell (tech, egészség, sport, gaming, szépség, pénzügy, edukáció, pszichológia, gasztro, utazás, autó, ingatlan, kertészkedés, állattartás, történelem, üzlet, lifestyle stb.) — sose hivatkozz egy fix, előre megírt témalistára, mindig a MEGADOTT niche-ből indulj ki

CSOPORTOSÍTÁS (packs):
Csoportosítsd a generált seedeket 3-5 rövid, ember-olvasható tematikus irányba (pl. "Friss fejlemények", "Tudományos háttér", "Történet/rejtély szög", "Gyakorlati tippek" — de ezek a labelek is a KONKRÉT niche-hez igazodjanak, ne generikus placeholder szövegek legyenek). Minden pack a hozzá tartozó seedek 0-alapú indexét sorolja fel a "seeds" tömbből.

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
  "seeds": ["seed1", "seed2", "seed3", "..."],
  "packs": [{"label": "...", "seed_indexes": [0, 1, 2]}, {"label": "...", "seed_indexes": [3, 4]}],
  "freshness_window_days": 60,
  "category": "news_current",
  "is_time_sensitive": false,
  "language_note": "magyar seedek HU régióhoz"
}

Lehetséges category értékek: news_current, tech_ai, science_medical, space_discovery, psychology, health_wellness, finance_crypto, history_strange, gaming, entertainment, default`

  try {
    const aiCall = await callAIProvider({
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 1500,
      messages: [{ role: 'user', content: prompt }],
      promptTemplateId: 'seed_generator',
      promptVersion: 'v2',
    })
    const parsed = extractJson<GeneratedSeeds>(aiCall.text)

    if (parsed && parsed.seeds && parsed.seeds.length > 0) {
      // Validálás: HU régióban ne legyenek angol seedek
      let seeds = parsed.seeds.slice(0, maxSeeds)
      if (region === 'HU') {
        seeds = validateHungarianSeeds(seeds, nicheText)
      }
      const packs = Array.isArray(parsed.packs)
        ? parsed.packs
            .filter(p => p && typeof p.label === 'string' && Array.isArray(p.seed_indexes))
            .map(p => ({ label: p.label, seed_indexes: p.seed_indexes.filter(i => i >= 0 && i < seeds.length) }))
            .filter(p => p.seed_indexes.length > 0)
        : []
      return {
        seeds,
        freshness_window_days: parsed.freshness_window_days || 60,
        category: (parsed.category as NicheCategory) || 'default',
        is_time_sensitive: parsed.is_time_sensitive || false,
        language_note: parsed.language_note || '',
        packs,
      }
    }
  } catch (e) {
    console.error('Seed generator error:', e)
  }

  return fallbackSeedGeneration(nicheText, region)
}

// HU régióban ellenőrzés: ha angol seed csúszik be, cseréljük magyarra
export function validateHungarianSeeds(seeds: string[], nicheText: string): string[] {
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
  if (lower.split(/\s+/).length <= 1 && lower.length < 6) return true
  return false
}

const englishPatterns = /\b(news|latest|breaking|current|today|explained|update|review|guide|how to|what is|why|best)\b/i
  const year = new Date().getFullYear()
  const nicheWords = nicheText.split(/\s+/).slice(0, 2).join(' ')

  return seeds.map(seed => {
    if (isBannedSeed(seed) || englishPatterns.test(seed)) {
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

  const finalSeeds = seeds.slice(0, 5)
  return {
    seeds: finalSeeds,
    freshness_window_days: 60,
    category: 'default',
    is_time_sensitive: false,
    language_note: `fallback generálás - ${region} régió`,
    packs: [{ label: nicheText, seed_indexes: finalSeeds.map((_, i) => i) }],
  }
}
