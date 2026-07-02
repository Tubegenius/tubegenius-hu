// lib/search/search-context.ts
// WillViral — Központi search context réteg.
// Minden modul (Opportunity Engine, Trend Radar, Similar Videos, Video
// Package források, Script/Inspiration) ugyanebből az alapból induljon,
// hogy ne tág, zajos niche-stringekből dolgozzanak külön-külön.

export type MainCategory =
  | 'science'
  | 'health'
  | 'tech_ai'
  | 'news_current'
  | 'psychology'
  | 'history'
  | 'finance'
  | 'lifestyle'
  | 'entertainment'
  | 'gaming'
  | 'sports'
  | 'education'
  | 'business'
  | 'crime_mystery'
  | 'space'
  | 'climate'
  | 'other'

export const MAIN_CATEGORIES: { value: MainCategory; label: string }[] = [
  { value: 'science', label: 'Tudomány' },
  { value: 'health', label: 'Egészség' },
  { value: 'tech_ai', label: 'Tech / AI' },
  { value: 'news_current', label: 'Hírek / aktuális témák' },
  { value: 'psychology', label: 'Pszichológia' },
  { value: 'history', label: 'Történelem' },
  { value: 'finance', label: 'Pénzügy' },
  { value: 'lifestyle', label: 'Életmód' },
  { value: 'entertainment', label: 'Szórakozás' },
  { value: 'gaming', label: 'Gaming' },
  { value: 'sports', label: 'Sport' },
  { value: 'education', label: 'Oktatás' },
  { value: 'business', label: 'Üzlet / vállalkozás' },
  { value: 'crime_mystery', label: 'Bűnügy / rejtély' },
  { value: 'space', label: 'Űrkutatás' },
  { value: 'climate', label: 'Környezet / klíma' },
  { value: 'other', label: 'Egyéb' },
]

export function categoryLabel(cat: MainCategory | string | null | undefined): string {
  return MAIN_CATEGORIES.find(c => c.value === cat)?.label || 'Egyéb'
}

// A dropdown NEM keresési kulcsszólista — csak tágabb kontextust ad a
// query generáláshoz (pl. nyelvi regiszter, tipikus formátum).
export const CATEGORY_SEED_MAP: Record<MainCategory, { hint: string }> = {
  science: { hint: 'tudományos felfedezés, kutatás, magyarázó tartalom' },
  health: { hint: 'egészség, orvostudomány, wellness' },
  tech_ai: { hint: 'technológia, mesterséges intelligencia, szoftver/eszköz' },
  news_current: { hint: 'aktuális hír, friss esemény' },
  psychology: { hint: 'pszichológia, emberi viselkedés, mentális egészség' },
  history: { hint: 'történelmi esemény, történelmi elemzés' },
  finance: { hint: 'pénzügy, befektetés, gazdaság' },
  lifestyle: { hint: 'életmód, produktivitás, mindennapi élet' },
  entertainment: { hint: 'szórakoztatás, popkultúra' },
  gaming: { hint: 'videójáték, gaming kultúra' },
  sports: { hint: 'sport, verseny, sportoló' },
  education: { hint: 'oktatás, tanulás, ismeretterjesztés' },
  business: { hint: 'üzlet, vállalkozás, startup' },
  crime_mystery: { hint: 'bűnügy, rejtély, nyomozás' },
  space: { hint: 'űrkutatás, csillagászat' },
  climate: { hint: 'környezet, klímaváltozás, fenntarthatóság' },
  other: { hint: 'általános tartalom' },
}

export interface SearchContextInput {
  main_category: MainCategory
  specific_focus: string
  audience?: string | null
  avoid_topics?: string | null
  region: 'HU' | 'US'
  language: 'hu' | 'en'
}

export interface SearchContext extends SearchContextInput {
  category_hint: string
  category_label: string
  // A régi modulok kompatibilitása miatt — egyetlen niche stringgé sűrítve.
  legacy_niche: string
}

export function buildSearchContext(input: SearchContextInput): SearchContext {
  const category_label = categoryLabel(input.main_category)
  const category_hint = CATEGORY_SEED_MAP[input.main_category]?.hint || CATEGORY_SEED_MAP.other.hint

  return {
    ...input,
    category_label,
    category_hint,
    // FONTOS: a niche pipeline (decomposeNicheToLanes stb.) vesszőt/perjelet
    // kategória-elválasztónak értelmez — néhány category_label ("Tech / AI",
    // "Bűnügy / rejtély" stb.) "/" karaktert tartalmaz, ami tévesen broad_niche
    // intent-et váltana ki. A legacy_niche ezért CSAK a tiszta fókuszt adja.
    legacy_niche: input.specific_focus.trim(),
  }
}

// Kompatibilitási segéd — ha csak a régi `niche` TEXT mező áll rendelkezésre
// (pl. régi profil, még nem töltötte ki a strukturált mezőket).
export function contextFromLegacyNiche(niche: string, region: 'HU' | 'US', language: 'hu' | 'en'): SearchContext {
  return buildSearchContext({
    main_category: 'other',
    specific_focus: niche,
    region,
    language,
  })
}
