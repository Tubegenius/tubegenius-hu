// ============================================================
// WILLVIRAL — Title Studio (Phase 2 #4)
// ============================================================
// A hossz/clickbait-jelek backend-szamoltak (objektiv, nem AI-becsult),
// a curiosity/clarity/clickability mineg AI-itelet, mert ezekhez nincs
// valos meresi adat (nem all rendelkezesre A/B teszt eredmeny) — ezt a UI
// egyertelmuen "AI-ertekeles"-kent jeloli, nem "meresen alapulo score"-kent.

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

export function buildTitleStudioPrompt(input: {
  topic: string
  niche: string
  platform: string
  existingTitle?: string
}): string {
  return `Egy magyar tartalomgyártónak cím-variációkat kell írnod ehhez a témához.

TÉMA: "${input.topic}"
${input.existingTitle ? `MEGLÉVŐ CÍM (ha van, ebből induljunk ki, de adj valódi alternatívákat): "${input.existingTitle}"` : ''}
NICHE: ${input.niche || 'általános'}
PLATFORM: ${input.platform}

FELADAT:
Írj 5 KÜLÖNBÖZŐ magyar címvariációt ugyanahhoz a témához, mindegyik más megközelítéssel (pl. kíváncsiság-vezérelt, konkrét szám/lista, kérdés, ellentmondás/meglepetés, egyszerű/direkt).

Minden címhez adj 0-100 közötti ÉRTÉKELÉST (a saját megítélésed alapján, NE állítsd hogy ez mért adat):
- curiosity_score: mennyire kelt kíváncsiságot
- clarity_score: mennyire világos, mit kap a néző
- clickability_score: mennyire valószínű, hogy rákattintanak
- risk_score: mennyire "clickbait-es"/túlígérő (magasabb = kockázatosabb, mert nem tartja be az ígéretét)

És egy rövid, 1 mondatos magyar indoklást (reasoning).

KRITIKUS SZABÁLYOK:
- NE használj túlzó, be nem tartható ígéreteket.
- A címek legyenek TÉNYLEGESEN különbözőek egymástól, ne csak szinonimák.
- SOHA ne használj idézőjelet a JSON string értékek BELSEJÉBEN.

Válaszolj KIZÁRÓLAG valid JSON tömbben:
[{"title": "...", "curiosity_score": 0, "clarity_score": 0, "clickability_score": 0, "risk_score": 0, "reasoning": "..."}]`
}
