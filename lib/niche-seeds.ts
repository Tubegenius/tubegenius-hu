// lib/niche-seeds.ts
// WillViral — Curated Seed Map v1
// Témakategóriánként konkrét, nem általános seed kulcsszavak
// Freshness window kategóriánként változik

export type NicheCategory =
  | 'news_current'
  | 'tech_ai'
  | 'science_medical'
  | 'space_discovery'
  | 'psychology'
  | 'health_wellness'
  | 'finance_crypto'
  | 'history_strange'
  | 'gaming'
  | 'entertainment'
  | 'default'

// Freshness window napokban — kategóriánként
export const FRESHNESS_WINDOW_DAYS: Record<NicheCategory, number> = {
  news_current:    14,   // 2 hét — hír téma gyorsan avul
  tech_ai:         45,   // 45 nap
  science_medical: 90,   // 3 hónap
  space_discovery: 90,   // 3 hónap
  psychology:      120,  // 4 hónap
  health_wellness: 90,   // 3 hónap
  finance_crypto:  21,   // 3 hét — kripto gyorsan változik
  history_strange: 365,  // 1 év — evergreen
  gaming:          30,   // 1 hónap
  entertainment:   21,   // 3 hét
  default:         60,   // 2 hónap
}

// Curated seed-ek — konkrét, nem általános
// HU: magyar piaci kereséshez
// EN: globális piaci kereséshez
export const NICHE_SEEDS: Record<NicheCategory, { hu: string[]; en: string[] }> = {
  news_current: {
    hu: [
      'magyarország hírek 2026',
      'aktuális politikai hírek',
      'gazdasági hírek magyarország',
      'napi hírek összefoglaló',
      'friss hírek ma',
    ],
    en: [
      'breaking news explained 2026',
      'current events summary',
      'world news today explained',
      'politics explained simply',
      'news in 60 seconds',
    ],
  },
  tech_ai: {
    hu: [
      'mesterséges intelligencia 2026',
      'AI új fejlesztés',
      'chatgpt újdonság',
      'robotika áttörés',
      'kvantumszámítógép fejlesztés',
    ],
    en: [
      'AI breakthrough 2026',
      'new AI model release',
      'artificial intelligence explained',
      'robotics breakthrough',
      'quantum computing update',
      'AI cancer diagnosis',
      'AI drug discovery',
    ],
  },
  science_medical: {
    hu: [
      'orvosi áttörés 2026',
      'új gyógyszer felfedezés',
      'rák kezelés újdonság',
      'tudományos felfedezés',
      'CRISPR génterápia',
    ],
    en: [
      'medical breakthrough 2026',
      'new cancer treatment',
      'AI medicine discovery',
      'longevity research',
      'CRISPR therapy update',
      'new drug discovery',
      'brain science discovery',
    ],
  },
  space_discovery: {
    hu: [
      'james webb teleszkóp felfedezés',
      'nasa új felfedezés',
      'mars misszió hírek',
      'fekete lyuk felfedezés',
      'exobolygó felfedezés',
    ],
    en: [
      'James Webb new discovery',
      'NASA discovery 2026',
      'space discovery explained',
      'mars mission update',
      'black hole discovery',
      'exoplanet discovery',
    ],
  },
  psychology: {
    hu: [
      'pszichológia tudományos kutatás',
      'agy működése felfedezés',
      'dopamin kutatás',
      'mentális egészség kutatás',
      'emberi viselkedés pszichológia',
    ],
    en: [
      'psychology research discovery',
      'brain science explained',
      'dopamine science',
      'mental health research',
      'human behavior psychology',
      'neuroscience breakthrough',
    ],
  },
  health_wellness: {
    hu: [
      'egészség tudományos kutatás',
      'táplálkozás új kutatás',
      'alvás egészség tudomány',
      'immunrendszer erősítés',
      'bélmikrobiom kutatás',
    ],
    en: [
      'health science research',
      'nutrition science study',
      'sleep health explained',
      'immune system science',
      'gut microbiome research',
      'longevity diet science',
    ],
  },
  finance_crypto: {
    hu: [
      'bitcoin árfolyam hírek',
      'kriptovaluta piaci hírek',
      'befektetési lehetőségek 2026',
      'gazdasági válság hírek',
      'tőzsde hírek magyarország',
    ],
    en: [
      'bitcoin news 2026',
      'cryptocurrency market update',
      'stock market news explained',
      'investing tips 2026',
      'economic news explained',
    ],
  },
  history_strange: {
    hu: [
      'furcsa történelmi tények',
      'rejtélyes felfedezés régészet',
      'összeesküvés elméletek igazság',
      'különös tudományos tény',
      'titokzatos helyek világ',
    ],
    en: [
      'strange history facts',
      'mysterious archaeological discovery',
      'weird science facts explained',
      'conspiracy theory debunked',
      'mysterious places world',
    ],
  },
  gaming: {
    hu: [
      'GTA 6 hírek',
      'új játék megjelenés 2026',
      'gaming hírek',
      'esport eredmények',
    ],
    en: [
      'GTA 6 news',
      'new game release 2026',
      'gaming news explained',
      'esports results',
    ],
  },
  entertainment: {
    hu: [
      'film hírek 2026',
      'sorozat újdonság',
      'sztár hírek',
      'zenei hírek',
    ],
    en: [
      'movie news 2026',
      'new series explained',
      'celebrity news',
      'music industry news',
    ],
  },
  default: {
    hu: [
      'érdekes felfedezés 2026',
      'tudtad hogy tény',
      'meglepő kutatás eredmény',
    ],
    en: [
      'interesting discovery 2026',
      'did you know facts',
      'surprising research finding',
    ],
  },
}

// Kategória felismerés a niche szövegből
const CATEGORY_TRIGGERS: Record<NicheCategory, string[]> = {
  news_current:    ['hír', 'news', 'aktuál', 'politika', 'world', 'breaking', 'current events', 'hírek'],
  tech_ai:         ['tech', 'ai', 'mesterséges', 'robot', 'digital', 'szoftver', 'gadget', 'okoseszköz', 'artificial intelligence', 'technology'],
  science_medical: ['tudomány', 'orvosi', 'medical', 'science', 'kémia', 'biológia', 'gyógyszer', 'rák', 'fizika'],
  space_discovery: ['űr', 'space', 'nasa', 'bolygó', 'galaxy', 'webb', 'mars'],
  psychology:      ['pszicho', 'agy', 'mentál', 'viselkedés', 'psychology', 'brain', 'mental'],
  health_wellness: ['egészség', 'health', 'fitness', 'táplálkozás', 'wellness', 'alvás', 'diéta'],
  finance_crypto:  ['pénz', 'finance', 'befektet', 'gazdaság', 'crypto', 'bitcoin', 'tőzsde', 'economy'],
  history_strange: ['történelem', 'history', 'ókor', 'háború', 'furcsa', 'rejtélyes', 'strange', 'weird'],
  gaming:          ['game', 'játék', 'gaming', 'esport', 'gta', 'minecraft'],
  entertainment:   ['film', 'movie', 'sztár', 'celebrity', 'szórakozás', 'sorozat', 'zene'],
  default:         [],
}

export function detectCategory(nicheText: string): NicheCategory {
  const lower = nicheText.toLowerCase()
  for (const [category, triggers] of Object.entries(CATEGORY_TRIGGERS)) {
    if (category === 'default') continue
    if (triggers.some(t => lower.includes(t))) return category as NicheCategory
  }
  return 'default'
}

export function getFreshnessWindowDays(category: NicheCategory): number {
  return FRESHNESS_WINDOW_DAYS[category]
}

export function getSeedsForRegion(category: NicheCategory, region: 'HU' | 'US', maxSeeds = 5): string[] {
  const seeds = NICHE_SEEDS[category]
  const list = region === 'US' ? seeds.en : seeds.hu
  return list.slice(0, maxSeeds)
}
