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

export function isValidThumbnailConcept(value: unknown): value is ThumbnailConcept {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  const text = (key: string, max: number) => typeof v[key] === 'string' && (v[key] as string).trim().length > 0 && (v[key] as string).length <= max
  return text('concept_label', 120) && text('visual_description', 1500) && text('thumbnail_text', 24) && text('composition_note', 800) && text('emotion_or_conflict', 800)
    && checkThumbnailText(String(v.thumbnail_text)).readable_at_small_size
    && typeof v.contrast_attention_score === 'number' && Number.isFinite(v.contrast_attention_score) && v.contrast_attention_score >= 0 && v.contrast_attention_score <= 100
    && ['low', 'medium', 'high'].includes(String(v.clutter_risk))
}

export function sanitizeThumbnailConcept(value: ThumbnailConcept): ThumbnailConcept {
  return {
    concept_label: value.concept_label.trim().replace(/\s+/g, ' '),
    visual_description: value.visual_description.trim().replace(/\s+/g, ' '),
    thumbnail_text: value.thumbnail_text.trim().replace(/\s+/g, ' '),
    composition_note: value.composition_note.trim().replace(/\s+/g, ' '),
    emotion_or_conflict: value.emotion_or_conflict.trim().replace(/\s+/g, ' '),
    contrast_attention_score: value.contrast_attention_score,
    clutter_risk: value.clutter_risk,
  }
}

function identityText(value: string) {
  return value.toLocaleLowerCase('hu-HU').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim()
}

export function thumbnailConceptIdentity(value: ThumbnailConcept) {
  const concept = sanitizeThumbnailConcept(value)
  return JSON.stringify({
    concept_label: identityText(concept.concept_label),
    visual_description: identityText(concept.visual_description),
    thumbnail_text: identityText(concept.thumbnail_text),
    composition_note: identityText(concept.composition_note),
    emotion_or_conflict: identityText(concept.emotion_or_conflict),
    contrast_attention_score: concept.contrast_attention_score,
    clutter_risk: concept.clutter_risk,
  })
}

export function validateDistinctThumbnailConcepts(value: unknown): ThumbnailConcept[] {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(isValidThumbnailConcept)) throw new Error('Pontosan három teljes, olvasható thumbnail-koncepció szükséges.')
  const concepts = value.map(sanitizeThumbnailConcept)
  const labels = new Set(concepts.map(concept => identityText(concept.concept_label)))
  const visuals = new Set(concepts.map(concept => identityText(concept.visual_description)))
  if (labels.size !== 3 || visuals.size !== 3) throw new Error('A thumbnail-koncepcióknak vizuálisan különbözniük kell.')
  return concepts
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
- contrast_attention_score: 0-100, szubjektív AI-értékelés a kontraszt és vizuális figyelem várható erejéről; ez NEM mért figyelem, CTR vagy A/B teszteredmény
- clutter_risk: "low"/"medium"/"high" — mennyire zsúfolt a koncepció

KRITIKUS SZABÁLYOK:
- A thumbnail_text legyen VALÓBAN rövid (max 3-4 szó), ne mondat.
- A thumbnail_text legfeljebb 24 karakter lehet.
- A 3 koncepció legyen TÉNYLEGESEN különböző vizuálisan, ne csak szöveg-variáns.
- SOHA ne használj idézőjelet a JSON string értékek BELSEJÉBEN.
- ${STAY_ON_TOPIC_RULE}
- A szövegek teljesen magyar nyelvűek legyenek, idegen szavak nélkül (kivéve közismert márkanév vagy szakkifejezés).

Válaszolj KIZÁRÓLAG valid JSON tömbben:
[{"concept_label": "...", "visual_description": "...", "thumbnail_text": "...", "composition_note": "...", "emotion_or_conflict": "...", "contrast_attention_score": 0, "clutter_risk": "low"}]`
}
