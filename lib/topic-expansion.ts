import type { NicheCategory } from './niche-seeds'

export type ExpansionType =
  | 'current'
  | 'scientific'
  | 'storytelling'
  | 'youtube_creator'
  | 'hungarian_market'
  | 'global_adaptable'

export type ExpansionIntent =
  | 'find_trend'
  | 'find_story_angle'
  | 'find_web_evidence'
  | 'find_youtube_evidence'

export interface TopicExpansionQuery {
  query: string
  expansion_type: ExpansionType
  language: 'hu' | 'en'
  region: 'HU' | 'US' | 'GLOBAL'
  intent: ExpansionIntent
}

export interface TopicExpansionResult {
  user_input: string
  normalized_topic: string
  category: NicheCategory
  queries: TopicExpansionQuery[]
  suggested_specific_topics: string[]
}

function normalize(value: string) {
  return value
    .trim()
    .replace(/\s+/g, ' ')
}

function asciiFold(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function uniqueByQuery(items: TopicExpansionQuery[]) {
  const seen = new Set<string>()
  return items.filter(item => {
    const key = asciiFold(item.query)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function classifyTopic(topic: string): NicheCategory {
  const n = asciiFold(topic)
  if (/\b(ai|mesterséges|intelligencia|robot|robotok|tech|technology|chatgpt|openai)\b/.test(n)) return 'tech_ai'
  if (/\b(rak|cancer|egeszseg|health|orvos|medical|alvas|sleep|gyogyszer|drug)\b/.test(n)) return 'science_medical'
  if (/\b(pszich|psychology|memoria|memory|agy|brain|dopamine|dontes|bias)\b/.test(n)) return 'psychology'
  if (/\b(tortenelem|history|romai|rome|regeszet|archaeology|piramis|pyramid|egyiptom|egypt)\b/.test(n)) return 'history_strange'
  if (/\b(ufo|rejtely|mystery|paranormal)\b/.test(n)) return 'history_strange'
  if (/\b(penz|money|finance|crypto|befektetes|gazdasag)\b/.test(n)) return 'finance_crypto'
  if (/\b(kutya|kutyak|dog|dogs|allat|animal)\b/.test(n)) return 'default'
  return 'default'
}

function translateTopic(topic: string) {
  const n = asciiFold(topic)
  const exact: Record<string, string> = {
    piramis: 'Great Pyramid',
    piramisok: 'pyramids',
    pszichologia: 'psychology',
    alvas: 'sleep',
    'romai birodalom': 'Roman Empire',
    kutyak: 'dogs',
    penz: 'money',
    tortenelem: 'history',
    rak: 'cancer',
    memoria: 'memory',
    robotok: 'robots',
    egeszseg: 'health',
    ufo: 'UFO',
  }
  if (exact[n]) return exact[n]
  return topic
}

function genericQueries(topic: string, region: 'HU' | 'US', storyteller = false): TopicExpansionQuery[] {
  const t = normalize(topic)
  const en = translateTopic(t)
  const q: TopicExpansionQuery[] = []
  const add = (query: string, expansion_type: ExpansionType, language: 'hu' | 'en', intent: ExpansionIntent, regionOverride?: 'HU' | 'US' | 'GLOBAL') => {
    q.push({ query, expansion_type, language, region: regionOverride || (language === 'hu' ? 'HU' : 'GLOBAL'), intent })
  }

  add(`új kutatás ${t}`, 'current', 'hu', 'find_web_evidence')
  add(`friss hír ${t}`, 'current', 'hu', 'find_trend')
  add(`${t} 2026`, 'current', 'hu', 'find_trend')
  add(`miért történik ${t}`, 'scientific', 'hu', 'find_story_angle')
  add(`hogyan működik ${t}`, 'scientific', 'hu', 'find_web_evidence')
  add(`${t} tudományos magyarázat`, 'scientific', 'hu', 'find_web_evidence')
  add(`${t} rejtély`, 'storytelling', 'hu', 'find_story_angle')
  add(`${t} váratlan fordulat`, 'storytelling', 'hu', 'find_story_angle')
  add(`${t} explained`, 'youtube_creator', 'en', 'find_youtube_evidence')
  add(`why ${en}`, 'youtube_creator', 'en', 'find_youtube_evidence')
  add(`latest ${en} research`, 'global_adaptable', 'en', 'find_web_evidence')
  add(`${en} new discovery`, 'global_adaptable', 'en', 'find_trend')

  if (region === 'HU') {
    add(`${t} magyarul`, 'hungarian_market', 'hu', 'find_youtube_evidence', 'HU')
    add(`${t} érdekesség`, 'hungarian_market', 'hu', 'find_story_angle', 'HU')
  }

  if (storyteller) {
    add(`${t} emberi történet`, 'storytelling', 'hu', 'find_story_angle')
    add(`mystery behind ${en}`, 'storytelling', 'en', 'find_story_angle')
    add(`strange story about ${en}`, 'storytelling', 'en', 'find_story_angle')
  }

  return q
}

export function expandTopicQueries(
  userInput: string,
  region: 'HU' | 'US',
  options: { creatorStyle?: string; maxQueries?: number } = {},
): TopicExpansionResult {
  const normalized = normalize(userInput)
  const storyteller = /story|sztori|narrat|dokumentar|mrballen/i.test(options.creatorStyle || '')
  const maxQueries = options.maxQueries || 12
  const queries = uniqueByQuery([
    ...genericQueries(normalized, region, storyteller),
  ]).slice(0, maxQueries)

  return {
    user_input: userInput,
    normalized_topic: normalized,
    category: classifyTopic(normalized),
    queries,
    suggested_specific_topics: suggestSpecificTopics(normalized).slice(0, 3),
  }
}

export function expansionSeedStrings(input: string, region: 'HU' | 'US', options: { creatorStyle?: string; maxQueries?: number } = {}) {
  return expandTopicQueries(input, region, options).queries.map(q => q.query)
}

export function suggestSpecificTopics(input: string) {
  return [
    `${input} friss kutatás`,
    `${input} tudományos magyarázat`,
    `${input} rejtély vagy váratlan történet`,
  ]
}


export interface StoryPotentialScore {
  total: number
  mystery_factor: number
  twist_strength: number
  human_element: number
  conflict_or_tension: number
  narrative_payoff: number
  visual_story_potential: number
}

function keywordScore(text: string, words: string[], base = 35) {
  const normalized = asciiFold(text)
  const hits = words.filter(word => normalized.includes(asciiFold(word))).length
  return Math.min(95, base + hits * 15)
}

export function scoreStoryPotentialFromText(value: string, expansionType?: ExpansionType): StoryPotentialScore {
  const mystery = keywordScore(value, ['rejtely', 'mystery', 'titok', 'unknown', 'ancient', 'ufo', 'piramis', 'pyramid', 'eltunt', 'hidden'])
  const twist = keywordScore(value, ['varatlan', 'fordulat', 'breakthrough', 'discovery', 'felfedezes', 'atirja', 'changed', 'surprising'])
  const human = keywordScore(value, ['ember', 'people', 'memory', 'pszichologia', 'psychology', 'dontes', 'munka', 'health', 'ferfi', 'noi', 'agy'])
  const conflict = keywordScore(value, ['veszely', 'danger', 'fight', 'debate', 'controversy', 'earthquake', 'resistance', 'cancer', 'kockazat'])
  const payoff = keywordScore(value, ['why', 'miert', 'explained', 'magyarazat', 'truth', 'valosag', 'hogyan', 'mukodik'])
  const visual = keywordScore(value, ['pyramid', 'piramis', 'space', 'ur', 'robot', 'animal', 'allat', 'sleep', 'brain', 'agy', 'archaeology', 'regeszet'])
  const boost = expansionType === 'storytelling' ? 6 : expansionType === 'youtube_creator' ? 3 : 0
  const total = Math.round((mystery + twist + human + conflict + payoff + visual) / 6 + boost)

  return {
    total: Math.max(1, Math.min(99, total)),
    mystery_factor: mystery,
    twist_strength: twist,
    human_element: human,
    conflict_or_tension: conflict,
    narrative_payoff: payoff,
    visual_story_potential: visual,
  }
}

export function recommendedAngleForExpansion(expansionType: ExpansionType | undefined, topic: string) {
  switch (expansionType) {
    case 'current':
      return 'Friss fejlemény vagy új kutatás szöge'
    case 'scientific':
      return 'Tudományos magyarázó szög'
    case 'storytelling':
      return 'Rejtélyre vagy fordulatra épített sztori'
    case 'youtube_creator':
      return 'Creator-kompatibilis magyarázó feldolgozás'
    case 'hungarian_market':
      return 'Magyar közönségre szabott feldolgozás'
    case 'global_adaptable':
      return 'Globális, magyarítható trend'
    default:
      return `Konkrét, bizonyítékkal támasztott feldolgozás: ${topic}`
  }
}

export function recommendedFormatForExpansion(expansionType: ExpansionType | undefined, storyScore = 50) {
  if (expansionType === 'storytelling' && storyScore >= 65) return 'storytelling long'
  if (expansionType === 'current') return 'shorts / gyors magyarázó'
  if (expansionType === 'scientific') return 'magyarázó long'
  if (expansionType === 'youtube_creator') return 'shorts / explainer'
  if (expansionType === 'hungarian_market') return 'magyar piacra szabott explainer'
  return storyScore >= 70 ? 'storytelling explainer' : 'magyarázó videó'
}

export function hookPatternForExpansion(expansionType: ExpansionType | undefined, topic: string) {
  if (expansionType === 'storytelling') return `Mi van, ha a(z) ${topic} mögött nem az van, amit eddig hittünk?`
  if (expansionType === 'current') return `Most derült ki valami a(z) ${topic} témában, ami sok mindent megváltoztathat.`
  if (expansionType === 'scientific') return `A(z) ${topic} elsőre egyszerűnek tűnik, de a tudomány szerint van benne egy csavar.`
  if (expansionType === 'youtube_creator') return `Ez az a(z) ${topic} kérdés, amit rengetegen félreértenek.`
  return `Kezdd egy konkrét, meglepő példával: ${topic}.`
}

export function findExpansionForSeed(seed: string, expansion?: TopicExpansionResult): TopicExpansionQuery | undefined {
  if (!expansion || !seed) return undefined
  const foldedSeed = asciiFold(seed)
  return expansion.queries.find(q => asciiFold(q.query) === foldedSeed)
    || expansion.queries.find(q => foldedSeed.includes(asciiFold(q.query)) || asciiFold(q.query).includes(foldedSeed))
    || expansion.queries.find(q => {
      const seedWords = new Set(foldedSeed.split(' ').filter(w => w.length > 3))
      const queryWords = asciiFold(q.query).split(' ').filter(w => w.length > 3)
      if (queryWords.length === 0) return false
      const matches = queryWords.filter(w => seedWords.has(w)).length
      return matches >= Math.min(2, queryWords.length)
    })
}
