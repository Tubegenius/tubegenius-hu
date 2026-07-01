import type { NicheCategory } from './niche-seeds'
import { expandTopicQueries } from './topic-expansion'

export type NicheIntent = 'specific_topic' | 'broad_niche'

export interface BroadDiscoveryPack {
  label: string
  category: NicheCategory
  seeds: string[]
  freshnessWindowDays: number
  searchRegion: 'HU' | 'US'
}

function normalize(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const BROAD_FACT_PATTERNS = [
  /\berdekes\s+tenyek\b/i,
  /\btudtad\b/i,
  /\btudtad\s+hogy\b/i,
  /\bfun\s+facts\b/i,
  /\binteresting\s+facts\b/i,
  /\bdid\s+you\s+know\b/i,
  /\bfacts\b/i,
  /\btop\s+10\b/i,
  /\blisticle\b/i,
]

const GENERIC_NICHE_WORDS = new Set([
  'erdekes', 'tenyek', 'dolgok', 'videok', 'facts', 'interesting', 'viral', 'trend', 'trending', 'shorts',
])

const BROAD_NICHE_CATEGORIES = new Set([
  'autok', 'auto', 'cars', 'automotive',
  'sport', 'sports', 'foci', 'focilab', 'futball', 'football', 'soccer',
  'gaming', 'jatek', 'jatekok', 'games',
  'zene', 'music', 'zenei',
  'film', 'filmek', 'movies', 'sorozat', 'sorozatok', 'series',
  'horror', 'krimi', 'thriller', 'mystery', 'true crime',
  'egeszseg', 'health', 'fitness', 'edzes', 'workout',
  'penzugy', 'finance', 'money', 'penz', 'befektetes', 'investing', 'crypto', 'kripto',
  'tech', 'technology', 'technologia', 'it',
  'tudomany', 'science',
  'tortenelem', 'history', 'tortenet',
  'pszichologia', 'psychology', 'lelelek', 'mental',
  'utazas', 'travel', 'travelling',
  'fozas', 'cooking', 'recept', 'konyha', 'food',
  'divat', 'fashion', 'beauty', 'szepseg',
  'allatok', 'animals', 'pets', 'termeszet', 'nature',
  'urteknologia', 'space', 'ur', 'urkutatas',
  'motivacio', 'motivation', 'onismeret', 'selfhelp',
  'hirek', 'news', 'politika', 'politics',
  'oktatas', 'education', 'tanulas', 'learning',
  'diy', 'barkacs', 'crafts',
  'meme', 'memes', 'humor', 'comedy', 'vicc',
  'rejtely', 'rejtelyek', 'mysteries', 'paranormal',
  'hadtortenet', 'military', 'haboru', 'war',
])

export function detectNicheIntent(niche: string): NicheIntent {
  const value = normalize(niche)
  if (!value) return 'specific_topic'
  if (BROAD_FACT_PATTERNS.some(pattern => pattern.test(value))) return 'broad_niche'

  const commaSegments = niche.split(/[,;\/]+/).map(s => s.trim()).filter(s => s.length > 1)
  if (commaSegments.length >= 2) {
    const broadCount = commaSegments.filter(seg => {
      const norm = normalize(seg)
      return BROAD_NICHE_CATEGORIES.has(norm) || norm.split(/\s+/).some(w => BROAD_NICHE_CATEGORIES.has(w))
    }).length
    if (broadCount >= 2) return 'broad_niche'
  }

  const words = value.split(/\s+/).filter(Boolean)
  const genericCount = words.filter(word => GENERIC_NICHE_WORDS.has(word)).length
  if (words.length <= 3 && genericCount >= Math.max(1, words.length - 1)) return 'broad_niche'

  if (words.length <= 2 && words.some(w => BROAD_NICHE_CATEGORIES.has(w))) return 'broad_niche'
  if (words.length === 1 && words[0].length <= 15) return 'broad_niche'
  if (words.length <= 3 && !value.includes('2025') && !value.includes('2026') && !/\d{4,}/.test(value)) {
    const hasSpecificEntity = /[A-ZÁÉÍÓÖŐÚÜŰ]/.test(niche.trim().slice(1))
    if (!hasSpecificEntity) return 'broad_niche'
  }

  return 'specific_topic'
}

const NICHE_DISCOVERY_MAP: Record<string, BroadDiscoveryPack[]> = {}

function buildFactDiscoveryPacks(searchRegion: 'HU' | 'US'): BroadDiscoveryPack[] {
  return [
    {
      label: 'Friss tudományos felfedezések, amelyek átírhatnak egy hétköznapi tévhitet',
      category: 'science_medical',
      freshnessWindowDays: 180,
      searchRegion,
      seeds: ['new science discovery changes what we know explained', 'recent study surprising finding explained', 'science breakthrough everyday life explained'],
    },
    {
      label: 'Emberi test: furcsa működések, amelyekre most ad magyarázatot a kutatás',
      category: 'science_medical',
      freshnessWindowDays: 180,
      searchRegion,
      seeds: ['weird human body facts new research explained', 'human body mystery explained by science', 'new study human body surprising finding'],
    },
    {
      label: 'Agy és memória: meglepő pszichológiai kísérletek és új eredmények',
      category: 'psychology',
      freshnessWindowDays: 180,
      searchRegion,
      seeds: ['memory psychology new study explained', 'brain science surprising experiment explained', 'psychology study changes how we think'],
    },
    {
      label: 'Alvás, álmok és döntések: friss kutatások hétköznapi következményekkel',
      category: 'psychology',
      freshnessWindowDays: 180,
      searchRegion,
      seeds: ['sleep science new study explained', 'dream research surprising findings explained', 'sleep affects decision making study'],
    },
    {
      label: 'Régészeti felfedezések, amelyek megváltoztatnak egy történelmi sztorit',
      category: 'history_strange',
      freshnessWindowDays: 365,
      searchRegion,
      seeds: ['archaeology discovery changes history explained', 'ancient discovery new evidence explained', 'recent archaeological find explained'],
    },
    {
      label: 'Eltűnt civilizációk és rejtélyes tárgyak új magyarázattal',
      category: 'history_strange',
      freshnessWindowDays: 365,
      searchRegion,
      seeds: ['lost civilization discovery explained', 'mysterious ancient artifact explained', 'ancient mystery new evidence explained'],
    },
    {
      label: 'Állati intelligencia: viselkedések, amelyek emberinek tűnnek',
      category: 'default',
      freshnessWindowDays: 365,
      searchRegion,
      seeds: ['animal intelligence surprising behavior explained', 'animals smarter than we thought study', 'weird animal behavior science explained'],
    },
    {
      label: 'Természeti jelenségek, amelyek elsőre lehetetlennek tűnnek',
      category: 'default',
      freshnessWindowDays: 365,
      searchRegion,
      seeds: ['strange natural phenomenon explained', 'rare nature event science explained', 'weird weather phenomenon explained'],
    },
    {
      label: 'Űrkutatás: új NASA vagy James Webb felfedezések közérthetően',
      category: 'space_discovery',
      freshnessWindowDays: 180,
      searchRegion,
      seeds: ['NASA new discovery explained', 'James Webb telescope discovery explained', 'space discovery changes astronomy explained'],
    },
    {
      label: 'Bolygók és idegen világok: friss felfedezések látványos sztorival',
      category: 'space_discovery',
      freshnessWindowDays: 180,
      searchRegion,
      seeds: ['exoplanet discovery explained', 'new planet discovery explained', 'strange planet science explained'],
    },
  ]
}

function inferNicheCategory(niche: string): NicheCategory {
  const n = normalize(niche)
  if (/auto|car|jarm/.test(n)) return 'tech_ai'
  if (/sport|foci|futball|football/.test(n)) return 'entertainment'
  if (/gaming|jatek|game/.test(n)) return 'entertainment'
  if (/film|movie|sorozat|series|horror|krimi/.test(n)) return 'entertainment'
  if (/penz|finance|crypto|kripto|befektet|invest/.test(n)) return 'finance_crypto'
  if (/tech|it|ai|program/.test(n)) return 'tech_ai'
  if (/tudomany|science|kutatas/.test(n)) return 'science_medical'
  if (/tortenel|history|haboru|war|military/.test(n)) return 'history_strange'
  if (/egeszseg|health|fitness|edzes/.test(n)) return 'health_wellness'
  if (/pszich|mental|psychology|motivac/.test(n)) return 'psychology'
  if (/ur|space|bolygok|nasa/.test(n)) return 'space_discovery'
  if (/zene|music/.test(n)) return 'entertainment'
  if (/hir|news|politika|politic/.test(n)) return 'news_current'
  if (/foz|cook|recept|food|konyha/.test(n)) return 'health_wellness'
  if (/utaz|travel/.test(n)) return 'default'
  if (/allat|animal|termeszet|nature/.test(n)) return 'default'
  return 'default'
}

function inferFreshnessWindow(niche: string): number {
  const n = normalize(niche)
  if (/hir|news|politika|politic|crypto|kripto|toz/.test(n)) return 14
  if (/tech|ai|it|program|gaming|game/.test(n)) return 60
  if (/sport|foci|futball|football/.test(n)) return 30
  if (/film|movie|sorozat|series/.test(n)) return 90
  if (/auto|car/.test(n)) return 90
  if (/tudomany|science|kutatas|egeszseg|health/.test(n)) return 120
  if (/tortenel|history|horror|krimi|rejtely/.test(n)) return 365
  return 120
}

export function buildDrilldownSeedsForDirection(direction: string): {
  seeds: string[]
  freshnessWindowDays: number
  category: NicheCategory
} {
  const category = inferNicheCategory(direction)
  const freshnessWindowDays = Math.max(120, inferFreshnessWindow(direction))
  const base = normalize(direction)
    .replace(/\b(explained|new research|breakthrough|study|why|how|facts|trending|viral)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || direction

  const seeds = [
    direction,
    `${base} explained`,
    `${base} new research`,
    `${base} breakthrough`,
    `why ${base} matters`,
    `${base} surprising facts`,
    `${base} case study`,
    `${base} documentary`,
  ]

  return {
    seeds: [...new Set(seeds.map(seed => seed.trim()).filter(Boolean))].slice(0, 6),
    freshnessWindowDays,
    category,
  }
}

export function buildBroadNicheDiscoveryPacks(niche: string, region: 'HU' | 'US'): BroadDiscoveryPack[] {
  const searchRegion: 'HU' | 'US' = region === 'HU' ? 'US' : region
  const n = normalize(niche)

  if (BROAD_FACT_PATTERNS.some(p => p.test(n))) {
    return buildFactDiscoveryPacks(searchRegion).slice(0, 5)
  }

  const category = inferNicheCategory(niche)
  const freshness = inferFreshnessWindow(niche)
  const nicheEn = n

  return buildDynamicPacksForNiche(niche, nicheEn, category, freshness, searchRegion)
}

function buildDynamicPacksForNiche(
  niche: string,
  _nicheEn: string,
  category: NicheCategory,
  freshnessWindowDays: number,
  searchRegion: 'HU' | 'US',
): BroadDiscoveryPack[] {
  const n = normalize(niche)

  const subtopicMap: Record<string, Array<{ label: string; seeds: string[] }>> = {
    piramis: [
      { label: 'Piramisok rezgése és természetes frekvenciája', seeds: ['Great Pyramid vibration', 'pyramid resonance study', 'Great Pyramid natural frequency', 'pyramid earthquake resistance'] },
      { label: 'Új régészeti felfedezések a piramisokról', seeds: ['pyramid new discovery', 'Great Pyramid new research', 'Giza pyramid hidden chamber'] },
      { label: 'Piramisok építésének rejtélyei', seeds: ['how pyramids were built new theory', 'pyramid construction mystery explained', 'ancient Egyptian engineering'] },
      { label: 'Piramisok és tudomány', seeds: ['pyramid science explained', 'Great Pyramid geometry mathematics', 'pyramid cosmic alignment research'] },
      { label: 'Piramisok a világban', seeds: ['pyramids around the world', 'pyramid discovered outside Egypt', 'oldest pyramid in the world'] },
    ],
    auto: [
      { label: 'Új autó modellek és tesztek', seeds: ['new car model review 2026', 'car comparison test', 'best new cars'] },
      { label: 'Elektromos autók és technológia', seeds: ['electric car news', 'EV technology breakthrough', 'Tesla vs competitors'] },
      { label: 'Autóipar és piaci trendek', seeds: ['car industry news', 'auto market trends', 'car sales data'] },
      { label: 'Autó tuning és módosítások', seeds: ['car tuning build', 'car modification project', 'custom car build'] },
      { label: 'Használt autó tippek', seeds: ['used car buying tips', 'car reliability ranking', 'best used cars value'] },
    ],
    sport: [
      { label: 'Foci és labdarúgás', seeds: ['football transfer news', 'Champions League highlights', 'football tactics analysis'] },
      { label: 'Sportolói sztoriik', seeds: ['athlete comeback story', 'sports documentary', 'greatest sports moments'] },
      { label: 'Edzéstervek és fitnesz', seeds: ['workout routine results', 'fitness transformation', 'training plan explained'] },
      { label: 'Extrém sportok', seeds: ['extreme sports compilation', 'adventure sports challenge', 'dangerous sports explained'] },
    ],
    gaming: [
      { label: 'Új játék megjelenések', seeds: ['new game release review', 'upcoming games 2026', 'game trailer reaction'] },
      { label: 'Gaming hardver', seeds: ['gaming PC build', 'best gaming setup', 'GPU comparison benchmark'] },
      { label: 'Esport és verseny', seeds: ['esports tournament highlights', 'pro gamer analysis', 'competitive gaming strategy'] },
      { label: 'Indie játékok', seeds: ['best indie games', 'indie game hidden gems', 'indie game review'] },
    ],
    film: [
      { label: 'Új filmek és kritikák', seeds: ['new movie review', 'film analysis explained', 'movie breakdown'] },
      { label: 'Sorozat ajánlók', seeds: ['best new series', 'TV show review', 'series ranking'] },
      { label: 'Film elméletek és Easter egg-ek', seeds: ['movie theory explained', 'film easter eggs', 'hidden details in movies'] },
      { label: 'Klasszikus filmek újragondolva', seeds: ['classic movie retrospective', 'movie that aged well', 'underrated films'] },
    ],
    horror: [
      { label: 'Horror filmek és sorozatok', seeds: ['best horror movies', 'horror movie review', 'scariest movies ranked'] },
      { label: 'Valós horror történetek', seeds: ['true scary stories', 'real horror cases explained', 'creepy true events'] },
      { label: 'Rejtélyek és paranormális', seeds: ['unsolved mysteries explained', 'paranormal investigation', 'unexplained events'] },
      { label: 'Horror játékok', seeds: ['horror game playthrough', 'scariest video games', 'horror game review'] },
    ],
    penz: [
      { label: 'Befektetési stratégiák', seeds: ['investing strategy explained', 'stock market analysis', 'portfolio building tips'] },
      { label: 'Crypto és blockchain', seeds: ['cryptocurrency news today', 'Bitcoin analysis', 'crypto market update'] },
      { label: 'Pénzügyi szabadság tippek', seeds: ['financial freedom tips', 'passive income ideas', 'money saving strategies'] },
      { label: 'Gazdasági hírek', seeds: ['economy news explained', 'market crash analysis', 'inflation explained'] },
    ],
    tech: [
      { label: 'AI és mesterséges intelligencia', seeds: ['AI news breakthrough', 'artificial intelligence explained', 'new AI tool review'] },
      { label: 'Gadget tesztek', seeds: ['tech review gadget', 'best tech products', 'smartphone comparison'] },
      { label: 'Programozás és fejlesztés', seeds: ['coding tutorial project', 'programming language comparison', 'developer tools review'] },
      { label: 'Tech ipar és cégek', seeds: ['big tech news', 'tech company strategy', 'startup success story'] },
    ],
    egeszseg: [
      { label: 'Táplálkozás és diéta', seeds: ['nutrition science explained', 'healthy diet research', 'food myths debunked'] },
      { label: 'Edzéstervek', seeds: ['workout routine for beginners', 'exercise science explained', 'fitness tips research'] },
      { label: 'Mentális egészség', seeds: ['mental health tips research', 'anxiety management science', 'sleep science explained'] },
      { label: 'Orvosi felfedezések', seeds: ['medical breakthrough discovery', 'health research news', 'new treatment explained'] },
    ],
    tortenel: [
      { label: 'Furcsa történelmi események', seeds: ['strange history events explained', 'bizarre historical facts', 'weird history stories'] },
      { label: 'Háborúk és csaták', seeds: ['famous battle explained', 'war documentary history', 'military strategy analysis'] },
      { label: 'Ókori civilizációk', seeds: ['ancient civilization discovery', 'archaeology new discovery', 'lost civilization explained'] },
      { label: 'Modern történelem', seeds: ['cold war secrets revealed', '20th century history explained', 'historical turning points'] },
    ],
    zene: [
      { label: 'Új zenei kiadások', seeds: ['new album review', 'music review analysis', 'song breakdown explained'] },
      { label: 'Zenei elméletek', seeds: ['music theory explained', 'song structure analysis', 'why this song works'] },
      { label: 'Zeneipar és trendek', seeds: ['music industry news', 'music streaming data', 'viral music trends'] },
      { label: 'Hangszer és produkció', seeds: ['music production tutorial', 'instrument comparison', 'home studio setup'] },
    ],
    utaz: [
      { label: 'Úti célok és tippek', seeds: ['travel destination guide', 'best places to visit', 'travel tips budget'] },
      { label: 'Kalandtúrák', seeds: ['adventure travel vlog', 'extreme travel challenge', 'remote places explored'] },
      { label: 'Kulturális felfedezések', seeds: ['cultural experience travel', 'local food travel', 'hidden gems destination'] },
    ],
    foz: [
      { label: 'Receptek és technikák', seeds: ['cooking technique explained', 'recipe tutorial easy', 'chef tips secrets'] },
      { label: 'Éttermi trendek', seeds: ['restaurant review food', 'food trend explained', 'viral food recipe'] },
      { label: 'Egészséges konyha', seeds: ['healthy recipe easy', 'meal prep guide', 'nutrition cooking tips'] },
    ],
  }

  let matchKey = ''
  for (const key of Object.keys(subtopicMap)) {
    if (n.includes(key)) { matchKey = key; break }
  }

  if (!matchKey) {
    const expansion = expandTopicQueries(niche, searchRegion, { maxQueries: 12 })
    const grouped = [
      { label: `${niche} — friss fejlemények`, types: ['current'] },
      { label: `${niche} — tudományos magyarázat`, types: ['scientific', 'global_adaptable'] },
      { label: `${niche} — történet és rejtély`, types: ['storytelling'] },
      { label: `${niche} — creator feldolgozások`, types: ['youtube_creator', 'hungarian_market'] },
    ] as Array<{ label: string; types: string[] }>

    return grouped.map(group => {
      const seeds = expansion.queries
        .filter(q => group.types.includes(q.expansion_type))
        .map(q => q.query)
        .slice(0, 4)

      return {
        label: group.label,
        category: expansion.category || category,
        freshnessWindowDays: Math.max(freshnessWindowDays, 180),
        searchRegion,
        seeds: seeds.length > 0 ? seeds : expansion.queries.map(q => q.query).slice(0, 3),
      }
    }).filter(pack => pack.seeds.length > 0).slice(0, 5)
  }

  return subtopicMap[matchKey].map(sub => ({
    label: sub.label,
    category,
    freshnessWindowDays,
    searchRegion,
    seeds: sub.seeds,
  })).slice(0, 5)
}
