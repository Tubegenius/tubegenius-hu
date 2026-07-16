// ============================================================
// WILLVIRAL — Title Studio (Phase 2 #4)
// ============================================================
// A hossz/clickbait-jelek backend-szamoltak (objektiv, nem AI-becsult),
// a curiosity/clarity/clickability mineg AI-itelet, mert ezekhez nincs
// valos meresi adat (nem all rendelkezesre A/B teszt eredmeny) — ezt a UI
// egyertelmuen "AI-ertekeles"-kent jeloli, nem "meresen alapulo score"-kent.

import { STAY_ON_TOPIC_RULE } from './niche-relevance'

export interface TitleHeuristics {
  length: number
  length_flag: 'ok' | 'too_long' | 'too_short'
  has_number: boolean
  has_question: boolean
  excessive_caps: boolean
  clickbait_symbol_overuse: boolean
}

const CLICKBAIT_SYMBOLS = /[!?]{2,}|[🔥💥😱⚠️]{2,}/

export function computeTitleHeuristics(title: string): TitleHeuristics {
  const length = title.length
  const capsRatio = title.replace(/[^A-Za-zÁÉÍÓÖŐÚÜŰáéíóöőúüű]/g, '').length > 0
    ? (title.match(/[A-ZÁÉÍÓÖŐÚÜŰ]/g) || []).length / title.replace(/[^A-Za-zÁÉÍÓÖŐÚÜŰáéíóöőúüű]/g, '').length
    : 0

  return {
    length,
    length_flag: length > 70 ? 'too_long' : length < 20 ? 'too_short' : 'ok',
    has_number: /\d/.test(title),
    has_question: title.includes('?'),
    excessive_caps: capsRatio > 0.5 && length > 10,
    clickbait_symbol_overuse: CLICKBAIT_SYMBOLS.test(title),
  }
}

export interface TitleVariation {
  title: string
  curiosity_score: number
  clarity_score: number
  clickability_score: number
  risk_score: number
  reasoning: string
}

export function isValidTitleVariation(value: unknown): value is TitleVariation {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  const score = (key: string) => typeof v[key] === 'number' && Number.isFinite(v[key]) && (v[key] as number) >= 0 && (v[key] as number) <= 100
  return typeof v.title === 'string' && v.title.trim().length > 0 && v.title.length <= 100
    && typeof v.reasoning === 'string' && v.reasoning.trim().length > 0 && v.reasoning.length <= 1000
    && score('curiosity_score') && score('clarity_score') && score('clickability_score') && score('risk_score')
}

export function validateDistinctTitleVariations(value: unknown): TitleVariation[] {
  if (!Array.isArray(value) || value.length !== 5 || !value.every(isValidTitleVariation)) throw new Error('Pontosan öt teljes címvariáció szükséges.')
  const seen = new Set<string>()
  return value.map(item => {
    const title = item.title.trim().replace(/\s+/g, ' ')
    const key = title.toLocaleLowerCase('hu-HU').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    if (seen.has(key)) throw new Error('A címvariációk nem lehetnek azonosak.')
    seen.add(key)
    return { ...item, title, reasoning: item.reasoning.trim() }
  })
}

// ── Magyar nyelvi guard ──────────────────────────────────────
// MVP: ismert idegen (angol/portugál/spanyol) szavak/kifejezések feketelistája,
// amik korábban megjelentek generált magyar címekben (pl. "amit az AI
// descobrált"). Nem teljes nyelvészeti ellenőrzés — csak egy olcsó, gyors
// biztonsági háló a leggyakoribb keveredésekre. AI-hívás nélkül, determinisztikusan
// cseréli magyar megfelelőre, hogy ne kelljen újra fizetős generálást indítani.
const FOREIGN_WORD_REPLACEMENTS: Record<string, string> = {
  'descobrál': 'felfedezett',
  'descobriu': 'felfedezte',
  'descubrió': 'felfedezte',
  'descubrir': 'felfedezni',
  'discovered': 'felfedezett',
  'revealed': 'felfedte',
  'unveiled': 'bemutatta',
  'reveals': 'felfedi',
  'shows that': 'megmutatja, hogy',
}

// Nem-latin irasrendszerek (cirill, kinai/japan/koreai, arab, thai, stb.) egy
// magyar cimben SOSEM helyesek — ezt egy blacklist sosem tudna teljesen
// lefedni (pl. "урожájig" — cirill betukkel kevert magyar szo egy generalt
// cimben), ezert kulon, unicode-tartomany alapu ellenorzest is hasznalunk.
const NON_LATIN_SCRIPT_RE = /[Ѐ-ӿͰ-Ͽ一-鿿぀-ヿ가-힯؀-ۿ֐-׿฀-๿]/

export function validateHungarianTitle(title: string): { ok: boolean; reason?: string } {
  const lower = title.toLowerCase()
  for (const word of Object.keys(FOREIGN_WORD_REPLACEMENTS)) {
    if (lower.includes(word)) {
      return { ok: false, reason: `Idegen szó/kifejezés a címben: "${word}"` }
    }
  }
  if (NON_LATIN_SCRIPT_RE.test(title)) {
    return { ok: false, reason: 'Nem latin írásrendszerű karakter a címben' }
  }
  return { ok: true }
}

export function sanitizeHungarianTitle(title: string): string {
  let result = title
  for (const [foreign, hungarian] of Object.entries(FOREIGN_WORD_REPLACEMENTS)) {
    const re = new RegExp(foreign.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    result = result.replace(re, hungarian)
  }
  // Nem-latin irasrendszerrel kevert szavak eltavolitasa (nincs biztonsagos
  // automatikus forditas AI-hivas nelkul, ezert inkabb kihagyjuk a szot,
  // mint hogy a felhasznalo egy torott, kevert-irasu cimet kapjon).
  if (NON_LATIN_SCRIPT_RE.test(result)) {
    result = result
      .split(/\s+/)
      .filter(word => !NON_LATIN_SCRIPT_RE.test(word))
      .join(' ')
      .replace(/\s+([.,!?:;])/g, '$1')
      .trim()
  }
  return result
}

export function buildTitleStudioPrompt(input: {
  topic: string
  niche: string
  useNiche: boolean
  platform: string
  existingTitle?: string
}): string {
  return `Egy magyar tartalomgyártónak cím-variációkat kell írnod ehhez a témához.

TÉMA: "${input.topic}"
${input.existingTitle ? `MEGLÉVŐ CÍM (ha van, ebből induljunk ki, de adj valódi alternatívákat): "${input.existingTitle}"` : ''}
${input.useNiche && input.niche ? `NICHE: ${input.niche}\n` : ''}PLATFORM: ${input.platform}

FELADAT:
Írj 5 KÜLÖNBÖZŐ magyar címvariációt ugyanahhoz a témához, mindegyik más megközelítéssel (pl. kíváncsiság-vezérelt, konkrét szám/lista, kérdés, ellentmondás/meglepetés, egyszerű/direkt).

Minden címhez adj 0-100 közötti ÉRTÉKELÉST (a saját megítélésed alapján, NE állítsd hogy ez mért adat):
- curiosity_score: mennyire kelt kíváncsiságot
- clarity_score: mennyire világos, mit kap a néző
- clickability_score: szubjektív AI-értékelés a cím csomagolási vonzerejéről; ez NEM CTR- vagy kattintás-előrejelzés
- risk_score: mennyire "clickbait-es"/túlígérő (magasabb = kockázatosabb, mert nem tartja be az ígéretét)

És egy rövid, 1 mondatos magyar indoklást (reasoning).

KRITIKUS SZABÁLYOK:
- NE használj túlzó, be nem tartható ígéreteket.
- Egyik cím se legyen 100 karakternél hosszabb.
- A címek legyenek TÉNYLEGESEN különbözőek egymástól, ne csak szinonimák.
- SOHA ne használj idézőjelet a JSON string értékek BELSEJÉBEN.
- ${STAY_ON_TOPIC_RULE}
- A címek teljesen magyar nyelvűek legyenek. Ne használj angol, spanyol, portugál vagy más idegen szót, kivéve közismert márkanevet vagy szakkifejezést.
- Egészségügyi, tudományos vagy más tényalapú, érzékeny témáknál (pl. oltás, gyógyszer, klímaváltozás) KERÜLD az összeesküvés-hangzású megfogalmazást ("amit eltitkolnak előled", "a tudósok nem mondják el", "ezt nem akarják, hogy tudd") — ezek alá is ássák a nézői bizalmat, és nem felelnek meg a WillViral bizonyíték-alapú irányvonalának. Ehelyett a kíváncsiságot tényalapú, konkrét kérdésfeltevéssel (pl. "Mit mutatnak a friss kutatások...") kelts fel, és az ilyen témák EGYETLEN változatát se pontozd 40 alatti risk_score-ra, ha bármilyen megalapozatlan-hangzású állítást tartalmaz.

Válaszolj KIZÁRÓLAG valid JSON tömbben:
[{"title": "...", "curiosity_score": 0, "clarity_score": 0, "clickability_score": 0, "risk_score": 0, "reasoning": "..."}]`
}
