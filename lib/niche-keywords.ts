// ============================================================
// WILLVIRAL — Niche Keyword Map v4
// Max 6 kulcsszó / generálás, prioritás-alapú kiválasztás
// v4: US régión CSAK angol kulcsszavak, HU régión CSAK magyar
// ============================================================

export const NICHE_KEYWORD_MAP: Record<string, { hu: string[]; en: string[] }> = {
  tech_ai: {
    hu: ['mesterséges intelligencia', 'új technológia', 'jövő technológia', 'okoseszköz', 'digitalizáció'],
    en: ['AI technology', 'artificial intelligence explained', 'future technology', 'new invention', 'robotics news', 'quantum computing'],
  },
  science_weird: {
    hu: ['tudományos felfedezés', 'furcsa tények', 'bizarr tudomány', 'űrkutatás', 'orvosi felfedezés'],
    en: ['science discovery', 'weird science facts', 'space discovery', 'medical breakthrough', 'science explained'],
  },
  psychology: {
    hu: ['pszichológia', 'agy működése', 'emberi viselkedés', 'mentális egészség'],
    en: ['psychology facts', 'brain science', 'human behavior explained', 'mental health news'],
  },
  health: {
    hu: ['egészség', 'egészséges életmód', 'orvosi hírek', 'táplálkozás'],
    en: ['health news', 'nutrition facts', 'medical breakthrough', 'wellness explained', 'healthy lifestyle'],
  },
  news_current: {
    hu: ['aktuális hírek', 'mai hírek', 'gazdasági hírek', 'világhírek', 'hírek magyarázva'],
    en: ['breaking news explained', 'current events', 'news today', 'world news explained', 'daily news shorts'],
  },
  finance: {
    hu: ['pénzügyek', 'megtakarítás', 'befektetés', 'kriptovaluta'],
    en: ['personal finance tips', 'cryptocurrency news', 'investing explained', 'stock market news'],
  },
  history: {
    hu: ['történelem', 'történelmi tények', 'ókor'],
    en: ['history facts', 'ancient history explained', 'historical events'],
  },
  gaming: {
    hu: ['videojáték', 'gaming hírek', 'új játék'],
    en: ['video game news', 'gaming news', 'game review'],
  },
  entertainment: {
    hu: ['szórakozás', 'filmhírek', 'sztárhírek'],
    en: ['celebrity news', 'movie news', 'entertainment explained'],
  },
  default: {
    hu: ['érdekes tények', 'furcsa hírek', 'tudtad hogy'],
    en: ['interesting facts', 'did you know', 'explained simply'],
  },
}

// Magyar → Angol niche fordítási térkép
// Ha a user magyarul adja meg a niche-t és US régiót választ,
// ezekkel az angol kulcsszavakkal keresünk YouTube-on
const HU_TO_EN_NICHE_MAP: Record<string, string[]> = {
  // Hírek
  'hírek': ['breaking news explained', 'news shorts', 'current events'],
  'hír': ['breaking news', 'news explained', 'daily news'],
  'aktuális': ['current events', 'news today'],
  'politika': ['politics explained', 'political news'],
  // Egészség
  'egészség': ['health news', 'wellness explained', 'medical facts'],
  'táplálkozás': ['nutrition facts', 'healthy eating'],
  'fitness': ['fitness tips', 'workout explained'],
  // Tudomány
  'tudomány': ['science explained', 'science facts', 'science news'],
  'tudományos': ['science discovery', 'scientific facts'],
  'űr': ['space discovery', 'space news explained'],
  // Tech
  'tech': ['technology news', 'tech explained'],
  'technológia': ['technology explained', 'tech news'],
  'ai': ['artificial intelligence', 'AI explained'],
  'mesterséges': ['artificial intelligence explained', 'AI news'],
  // Pszichológia
  'pszichológia': ['psychology facts', 'human behavior'],
  'agy': ['brain science', 'neuroscience explained'],
  'mentális': ['mental health explained', 'psychology news'],
  // Pénzügy
  'pénz': ['personal finance', 'money explained'],
  'befektetés': ['investing explained', 'investment news'],
  'kripto': ['cryptocurrency news', 'crypto explained'],
  // Történelem
  'történelem': ['history facts explained', 'historical events'],
  // Szórakozás
  'film': ['movie news', 'film explained'],
  'sztár': ['celebrity news', 'entertainment news'],
}

const NICHE_CATEGORY_TRIGGERS: Record<string, string[]> = {
  tech_ai: ['tech', 'ai', 'mesterséges', 'robot', 'digital', 'szoftver', 'gadget', 'okoseszköz', 'artificial intelligence', 'technology'],
  science_weird: ['tudomány', 'science', 'űr', 'space', 'fizika', 'kémia', 'biológia', 'furcsa', 'weird'],
  psychology: ['pszicho', 'agy', 'mentál', 'viselkedés', 'psychology', 'brain', 'mental'],
  health: ['egészség', 'health', 'fitness', 'táplálkozás', 'orvosi', 'medical', 'wellness', 'nutrition'],
  news_current: ['hír', 'news', 'aktuál', 'politika', 'world', 'breaking', 'current events'],
  finance: ['pénz', 'finance', 'befektet', 'gazdaság', 'crypto', 'economy', 'investing'],
  history: ['történelem', 'history', 'ókor', 'háború'],
  gaming: ['game', 'játék', 'gaming', 'esport'],
  entertainment: ['film', 'movie', 'sztár', 'celebrity', 'szórakozás', 'pop'],
}

function detectNicheCategoriesRaw(nicheText: string): string[] {
  const lower = nicheText.toLowerCase()
  const matched: string[] = []
  for (const [category, triggers] of Object.entries(NICHE_CATEGORY_TRIGGERS)) {
    if (triggers.some(t => lower.includes(t))) matched.push(category)
  }
  return matched
}

export function detectNicheCategories(nicheText: string, excludedCategories?: Set<string>): string[] {
  const matched = detectNicheCategoriesRaw(nicheText).filter(cat => !excludedCategories?.has(cat))
  if (matched.length === 0) {
    return excludedCategories?.has('default') ? [] : ['default']
  }
  return matched
}

export interface KeywordGenerationOptions {
  region?: 'HU' | 'US' | 'BOTH'
  maxKeywords?: number
  memoryKeyword?: string | null
  excludedCategories?: Set<string>
}

export interface KeywordWithCategory {
  keyword: string
  category: string
}

export function generateSearchKeywords(nicheText: string, opts: KeywordGenerationOptions = {}): string[] {
  return generateSearchKeywordsWithCategory(nicheText, opts).map(k => k.keyword)
}

// Magyar szöveg felismerés
function isHungarianText(text: string): boolean {
  return /[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/.test(text) || detectNicheCategoriesRaw(text).length > 0
}

// Magyar niche szövegből angol kulcsszavak generálása US régióhoz
function getEnglishKeywordsForHungarianNiche(nicheText: string, category: string, maxKeywords: number): KeywordWithCategory[] {
  const lower = nicheText.toLowerCase()
  const result: KeywordWithCategory[] = []
  const keywordSet = new Set<string>()
  const add = (keyword: string, cat: string) => {
    if (!keyword || keywordSet.has(keyword)) return
    keywordSet.add(keyword)
    result.push({ keyword, category: cat })
  }

  // 1. Direkt fordítás a HU→EN térképből
  for (const [huTrigger, enKeywords] of Object.entries(HU_TO_EN_NICHE_MAP)) {
    if (lower.includes(huTrigger)) {
      for (const kw of enKeywords) {
        add(kw, category)
        if (result.length >= maxKeywords) return result
      }
    }
  }

  // 2. Kategória EN seed-ek kiegészítésként
  const enSeeds = NICHE_KEYWORD_MAP[category]?.en || NICHE_KEYWORD_MAP.default.en
  for (const seed of enSeeds) {
    add(seed, category)
    if (result.length >= maxKeywords) return result
  }

  // 3. Ha még mindig kevés: default EN
  for (const seed of NICHE_KEYWORD_MAP.default.en) {
    add(seed, 'default')
    if (result.length >= maxKeywords) return result
  }

  return result
}

export function generateSearchKeywordsWithCategory(nicheText: string, opts: KeywordGenerationOptions = {}): KeywordWithCategory[] {
  const { region = 'HU', maxKeywords = 6, memoryKeyword = null, excludedCategories } = opts

  const rawMatch = detectNicheCategoriesRaw(nicheText)
  const isRecognized = rawMatch.length > 0
  let categories = detectNicheCategories(nicheText, excludedCategories)
  if (categories.length === 0) categories = ['default']
  const detectedCategory = categories[0] || 'default'

  // ── US RÉGIÓ: CSAK angol kulcsszavak ─────────────────────────────────────
  if (region === 'US') {
    const isHungarian = isHungarianText(nicheText)

    if (isHungarian) {
      // Magyar niche szöveg → fordítjuk angolra
      return getEnglishKeywordsForHungarianNiche(nicheText, detectedCategory, maxKeywords)
    } else {
      // Már angol niche szöveg → kategória EN seed-ek + a szöveg maga
      const result: KeywordWithCategory[] = []
      const keywordSet = new Set<string>()
      const addEn = (keyword: string, cat: string) => {
        if (!keyword || keywordSet.has(keyword)) return
        keywordSet.add(keyword)
        result.push({ keyword, category: cat })
      }

      const fullNiche = nicheText.trim()
      if (fullNiche.split(/\s+/).length <= 4) addEn(fullNiche, detectedCategory)

      const enSeeds = NICHE_KEYWORD_MAP[detectedCategory]?.en || NICHE_KEYWORD_MAP.default.en
      for (const seed of enSeeds) {
        addEn(seed, detectedCategory)
        if (result.length >= maxKeywords) break
      }

      if (memoryKeyword && !keywordSet.has(memoryKeyword)) {
        addEn(memoryKeyword, detectedCategory)
      }

      return result.slice(0, maxKeywords)
    }
  }

  // ── HU RÉGIÓ: CSAK magyar kulcsszavak ────────────────────────────────────
  const result: KeywordWithCategory[] = []
  const keywordSet = new Set<string>()
  const add = (keyword: string, cat: string) => {
    if (!keyword || keywordSet.has(keyword)) return
    keywordSet.add(keyword)
    result.push({ keyword, category: cat })
  }

  const nicheWords = nicheText.split(/[,;/]+/).map(s => s.trim()).filter(w => w.length > 2)
  const fullNicheText = nicheText.trim()

  // 1. Teljes user szöveg (max 4 szó)
  if (fullNicheText.length > 0 && fullNicheText.split(/\s+/).length <= 4) {
    add(fullNicheText, detectedCategory)
  }

  // 2. Első felbontott szó
  if (nicheWords[0] && nicheWords[0] !== fullNicheText) add(nicheWords[0], detectedCategory)
  if (nicheWords[1]) add(nicheWords[1], detectedCategory)

  // 3. Kategória HU seed-ek
  if (isRecognized) {
    for (const cat of categories) {
      const seeds = NICHE_KEYWORD_MAP[cat]?.hu || []
      for (const seed of seeds) {
        add(seed, cat)
        if (result.length >= maxKeywords) break
      }
      if (result.length >= maxKeywords) break
    }
  } else {
    add(`${fullNicheText} videók`, 'default')
    add(`${fullNicheText} érdekességek`, 'default')
  }

  // 4. Creator Memory
  if (memoryKeyword && !keywordSet.has(memoryKeyword)) {
    add(memoryKeyword, detectedCategory)
  }

  // 5. Feltöltő
  while (result.length < maxKeywords) {
    let addedAny = false
    for (const cat of categories) {
      const seed = NICHE_KEYWORD_MAP[cat]?.hu.find(k => !keywordSet.has(k))
      if (seed) { add(seed, cat); addedAny = true; if (result.length >= maxKeywords) break }
    }
    if (!addedAny) {
      const seed = NICHE_KEYWORD_MAP.default.hu.find(k => !keywordSet.has(k))
      if (seed) { add(seed, 'default'); addedAny = true }
    }
    if (!addedAny) break
  }

  return result.slice(0, maxKeywords)
}
