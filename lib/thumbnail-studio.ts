// ============================================================
// WILLVIRAL — Thumbnail Studio (Phase 2 #5)
// ============================================================
// Elso korben nincs kepgeneralas — thumbnail INTELLIGENCE: koncepcio,
// szoveg-javaslat, kompozicio, es objektiv szoveg-hosszossag-ellenorzes
// (a kis thumbnail meret miatt a rovid szoveg kritikus, ez mérheto, nem AI-becsles).

import { STAY_ON_TOPIC_RULE } from './niche-relevance'

export interface ThumbnailTextCheck {
  length: number
  word_count: number
  readable_at_small_size: boolean
}

export function checkThumbnailText(text: string): ThumbnailTextCheck {
  const trimmed = text.trim()
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length
  return {
    length: trimmed.length,
    word_count: wordCount,
    readable_at_small_size: trimmed.length <= 24 && wordCount <= 4,
  }
}

export interface ThumbnailConcept {
  concept_label: string
  visual_description: string
  thumbnail_text: string
  composition_note: string
  emotion_or_conflict: string
  contrast_attention_score: number
  clutter_risk: 'low' | 'medium' | 'high'
}

export function buildThumbnailStudioPrompt(input: { topic: string; niche: string; useNiche: boolean; platform: string }): string {
  return `Egy magyar tartalomgyártónak thumbnail (borítókép) koncepciókat kell javasolnod ehhez a témához — MAGÁT A KÉPET nem generáljuk, csak a koncepciót írjuk le.

TÉMA: "${input.topic}"
${input.useNiche && input.niche ? `NICHE: ${input.niche}\n` : ''}PLATFORM: ${input.platform}

FELADAT:
Javasolj 3 KÜLÖNBÖZŐ thumbnail-koncepciót (A/B/C teszthez), mindegyik más vizuális megközelítéssel.

Minden koncepcióhoz add meg:
- concept_label: rövid név (pl. "Arc + meglepetés", "Előtte-utána", "Nagy szám kiemelve")
- visual_description: 1-2 mondatos magyar leírás, mit kellene látni a képen (arc, tárgy, szimbólum, akció)
- thumbnail_text: a képre kerülő szöveg — MAX 3-4 SZÓ, olvashatónak kell lennie kis méretben is
- composition_note: kompozíciós javaslat (pl. "arc jobb oldalon, szöveg bal felül, erős kontraszt háttér")
- emotion_or_conflict: milyen érzelmet/konfliktust/kíváncsiságot kelt a kép
- contrast_attention_score: 0-100, mennyire üt át egy feedben (a saját megítélésed, NE állítsd hogy mért adat)
- clutter_risk: "low"/"medium"/"high" — mennyire zsúfolt a koncepció

KRITIKUS SZABÁLYOK:
- A thumbnail_text legyen VALÓBAN rövid (max 3-4 szó), ne mondat.
- A 3 koncepció legyen TÉNYLEGESEN különböző vizuálisan, ne csak szöveg-variáns.
- SOHA ne használj idézőjelet a JSON string értékek BELSEJÉBEN.
- ${STAY_ON_TOPIC_RULE}
- A szövegek teljesen magyar nyelvűek legyenek, idegen szavak nélkül (kivéve közismert márkanév vagy szakkifejezés).

Válaszolj KIZÁRÓLAG valid JSON tömbben:
[{"concept_label": "...", "visual_description": "...", "thumbnail_text": "...", "composition_note": "...", "emotion_or_conflict": "...", "contrast_attention_score": 0, "clutter_risk": "low"}]`
}
