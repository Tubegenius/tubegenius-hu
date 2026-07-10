// lib/fact-safety.ts
// WillViral — MVP Fact Safety Layer
// Content classification, Verified Fact Block, intensity downgrade

import { tokenize } from './niche-relevance'

// ── Típusok ──────────────────────────────────────────────────

export type ContentType =
  | 'factual_sensitive'    // konkrét személy, botrány, vád, politikai konfliktus, egészség, jog, pénzügy, bűnügy, családi kapcsolat, tisztség, idézet
  | 'factual_news'         // általános hír, aktuális esemény, gazdasági/technológiai/tudományos/politikai fejlemény
  | 'factual_general'      // tudomány, technológia, történelem, pszichológia (evergreen, nem hír jellegű)
  | 'entertainment_trend'  // challenge, meme, viral, creator formátum
  | 'opinion_commentary'   // vélemény, elemzés, reakció
  | 'creative_fiction'     // kitalált történet, kreatív tartalom

// Két szigorúsági szint a strict_fact_mode-on belül
export type FactStrictnessLevel = 'standard_news' | 'high_risk' | null

export type QualityStatus =
  | 'verified'
  | 'verified_with_limits'
  | 'insufficient_sources'
  | 'fact_check_failed'
  | 'entertainment_validated'

export type ClaimType = 'fact' | 'attributed_claim' | 'inference' | 'opinion' | 'rhetorical_question'

export interface VerifiedFact {
  fact_id: string
  claim: string
  source: string
  support_level: 'direct' | 'strong_inference' | 'limited'
  allowed_in_narration: boolean
  sensitivity: 'normal' | 'sensitive' | 'high_risk'
}

export interface VerifiedEntity {
  name: string
  type: 'person' | 'organization' | 'place' | 'event'
  verified_role?: string
  verified_relationships?: string[]
}

export interface VerifiedFactBlock {
  topic: string
  content_type: ContentType
  strict_fact_mode: boolean
  fact_strictness_level: FactStrictnessLevel
  verified_facts: VerifiedFact[]
  allowed_inferences: string[]
  forbidden_claims: string[]
  verified_entities: VerifiedEntity[]
  known_unknowns: string[]
  sources_used: string[]
  source_count: number
  minimum_sources_met: boolean
}

// ── Content type klasszifikáció ───────────────────────────────

const FACTUAL_SENSITIVE_KEYWORDS = [
  // Politika / közélet
  'politika', 'politik', 'parlament', 'government', 'kormány', 'választás', 'election',
  'képviselő', 'miniszter', 'minister', 'orbán', 'fidesz', 'ellenzék', 'opposition',
  'párt', 'party', 'törvény', 'law', 'rendelet', 'decree',
  // Közszereplők
  'botrány', 'scandal', 'korrupció', 'corruption', 'vád', 'accused', 'letartóz',
  'perelt', 'lawsuit', 'vizsgálat', 'investigation',
  // Egészség
  'gyógyszer', 'medicine', 'drug', 'kezelés', 'treatment', 'betegség', 'disease',
  'diagnózis', 'diagnosis', 'rák', 'cancer', 'kórház', 'hospital', 'orvos', 'doctor',
  // Pénzügy
  'befektetés', 'investment', 'részvény', 'stock', 'crypto', 'bitcoin', 'tőzsde',
  'hitel', 'loan', 'adó', 'tax', 'bankcsőd', 'bankruptcy',
  // Bűnügy / tragédia
  'gyilkosság', 'murder', 'halál', 'death', 'baleset', 'accident', 'katasztrófa',
  'disaster', 'terrorizmus', 'terrorism', 'bűnügy', 'crime', 'ítélet', 'verdict',
  // Személyes / kapcsolati
  'házasság', 'marriage', 'válás', 'divorce', 'gyerek', 'child', 'fia', 'lánya',
  'rokon', 'relative', 'fivér', 'nővér', 'szülő', 'parent',
  // Háború / konfliktus
  'háború', 'war', 'konfliktus', 'conflict', 'katonai', 'military', 'bombázás', 'attack',
]

const ENTERTAINMENT_KEYWORDS = [
  'challenge', 'meme', 'trend', 'viral', 'reaction', 'reakció', 'prank', 'vicc',
  'funny', 'vicces', 'gaming', 'játék', 'cosplay', 'dance', 'tánc', 'lip sync',
  'duet', 'filter', 'transition', 'unboxing', 'review', 'haul', 'vlog',
  'mukbang', 'asmr', 'storytime', 'q&a', 'tag', 'transformation',
]

const FACTUAL_GENERAL_KEYWORDS = [
  'tudomány', 'science', 'kutatás', 'research', 'felfedezés', 'discovery',
  'technológia', 'technology', 'ai', 'mesterséges intelligencia', 'robot',
  'történelem', 'history', 'régészet', 'archaeology', 'pszichológia', 'psychology',
  'természet', 'nature', 'álat', 'animal', 'növény', 'plant', 'éghajlat', 'climate',
  'fizika', 'physics', 'kémia', 'chemistry', 'biológia', 'biology', 'matematika',
  'csillagászat', 'astronomy', 'ûr', 'space', 'nasa', 'james webb',
]

// Általános hír / aktuális esemény / gazdasági-technológiai-tudományos-politikai
// fejlemény jelzőszavai — ezek strict_fact_mode-ot triggerelnek, de csak
// "standard_news" szinten (nem olyan szigorú mint a factual_sensitive/high_risk).
const FACTUAL_NEWS_KEYWORDS = [
  // Általános hír jelzők
  'hír', 'hírek', 'news', 'bejelent', 'announce', 'közlemény', 'statement',
  'sajtótájékoztató', 'press conference', 'fejlemény', 'development',
  'legfrissebb', 'latest', 'derült ki', 'revealed', 'kiderült',
  'jelentés szerint', 'according to report', 'ma történt', 'e héten', 'this week',
  // Gazdasági fejlemény
  'gazdaság', 'economy', 'gazdasági', 'economic', 'infláció', 'inflation',
  'gdp', 'jegybank', 'central bank', 'mnb', 'költségvetés', 'budget',
  'tőzsde', 'stock market', 'árfolyam', 'exchange rate', 'recesszió', 'recession',
  // Politikai fejlemény (nem konkrét személyhez/konfliktushoz kötött)
  'törvényjavaslat', 'bill', 'szavazás', 'vote', 'csúcstalálkozó', 'summit',
  'megállapodás', 'agreement', 'szankció', 'sanction', 'eu döntés', 'eu decision',
  // Technológiai / tudományos fejlemény
  'bejelentette', 'bemutatta', 'piacra dobta', 'launch', 'új verzió', 'update',
  'tudományos áttörés', 'scientific breakthrough', 'kutatók szerint', 'researchers',
  'új tanulmány', 'new study', 'tanulmány szerint', 'felfedezték', 'discovered',
]

export function classifyContentType(topic: string): ContentType {
  const lower = topic.toLowerCase()

  // Entertainment elsőbbsége — ha egyértelmű trend/challenge
  const entertainmentMatches = ENTERTAINMENT_KEYWORDS.filter(k => lower.includes(k))
  if (entertainmentMatches.length >= 2) return 'entertainment_trend'

  // Factual sensitive (high_risk) ellenőrzés — konkrét személy/botrány/vád/
  // egészség/jog/pénzügy/bűnügy/családi kapcsolat/tisztség/idézet
  const sensitiveMatches = FACTUAL_SENSITIVE_KEYWORDS.filter(k => lower.includes(k))
  if (sensitiveMatches.length >= 1) return 'factual_sensitive'

  // Factual news (standard_news) — általános hír/esemény/gazdasági-tech-tudományos-
  // politikai fejlemény, de nem konkrét személyhez kötött
  const newsMatches = FACTUAL_NEWS_KEYWORDS.filter(k => lower.includes(k))
  if (newsMatches.length >= 1) return 'factual_news'

  // Factual general — evergreen oktató jellegű tartalom, nem hír
  const generalMatches = FACTUAL_GENERAL_KEYWORDS.filter(k => lower.includes(k))
  if (generalMatches.length >= 1) return 'factual_general'

  // Entertainment single match
  if (entertainmentMatches.length >= 1) return 'entertainment_trend'

  // Default: factual_general (biztonságosabb mint entertainment)
  return 'factual_general'
}

export function isStrictFactMode(contentType: ContentType): boolean {
  return contentType === 'factual_sensitive' || contentType === 'factual_news'
}

export function getFactStrictnessLevel(contentType: ContentType): FactStrictnessLevel {
  if (contentType === 'factual_sensitive') return 'high_risk'
  if (contentType === 'factual_news') return 'standard_news'
  return null
}

// ── Intenzitás downgrade ──────────────────────────────────────

export function applyIntensityDowngrade(
  intensity: string,
  contentType: ContentType,
  strictFactMode: boolean,
): { final_intensity: string; was_downgraded: boolean; reason?: string } {
  if (intensity !== 'extreme') return { final_intensity: intensity, was_downgraded: false }

  const blockedForExtreme: ContentType[] = [
    'factual_sensitive',
    'factual_news',
    'factual_general',
    'opinion_commentary',
  ]

  if (blockedForExtreme.includes(contentType) || strictFactMode) {
    return {
      final_intensity: 'classic',
      was_downgraded: true,
      reason: `Extreme intenzitás nem engedélyezett ${contentType} típusú tartalomhoz. Automatikusan classic-ra állítva.`,
    }
  }

  return { final_intensity: intensity, was_downgraded: false }
}

// ── Verified Fact Block builder ───────────────────────────────

interface SourceItem {
  title: string
  url?: string
  snippet?: string
  source?: string
}

// Egy forrás (pl. egy laza Wikipedia-találat) csak akkor számíthat "ellenőrzött
// ténynek", ha ténylegesen a megadott témáról szól — enélkül pl. egy teljesen
// más témájú (pl. egy futballista életrajza) is bekerülhetne verified_facts-ba,
// mert a cím/leírás hossza megfelelt, a tartalma viszont irreleváns volt.
// A user-megadott forrásokat (userSources, pl. a Script Extractor forrásvideója)
// nem szűrjük — azokat a user explicit adta meg ehhez a témához.
export function isFactRelevantToTopic(topic: string, source: SourceItem): boolean {
  const topicTokens = tokenize(topic)
  if (topicTokens.length === 0) return true // nincs mihez viszonyitani, ne blokkoljunk feleslegesen

  const haystackTokens = new Set(tokenize(`${source.title || ''} ${source.snippet || ''}`))
  if (haystackTokens.size === 0) return false

  return topicTokens.some(t => haystackTokens.has(t))
}

export function buildVerifiedFactBlock(
  topic: string,
  contentType: ContentType,
  strictFactMode: boolean,
  webSources: SourceItem[],
  youtubeSources: SourceItem[],
  userSources: SourceItem[],
): VerifiedFactBlock {
  // A web/YouTube forrasokat relevancia szerint szurjuk — a user altal explicit
  // megadott forrasokat (pl. sajat forrasvideo) nem, azokat a user tudatosan
  // adta ehhez a temahoz.
  const relevantWebSources = webSources.filter(s => isFactRelevantToTopic(topic, s))
  const relevantYoutubeSources = youtubeSources.filter(s => isFactRelevantToTopic(topic, s))
  const allSources = [...relevantWebSources, ...relevantYoutubeSources, ...userSources]
  const sourceCount = allSources.length

  const factStrictnessLevel = getFactStrictnessLevel(contentType)

  // Minimum forrás követelmény — high_risk témánál több forrás kell,
  // mint egy standard_news témánál
  const minimumRequired = factStrictnessLevel === 'high_risk' ? 3 : factStrictnessLevel === 'standard_news' ? 2 : 1
  const minimumSourcesMet = sourceCount >= minimumRequired

  // Verified facts kinyerése a Serper snippetekből
  const verifiedFacts: VerifiedFact[] = []
  const sourcesUsed: string[] = []

  allSources.forEach((source, idx) => {
    if (!source.snippet && !source.title) return
    sourcesUsed.push(source.url || source.title || `source_${idx}`)

    // Csak közvetlen, konkrét állítások mehetnek verified_facts-ba
    if (source.snippet && source.snippet.length > 20) {
      verifiedFacts.push({
        fact_id: `fact_${idx}`,
        claim: source.snippet.slice(0, 200),
        source: source.source || source.url || source.title || 'unknown',
        support_level: 'direct',
        allowed_in_narration: true,
        sensitivity: strictFactMode ? 'sensitive' : 'normal',
      })
    }
  })

  // Forbidden claims — szint szerint differenciálva
  const forbiddenClaims: string[] = []

  if (factStrictnessLevel === 'standard_news' || factStrictnessLevel === 'high_risk') {
    // Alap tiltások minden strict módnál (standard_news és high_risk is)
    forbiddenClaims.push(
      'Új tény kitalálása forrás nélkül',
      'Időpont kitalálása',
      'Szereplő kitalálása',
      'Globális hír magyar eseménnyé alakítása',
      'Bizonytalan állítás biztos tényként kezelése',
      'Forrás nélküli következtetés',
    )
  }

  if (factStrictnessLevel === 'high_risk') {
    // Szigorúbb, személyhez/botrányhoz kötött tiltások — csak high_risk témánál
    forbiddenClaims.push(
      'Azonos vezetéknévből rokoni kapcsolatra következtetés',
      'Nem igazolt tisztség vagy beosztás állítása',
      'Nem igazolt idézet vagy nyilatkozat',
      'Nem igazolt reakció, érzelem vagy testbeszéd',
      'Nem igazolt motiváció vagy szándék forrás nélkül',
      'Nem igazolt politikai kapcsolat vagy szövetség',
      'Nem igazolt pártviszony vagy lojalitás',
      'Nem igazolt személyes konfliktus',
      'Nem igazolt esemény rekonstrukciója vagy részletei',
      'Előzetes eredmény bizonyított áttörésként való bemutatása',
      'Ellenőrizetlen személyazonosság állítása',
    )
  }

  // Known unknowns — amit nem tudunk de fontosak lennének
  const knownUnknowns: string[] = []
  if (sourceCount < minimumRequired) {
    knownUnknowns.push('Nincs elegendő ellenőrzött forrás a témához')
  }
  if (strictFactMode && youtubeSources.length === 0) {
    knownUnknowns.push('Nincs YouTube evidence a témához')
  }

  return {
    topic,
    content_type: contentType,
    strict_fact_mode: strictFactMode,
    fact_strictness_level: factStrictnessLevel,
    verified_facts: verifiedFacts,
    allowed_inferences: [
      'Ez arra utalhat, hogy...',
      'A rendelkezésre álló adatok alapján...',
      'Ebből az következhet, hogy...',
      'Lehetséges, hogy...',
    ],
    forbidden_claims: forbiddenClaims,
    verified_entities: [],
    known_unknowns: knownUnknowns,
    sources_used: sourcesUsed,
    source_count: sourceCount,
    minimum_sources_met: minimumSourcesMet,
  }
}

// ── Sonnet prompt szabályok generálása ───────────────────────

export function buildFactSafetyPromptRules(
  factBlock: VerifiedFactBlock,
  intensityFinal: string,
): string {
  const rules: string[] = []

  rules.push('=== TENYBIZTONSAGI SZABALYOK - KOTELEZO BETARTANI ===')
  rules.push('')
  rules.push(`Tartalom tipusa: ${factBlock.content_type}`)
  rules.push(`Strict fact mode: ${factBlock.strict_fact_mode ? 'AKTIV' : 'inaktiv'}`)
  rules.push(`Szigorusagi szint: ${factBlock.fact_strictness_level || 'nincs'}`)
  rules.push(`Intenzitas: ${intensityFinal}`)
  rules.push(`Rendelkezesre allo forrasok: ${factBlock.source_count} db`)
  rules.push('')

  if (factBlock.fact_strictness_level === 'standard_news') {
    rules.push('STANDARD NEWS SZABALYOK (altalanos hir/esemeny/fejlemeny):')
    rules.push('- CSAK a verified_facts listaban szereplo allitasokat hasznald konkret tenyként.')
    rules.push('- Ne talalj ki uj tenyt, amit a forrasok nem tamasztanak ala.')
    rules.push('- Ne talalj ki idopontot vagy datumot.')
    rules.push('- Ne talalj ki szereplot vagy erintett felet.')
    rules.push('- Globalis/nemzetkozi hirt ne alakits at magyar esemennyé.')
    rules.push('- Bizonytalan vagy elozetes allitast ne kezelj biztos tenyként.')
    rules.push('- Forras nelkuli kovetkeztetest ne hasznalj tenyként.')
    rules.push('- Ha nincs eleg teny, valassz gyengebb de igaz hookot.')
    rules.push('')
  }

  if (factBlock.fact_strictness_level === 'high_risk') {
    rules.push('HIGH RISK SZABALYOK (konkret szemely/botrany/vad/politikai konfliktus/egeszseg/jog/penzugy/bunugy/csaladi kapcsolat/tisztseg/idezet):')
    rules.push('- CSAK a verified_facts listaban szereplo allitasokat hasznald konkret tenyként.')
    rules.push('- Erzekeny allitashoz tobb (legalabb 2-3) fuggetlen forras szukseges — ha nincs, jelold bizonytalannak.')
    rules.push('- Szemelyazonossagot csak akkor allits biztosra, ha a forrasok egyertelmuen igazoljak.')
    rules.push('- Tisztseget vagy beosztast csak igazolt forras alapjan allits.')
    rules.push('- Rokoni kapcsolatra ne kovetkeztess azonos vezeteknévbol vagy feltetelezesbol.')
    rules.push('- Idezetet vagy nyilatkozatot csak akkor hasznalj, ha az szo szerint szerepel egy forrasban.')
    rules.push('- Esemenyreszleteket (helyszin, sorrend, korulmenyek) csak igazolt forras alapjan allits, ne rekonstrualj.')
    rules.push('- Motivaciot vagy szandekot ne allits forras nelkul.')
    rules.push('- Ne dramatizalj nem dokumentalt jelenetet.')
    rules.push('- Ne nevezd biztosnak azt, ami csak lehetoseg vagy gyanu.')
    rules.push('- Ha nincs eleg teny, valassz gyengebb de igaz hookot.')
    rules.push('')
  }

  if (factBlock.forbidden_claims.length > 0) {
    rules.push('TILTOTT ALLITASOK (ezeket SOHA ne hasznald):')
    factBlock.forbidden_claims.forEach(fc => rules.push(`- ${fc}`))
    rules.push('')
  }

  if (factBlock.verified_facts.length > 0) {
    rules.push('HASZNALHATO ELLENORZOTT TENYEK:')
    factBlock.verified_facts.slice(0, 5).forEach(vf => {
      rules.push(`- [${vf.fact_id}] ${vf.claim.slice(0, 150)}`)
    })
    rules.push('')
  }

  rules.push('MEGENGEDETT KOVETKEZTETESI FORMULAK (INFERENCE):')
  factBlock.allowed_inferences.forEach(ai => rules.push(`- "${ai}"`))
  rules.push('')

  rules.push('CLAIM TIPUSOK - minden allitas tartozzon az egyikbe:')
  rules.push('- FACT: kozvetlenul igazolt teny forrásbol')
  rules.push('- ATTRIBUTED_CLAIM: valaki allitasa ("X szerint...")')
  rules.push('- INFERENCE: ovatos kovetkeztetes ("Ez arra utalhat...")')
  rules.push('- OPINION: creator velemenye (csak ha kerik)')
  rules.push('- RHETORICAL_QUESTION: kerdes hamis elofelteves nelkul')
  rules.push('')

  if (!factBlock.minimum_sources_met) {
    rules.push('FIGYELEM: Kevés forrás áll rendelkezésre.')
    rules.push('Rövidebb, óvatosabb narrációt készíts.')
    rules.push('Ne töltsd fel kitalált részletekkel.')
  }

  rules.push('=== TENYBIZTONSAGI SZABALYOK VEGE ===')

  return rules.join('\n')
}

// ── Quality status meghatározás ───────────────────────────────

export function determineQualityStatus(
  factBlock: VerifiedFactBlock,
  contentType: ContentType,
): QualityStatus {
  if (contentType === 'entertainment_trend') return 'entertainment_validated'

  if (!factBlock.minimum_sources_met) return 'insufficient_sources'

  if (factBlock.source_count >= 3 && factBlock.verified_facts.length >= 2) return 'verified'

  if (factBlock.source_count >= 1) return 'verified_with_limits'

  return 'insufficient_sources'
}
