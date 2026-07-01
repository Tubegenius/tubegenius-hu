// ============================================================
// WILLVIRAL — Centralizált modell konfiguráció
// Ha modellt kell váltani, EGY helyen kell módosítani.
// ============================================================

export const MODELS = {
  // Kreatív generálás, hosszú narráció, Video Audit, Script Extract
  primary: 'claude-sonnet-4-6',
  // Gyors magyarázatok, csomagolás (titles, hashtags, caption), pool explain
  fast: 'claude-haiku-4-5-20251001',
} as const

export type ModelKey = keyof typeof MODELS
