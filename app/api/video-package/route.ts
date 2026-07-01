import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { MODELS } from '@/lib/models'
import { getUserId, hasEnoughCredits, chargeFeature, logUsage, CREDIT_COSTS } from '@/lib/credits'
import {
  classifyContentType,
  isStrictFactMode,
  getFactStrictnessLevel,
  applyIntensityDowngrade,
  buildVerifiedFactBlock,
  buildFactSafetyPromptRules,
  determineQualityStatus,
  type VerifiedFactBlock,
  type QualityStatus,
} from '@/lib/fact-safety'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

function extractJson(text: string): unknown {
  let cleaned = text.replace(/```json|```/g, '').trim()
  const firstBrace = cleaned.indexOf('{')
  const lastBrace = cleaned.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1)
  }
  cleaned = cleaned.replace(/"([^"\\]*(\\.[^"\\]*)*)"/g, (match) => {
    return match.replace(/\n/g, ' ').replace(/\r/g, '')
  })
  try {
    return JSON.parse(cleaned)
  } catch (e) {
    console.error('JSON parse failed:', cleaned.slice(0, 1500))
    throw e
  }
}

const STYLE_PROMPTS: Record<string, string> = {
  mrbeast: 'MrBeast stilus: eros hook, gyors tempo, nagy tet, kozvetlen. Hiteles, nem gyerekes.',
  bright_side: 'Bright Side: pozitiv, informativ, listicle-alapu. Baratsagos, nyugodt hang.',
  dylan_page: 'Dylan Page: laza, pletykas, kozvetlen. Casual magyar szleng.',
  dokumentarista: 'Dokumentarista: mely, reszletes, hiteles. Semleges, tenyszeru.',
  tenyfeltaro: 'Tenyfeltaro: investigativ, dramai, leleplező. Feszultsegepito.',
  tudomanyos: 'Tudomanyos: pontos, adatalapú, kozerthetó. Logikus felepites.',
  storytelling: 'Storytelling: narrativ, erzelmes, filmszeru. Karakterkozpontu iv.',
  mrballen: 'MrBallen: misztikus, feszultsegepito, noir. Lassu felepites.',
  magyar_tiktok: 'Magyar TikTok: nagyon rovid mondatok, utos. Vibralo energia.',
  sajat: 'A megadott egyeni prompt szerint - termeszetes, autentikus.',
}

const INTENSITY_GUIDE: Record<string, string> = {
  light: 'Visszafogott, termeszetes. Semmi tulzas. Hiteles es szakmai.',
  classic: 'Kiegyensulyozott. Eros de hiteles.',
  extreme: 'Maximum energia. Csak konnyed temaknál.',
}

const GOAL_GUIDE: Record<string, string> = {
  views: 'Kattintas es nezettség. Curiosity gap kotelez.',
  comments: 'Komment. Tegyel fel kerdest a vegen.',
  shares: 'Megosztás. Wow faktor.',
  saves: 'Mentes. Ertekes, visszanézhetó info.',
  subscribers: 'Feliratkozas. CTA: ha erdekel a folytatás...',
  affiliate: 'Affiliate kattintas. Termeszetes integracio.',
}

function getShortsTarget(length: string) {
  if (length === '30sec') return { words: '65-85', chars: '450-650', seconds: 30 }
  if (length === '45sec') return { words: '95-125', chars: '700-950', seconds: 45 }
  return { words: '130-165', chars: '950-1300', seconds: 60 }
}

function getLongTarget(length: string) {
  if (length === '3-5min') return { words: '450-750', scenes: '6-9', minutes: '3-5' }
  return { words: '900-1500', scenes: '10-16', minutes: '6-10' }
}

function getUploadTimes(platform: string) {
  if (platform === 'tiktok') return { primary: '19:00-21:00', secondary: '11:00-13:00', reason: 'Altalanos ajanlasok. Sajat analytics alapjan pontosithato.' }
  const isShorts = ['youtube_shorts', 'instagram_reels', 'facebook_reels'].includes(platform)
  if (isShorts) return { primary: '18:00-21:00', secondary: '11:30-13:00', reason: 'Altalanos ajanlasok. Sajat analytics alapjan pontosithato.' }
  return { primary: '18:00-21:00', secondary: '16:00-18:00', reason: 'Altalanos ajanlasok. Pontosabb idoziteshez sajat csatorna teljesitmenyadat szukseges.' }
}

function getHashtagGuide(platform: string) {
  if (platform === 'youtube_shorts') return '3-5 hashtag. #Shorts kotelezo. Niche alapu, magyar kozonseg.'
  if (platform === 'tiktok') return '4-8 hashtag. Discovery + niche mix. Ne spam.'
  if (platform === 'instagram_reels') return '5-10 hashtag. Tema + niche + erdeklodesi kor.'
  return '3-5 SEO hashtag. Kulcsszo alapu.'
}

const NARRATION_QUALITY_RULES = `
NARRACIOS MINOSEGI SZABALYOK - KOTELEZO:
1. EMBERI SZOVEG: Tapasztalt magyar tartalomgyarto hangja. Termeszetes, gordulekeny, felolvasható.
2. NEM ADATLISTA: Narrativ iv: hook, felvezetes, fo gondolat, felismeres, CTA.
3. EGY FO GONDOLAT: Shorts-nal egyetlen fo gondolatot magyarazz el erosen.
4. CURIOSITY GAP: Az elejen nyiss egy kerdest, csak a vegen zard le.
5. TET: A nezo ertse, miert szamit neki.
6. PREMIUM ERZET: Ne legyen gagyi clickbait.
7. STILUS CSAK A NYELVEZETET MODOSITHATJA - A TENYEKET NEM.`

const JSON_RULES = `
KRITIKUS JSON SZABALYOK - KOTELEZO:
- SOHA ne hasznalj idezojelet a JSON string ertekek BELSEJEBEN
- A "narration" mezo EGYETLEN soros string legyen - SOHA ne hasznalj sortorést benne
- Minden string ertek egy soros legyen, sortorest nelkul
- Csak pure JSON-t adj vissza, semmi mas szoveget`

const SOURCE_VIDEO_REWRITE_RULES = `
SOURCE VIDEO SAJAT VERZIO MOD - KOTELEZO:
- A forrasvideo transcriptje ellenorzott primer forrasnak szamit.
- A narracio legyen sajat, eredeti magyar verzio, ne masold szo szerint a forrasvideo mondatait.
- A tenyeket, sorrendet es kulcspontokat a source video fact block alapjan hasznald.
- Ne adj hozza uj konkret tenyt, nevet, szamot vagy vadat, ami nincs a source video fact blockban.
- Ha a transcript csak reszleges, jelolj ovatos kovetkeztetest es ne toltsd ki kitalalt reszletekkel.`

async function generateCreativeCore(params: {
  topic: string
  isShorts: boolean
  t: { words: string; chars?: string; seconds?: number; scenes?: string; minutes?: string }
  arc: string
  niche: string
  stylePrompt: string
  intensity: string
  goal: string
  factSection: string
  factSafetyRules: string
  platform: string
  videoLength: string
  narrationStyle: string
  contentType: string
  strictFactMode: boolean
  sourceVideoMode: boolean
}) {
  const { topic, isShorts, t, arc, niche, stylePrompt, intensity, goal, factSection, factSafetyRules, contentType, strictFactMode, sourceVideoMode } = params

  const prompt = isShorts
    ? `Te egy profi magyar YouTube videocsomag-keszito vagy.

TEMA: "${topic}"
NICHE: ${niche || 'altalanos'}
PLATFORM: SHORTS
VIDEOHOSSZ: ${t.seconds} masodperc
STILUS: ${stylePrompt}
INTENZITAS: ${intensity} - ${INTENSITY_GUIDE[intensity]}
CEL: ${GOAL_GUIDE[goal]}
TARTALOM TIPUSA: ${contentType}
STRICT FACT MODE: ${strictFactMode ? 'AKTIV - kulonos gondossag szukseges' : 'inaktiv'}

KOTELEZO NARRACIOHOSSZ: ${t.words} szo / ${t.chars} karakter
NARRACIOS IV: ${arc}
${factSection}

${factSafetyRules}
${sourceVideoMode ? SOURCE_VIDEO_REWRITE_RULES : ''}

${NARRATION_QUALITY_RULES}
${JSON_RULES}

Valaszolj KIZAROLAG valid JSON-ban:
{
  "hook": "Eros 0-3mp hook - curiosity gap - EGY SOROS",
  "narration": "Teljes narracio PONTOSAN ${t.words} szo - EGYETLEN SOROS STRING - NE HASZNALJ SORTORЕСТ",
  "scene_structure": [
    {"number": 1, "title": "Hook", "duration": "0:00-0:03", "visual": "Vizual leiras EGY SOROS", "narration": "Hook szoveg EGY SOROS"},
    {"number": 2, "title": "Felvezetes", "duration": "0:03-0:12", "visual": "Vizual leiras", "narration": "Narracio"},
    {"number": 3, "title": "Fo gondolat", "duration": "0:12-0:35", "visual": "Vizual leiras", "narration": "Narracio"},
    {"number": 4, "title": "Felismeres", "duration": "0:35-0:42", "visual": "Vizual leiras", "narration": "Narracio"},
    {"number": 5, "title": "CTA", "duration": "0:42-0:45", "visual": "Vizual leiras", "narration": "CTA"}
  ],
  "broll_ideas": ["B-roll 1", "B-roll 2", "B-roll 3"],
  "cta": "Temahoz kapcsolodo CTA - EGY SOROS",
  "sources_used": [{"title": "Forras neve", "url": "https://..."}],
  "claims_used": [{"claim_text": "allitas szovege", "claim_type": "fact"}]
}`
    : `Te egy profi magyar YouTube videocsomag-keszito vagy.

TEMA: "${topic}"
NICHE: ${niche || 'altalanos'}
PLATFORM: YouTube Long
VIDEOHOSSZ: ${t.minutes} perc
STILUS: ${stylePrompt}
INTENZITAS: ${intensity} - ${INTENSITY_GUIDE[intensity]}
CEL: ${GOAL_GUIDE[goal]}
TARTALOM TIPUSA: ${contentType}
STRICT FACT MODE: ${strictFactMode ? 'AKTIV - kulonos gondossag szukseges' : 'inaktiv'}

KOTELEZO NARRACIOHOSSZ: ${t.words} szo
JELENETEK: ${t.scenes}
SZERKEZET: ${arc}
${factSection}

${factSafetyRules}
${sourceVideoMode ? SOURCE_VIDEO_REWRITE_RULES : ''}

${NARRATION_QUALITY_RULES}
${JSON_RULES}

Valaszolj KIZAROLAG valid JSON-ban:
{
  "hook": "Eros nyitomondatt - EGY SOROS",
  "narration": "Teljes narracio ${t.words} szoban - EGYETLEN SOROS STRING",
  "scene_structure": [
    {"number": 1, "title": "Hook + Intro", "duration": "0:00-0:45", "visual": "Vizual", "narration": "Narracio EGY SOROS"},
    {"number": 2, "title": "Kontextus", "duration": "0:45-1:30", "visual": "Vizual", "narration": "Narracio"},
    {"number": 3, "title": "Fo tartalom", "duration": "1:30-7:00", "visual": "Vizual", "narration": "Narracio"},
    {"number": 4, "title": "Kovetkezmeny", "duration": "7:00-9:00", "visual": "Vizual", "narration": "Narracio"},
    {"number": 5, "title": "Lezaras + CTA", "duration": "9:00-10:00", "visual": "Vizual", "narration": "CTA"}
  ],
  "broll_ideas": ["B-roll 1", "B-roll 2", "B-roll 3", "B-roll 4", "B-roll 5"],
  "timestamps": ["0:00 Intro", "1:00 Tema", "5:00 Osszefoglalas"],
  "cta": "Temahoz kapcsolodo CTA - EGY SOROS",
  "sources_used": [{"title": "Forras neve", "url": "https://..."}],
  "claims_used": [{"claim_text": "allitas szovege", "claim_type": "fact"}]
}`

  const message = await anthropic.messages.create({
    model: MODELS.primary,
    max_tokens: 6000,
    messages: [{ role: 'user', content: prompt }],
  })

  const text = message.content.filter(b => b.type === 'text').map(b => (b as { type: 'text'; text: string }).text).join('')
  const parsed = extractJson(text) as Record<string, unknown>

  return {
    parsed,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  }
}

async function generatePackaging(params: {
  topic: string
  isShorts: boolean
  platform: string
  hook: string
  narration: string
  niche: string
  uploadTimes: { primary: string; secondary: string; reason: string }
  strictFactMode: boolean
  qualityStatus: QualityStatus
}) {
  const { topic, isShorts, platform, hook, narration, niche, strictFactMode, qualityStatus } = params

  const haiku_safety = strictFactMode ? `
HAIKU TENYSZABALYOK - KOTELEZO:
- Ne adj hozza uj tenyt amelyik nincs a narracioban
- A cim ne legyen erosebb allitas mint a narracio
- Ne hasznalj uj szereplot, tisztseget, rokoni kapcsolatot
- Ne hasznalj: LEBUKOTT, HAZUDOTT, TITKOLTAK, BIZONYITOTT - forrás nelkul
- Ha allitas, ne teny - hasznalj kerdjelet` : ''

  const prompt = `Egy magyar ${isShorts ? 'Shorts/TikTok' : 'YouTube'} videohoz kell marketing csomagolas.

TEMA: "${topic}"
NICHE: ${niche || 'altalanos'}
HOOK: ${hook}
NARRACIO RESZLET: ${narration.slice(0, 300)}...
QUALITY STATUS: ${qualityStatus}

HASHTAG SZABALY: ${getHashtagGuide(platform)}

${haiku_safety}

KRITIKUS JSON SZABALYOK:
- SOHA ne hasznalj idezojelet a JSON string ertekek BELSEJEBEN
- Minden string ertek egy soros legyen sortores nelkul
- Csak pure JSON-t adj vissza

Keszitsd el magyarul, KIZAROLAG valid JSON-ban:
{
  "thumbnail_texts": ["${isShorts ? 'OVERLAY' : 'THUMBNAIL'} szoveg 1 max 4 szo nagybetukkel", "szoveg 2", "szoveg 3", "szoveg 4"],
  "title_variations": ["Magyar cim 1", "Cim 2", "Cim 3", "Cim 4", "Cim 5"],
  "caption": "${isShorts ? 'Rovid caption max 300 karakter egy soros' : 'rovid caption'}",
  "description": "${isShorts ? '' : 'SEO-barát YouTube leiras min 150 szo LINK placeholderekkel'}",
  "hashtags": {
    "viral": ["#hashtag1", "#hashtag2"],
    "niche": ["#hashtag3", "#hashtag4"],
    "general": ["#hashtag5"]
  }
}`

  const message = await anthropic.messages.create({
    model: MODELS.fast,
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  })

  const text = message.content.filter(b => b.type === 'text').map(b => (b as { type: 'text'; text: string }).text).join('')
  const parsed = extractJson(text) as Record<string, unknown>

  return {
    parsed,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  }
}

export async function POST(request: NextRequest) {
  try {
    const {
      topic, platform, video_length, narration_style, intensity, goal,
      custom_prompt, niche, language, fact_block, sources,
      web_sources, youtube_sources, source_video, opportunity_context,
    } = await request.json()

    if (!topic) return NextResponse.json({ error: 'Tema megadasa kotelezo' }, { status: 400 })

    if (opportunity_context?.ready_to_produce_status === 'rejected') {
      return NextResponse.json({
        error: 'opportunity_rejected',
        message: 'Ez az Opportunity tema nem ajanlott gyartasra. Valassz masik temat vagy futtass uj validalast.',
      }, { status: 422 })
    }

    const isShorts = ['youtube_shorts', 'tiktok', 'instagram_reels', 'facebook_reels'].includes(platform)
    const feature = isShorts ? 'video_package_shorts' : 'video_package_long'

    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const enoughCredits = await hasEnoughCredits(userId, feature)
    if (!enoughCredits) {
      return NextResponse.json({ error: `Nincs eleg kredited. Ehhez ${CREDIT_COSTS[feature]} kredit szukseges.` }, { status: 402 })
    }

    // ── 1. FACT SAFETY LAYER ──────────────────────────────────

    // Content type classification
    const contentType = classifyContentType(topic)
    const strictFactMode = isStrictFactMode(contentType)
    const factStrictnessLevel = getFactStrictnessLevel(contentType)

    // Intensity downgrade ha szükséges
    const { final_intensity, was_downgraded, reason: downgrade_reason } = applyIntensityDowngrade(
      intensity || 'classic',
      contentType,
      strictFactMode,
    )

    // Forrasgyujtes
    const webSourceItems = web_sources || []
    const youtubeSourceItems = youtube_sources || []
    const sourceVideoMode = !!(source_video?.transcript_available && source_video?.raw_transcript)
    const sourceVideoSnippet = sourceVideoMode
      ? [
          `Source video title: ${source_video.title || topic}`,
          `Source channel: ${source_video.channel || 'unknown'}`,
          `Hook: ${source_video.hook || ''}`,
          `Key points: ${(source_video.key_points || []).join(' | ')}`,
          `Transcript: ${String(source_video.raw_transcript).slice(0, 8000)}`,
        ].join('\n')
      : null
    const userSourceItems = [
      ...(sources || []),
      ...(fact_block ? [{ title: 'User provided facts', snippet: fact_block, source: 'user_fact_block' }] : []),
      ...(sourceVideoSnippet ? [{ title: `Source video transcript: ${source_video.title || topic}`, url: source_video.url, snippet: sourceVideoSnippet, source: 'source_video_transcript' }] : []),
    ]

    // Verified Fact Block epites
    const factBlock = buildVerifiedFactBlock(
      topic,
      contentType,
      strictFactMode,
      webSourceItems,
      youtubeSourceItems,
      userSourceItems,
    )

    if (sourceVideoMode) {
      factBlock.minimum_sources_met = true
      if (!factBlock.sources_used.includes(source_video.url || source_video.title || 'source_video')) {
        factBlock.sources_used.push(source_video.url || source_video.title || 'source_video')
      }
      factBlock.known_unknowns = factBlock.known_unknowns.filter(k => !k.toLowerCase().includes('forr'))
    }

    // Quality status
    const qualityStatus = sourceVideoMode ? 'verified_with_limits' : determineQualityStatus(factBlock, contentType)

    // Blokkolás ha nincs elég forrás factual témánál
    if (qualityStatus === 'insufficient_sources' && strictFactMode) {
      return NextResponse.json({
        error: 'insufficient_sources',
        quality_status: 'insufficient_sources',
        content_type: contentType,
        fact_strictness_level: factStrictnessLevel,
        message: 'A temahoz nincs elegendo ellenorzott informacio egy megbizhato videócsomag elkeszitesehez. Adj meg forrasokat, vagy valassz masik temat.',
      }, { status: 422 })
    }

    // Fact safety prompt szabályok
    const factSafetyRules = buildFactSafetyPromptRules(factBlock, final_intensity)

    // ── 2. GENERÁLÁS ──────────────────────────────────────────

    const stylePrompt = narration_style === 'sajat' && custom_prompt ? custom_prompt : STYLE_PROMPTS[narration_style]
    const uploadTimes = getUploadTimes(platform)

    const opportunitySection = opportunity_context
      ? `\nOPPORTUNITY_CONTEXT:\nStatus: ${opportunity_context.ready_to_produce_label || opportunity_context.ready_to_produce_status || 'unknown'}\nConfidence: ${opportunity_context.confidence || 'unknown'}\nOpportunity score: ${opportunity_context.opportunity_score || 'unknown'}\nRisk flags: ${(opportunity_context.risk_flags || []).join(' | ') || 'none'}\nA csomag csak a VERIFIED_FACT_BLOCK es OPPORTUNITY_CONTEXT altal tamasztott allitasokat hasznalhatja.`
      : ''

    const factSection = (sourceVideoMode && sourceVideoSnippet)
      ? `\nSOURCE_VIDEO_VERIFIED_FACT_BLOCK:\n${sourceVideoSnippet}\nEz a forrasvideo transcriptje es elemzese. Sajat verziot keszits belole, szo szerinti masolas nelkul.${opportunitySection}`
      : fact_block
      ? `\nVERIFIED_FACT_BLOCK:\n${fact_block}\nCsak a fenti verified adatokat hasznald konkret tenyként.${opportunitySection}`
      : `\nVERIFIED_FACT_BLOCK: [NINCS FELHASZNALO ALTAL MEGADOTT ADAT]\nNe talald ki a hianyzo reszleteket.${opportunitySection}`

    let t: { words: string; chars?: string; seconds?: number; scenes?: string; minutes?: string }
    let arc: string

    if (isShorts) {
      t = getShortsTarget(video_length)
      arc = t.seconds === 30
        ? '0-3mp: hook | 3-8mp: felvezetes | 8-20mp: fo gondolat | 20-27mp: felismeres | 27-30mp: CTA'
        : t.seconds === 45
        ? '0-3mp: hook | 3-12mp: felvezetes | 12-30mp: fo magyarazat | 30-40mp: felismeres | 40-45mp: CTA'
        : '0-3mp: hook | 3-15mp: felvezetes | 15-40mp: fo magyarazat | 40-55mp: felismeres | 55-60mp: CTA'
    } else {
      t = getLongTarget(video_length)
      arc = video_length === '3-5min'
        ? '0:00-0:15 Hook | 0:15-0:40 felvezetes | 0:40-2:30 fo magyarazat | 2:30-4:20 kovetkezmeny | 4:20-5:00 lezaras+CTA'
        : '0:00-0:25 hook | 0:25-1:10 kontextus | 1:10-3:30 hatter | 3:30-6:30 melyebb magyarazat | 6:30-8:30 kovetkezmeny | 8:30-10:00 lezaras+CTA'
    }

    const coreResult = await generateCreativeCore({
      topic, isShorts, t, arc, niche, stylePrompt,
      intensity: final_intensity, goal, factSection, factSafetyRules,
      platform, videoLength: video_length, narrationStyle: narration_style,
      contentType, strictFactMode, sourceVideoMode,
    })

    const packagingResult = await generatePackaging({
      topic, isShorts, platform,
      hook: coreResult.parsed.hook as string,
      narration: coreResult.parsed.narration as string,
      niche, uploadTimes, strictFactMode, qualityStatus,
    })

    const result = {
      topic, platform, video_length, narration_style,
      intensity_original: intensity,
      intensity_final: final_intensity,
      intensity_downgraded: was_downgraded,
      intensity_downgrade_reason: downgrade_reason,
      content_type: contentType,
      strict_fact_mode: strictFactMode,
      fact_strictness_level: factStrictnessLevel,
      quality_status: qualityStatus,
      estimated_word_count: `${t.words} szo`,
      estimated_duration: isShorts ? `${t.seconds} mp` : `${t.minutes} perc`,
      scene_count: t.scenes,
      hook: coreResult.parsed.hook,
      narration: coreResult.parsed.narration,
      scene_structure: coreResult.parsed.scene_structure,
      broll_ideas: coreResult.parsed.broll_ideas,
      timestamps: coreResult.parsed.timestamps,
      thumbnail_texts: packagingResult.parsed.thumbnail_texts,
      title_variations: packagingResult.parsed.title_variations,
      caption: packagingResult.parsed.caption,
      description: packagingResult.parsed.description,
      hashtags: packagingResult.parsed.hashtags,
      upload_times: uploadTimes,
      cta: coreResult.parsed.cta,
      sources_used: coreResult.parsed.sources_used || sources || [],
      verified_fact_block: factBlock,
      forbidden_claims: factBlock.forbidden_claims,
      opportunity_context: opportunity_context || null,
    }

    await logUsage(userId, feature, MODELS.primary, coreResult.inputTokens, coreResult.outputTokens, { topic, platform, video_length, sub_step: 'core', content_type: contentType })
    await logUsage(userId, feature, MODELS.fast, packagingResult.inputTokens, packagingResult.outputTokens, { topic, platform, video_length, sub_step: 'packaging' })

    const chargeResult = await chargeFeature(userId, feature, { topic, platform, video_length })

    return NextResponse.json({ ...result, _credits_remaining: chargeResult.new_balance })
  } catch (error) {
    console.error('Video Package error:', error)
    return NextResponse.json({ error: 'Generalas sikertelen. Probald ujra.' }, { status: 500 })
  }
}
