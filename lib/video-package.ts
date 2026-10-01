// ============================================================
// WILLVIRAL — Video Package (Gyartasi csomag)
// ============================================================
// Ket AI-hivasra bomlik: a "creative core" (hook/narracio/jelenetek,
// meg mindig isShorts-alapu, mert a hossz/tempo tenyleg ettol fugg)
// es a "packaging" (cim/thumbnail/caption/hashtag/checklist), amiben
// a platform_checklist resz MAR platform-kulcs alapjan agazik, nem
// isShorts alapjan — ez a genuine platform-natriv feltoltesi checklist.

import { MODELS } from '@/lib/models'
import { callAIProvider, extractJson } from '@/lib/services/ai-provider-service'
import type { QualityStatus } from '@/lib/fact-safety'

// 2026-10-01 incident fix -- generateCreativeCore's non-streamed, 6000-max-
// token Sonnet call didn't finish within the shared client's 60s timeout
// (observed: ~38.7 output tok/s, two Error-499 attempts at 2,275/2,332
// tokens in 59.44-59.60s -- Anthropic's own Console Logs confirm the
// provider was actively generating, not rejecting). Fix is scoped to THIS
// route's two AI calls only -- no other caller's timeout/retry changes.
//
// Core: streaming (so progress isn't capped by the SDK's header-arrival-only
// `timeout` -- see ai-provider-service.ts's AICallInput doc comment) with
// our OWN absolute deadline, maxRetries:0 (a timed-out generation must never
// silently restart). 200s covers the full 6000-token worst case with real
// margin (6000 / 38.7 tok/s ≈ 155s) while still fitting the route's overall
// budget -- see the budget line below.
export const CORE_STREAM_DEADLINE_MS = 200_000
// Packaging: same 60s duration as before (unchanged value -- Haiku,
// 3500 tokens, historically 1-8s), but maxRetries:0 so a timeout here also
// can't silently double the wall-clock cost.
export const PACKAGING_TIMEOUT_MS = 60_000
// Worst-case route budget -- ESTIMATE, not a proven/measured worst case:
// the ~16s overhead figure is the real incident's own ~7.8s PRE-call
// overhead (auth/ownership/snapshot/lock/cache-check, actually observed)
// PLUS an UNVALIDATED ~8s guess for the POST-call writes (2x logUsage,
// chargeFeature, savePaidResult, lock release) -- the incident itself never
// reached that code path, so that half of the number has no direct
// measurement behind it. On that basis: 200s (core) + 60s (packaging, no
// retry) + ~16s overhead ≈ 276s, vs. the route's actual Vercel ceiling
// (confirmed from the incident's own Vercel log: "Execution Duration /
// Maximum: 2m 5s / 5m") of 300s -- ≈24s estimated margin for lock-release
// and savePaidResult. Treat both the ≈276s and the ≈24s margin as estimates
// pending a real near-worst-case run, not as a verified bound.

// Remaining-time guard (2026-10-01 incident fix, follow-up): a slow core
// generation must not be allowed to run packaging, and a slow
// core+packaging pair must not be allowed to charge a credit, if what's
// left of the route's own execution budget isn't comfortably enough to
// finish safely. Without this, a near-worst-case run could start
// generatePackaging() or chargeFeature() with too little time left, get cut
// off by the platform mid-flight, and -- in the charge case -- leave the
// user charged with no saved result (a NEW, timing-triggered variant of the
// pre-existing, independently-tracked chargeFeature/savePaidResult gap).
//
// ROUTE_BUDGET_MS is the confirmed Vercel "Maximum Duration" from the
// incident's own log -- the platform/account ceiling, not something
// measured per-request. The two margins below are DELIBERATELY GENEROUS,
// CHOSEN estimates, not measured or guaranteed minimums -- the actual
// post-AI DB-write cost (logUsage/chargeFeature/savePaidResult/lock
// release) has never been measured under a real near-worst-case run (see
// the budget comment above). Treat a request that trips either guard as
// "we chose not to risk it", not as proof the request would have failed.
export const ROUTE_BUDGET_MS = 300_000
export const PACKAGING_SAFETY_MARGIN_MS = 20_000
export const CHARGE_SAVE_SAFETY_MARGIN_MS = 20_000

export function hasTimeBudgetForPackaging(elapsedMs: number): boolean {
  return ROUTE_BUDGET_MS - elapsedMs >= PACKAGING_TIMEOUT_MS + PACKAGING_SAFETY_MARGIN_MS
}

export function hasTimeBudgetForChargeAndSave(elapsedMs: number): boolean {
  return ROUTE_BUDGET_MS - elapsedMs >= CHARGE_SAVE_SAFETY_MARGIN_MS
}

export const STYLE_PROMPTS: Record<string, string> = {
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

export const INTENSITY_GUIDE: Record<string, string> = {
  light: 'Visszafogott, termeszetes. Semmi tulzas. Hiteles es szakmai.',
  classic: 'Kiegyensulyozott. Eros de hiteles.',
  extreme: 'Maximum energia. Csak konnyed temaknál.',
}

export const GOAL_GUIDE: Record<string, string> = {
  views: 'Kattintas es nezettség. Curiosity gap kotelez.',
  comments: 'Komment. Tegyel fel kerdest a vegen.',
  shares: 'Megosztás. Wow faktor.',
  saves: 'Mentes. Ertekes, visszanézhetó info.',
  subscribers: 'Feliratkozas. CTA: ha erdekel a folytatás...',
  affiliate: 'Affiliate kattintas. Termeszetes integracio.',
}

export function getShortsTarget(length: string) {
  if (length === '30sec') return { words: '65-85', chars: '450-650', seconds: 30 }
  if (length === '45sec') return { words: '95-125', chars: '700-950', seconds: 45 }
  return { words: '130-165', chars: '950-1300', seconds: 60 }
}

export function getLongTarget(length: string) {
  if (length === '3-5min') return { words: '450-750', scenes: '6-9', minutes: '3-5' }
  return { words: '900-1500', scenes: '10-16', minutes: '6-10' }
}

export function getUploadTimes(platform: string) {
  if (platform === 'tiktok') return { primary: '19:00-21:00', secondary: '11:00-13:00', reason: 'Általános ajánlások. Saját analytics alapján pontosítható.' }
  const isShorts = ['youtube_shorts', 'instagram_reels', 'facebook_reels'].includes(platform)
  if (isShorts) return { primary: '18:00-21:00', secondary: '11:30-13:00', reason: 'Általános ajánlások. Saját analytics alapján pontosítható.' }
  return { primary: '18:00-21:00', secondary: '16:00-18:00', reason: 'Általános ajánlások. Pontosabb időzítéshez saját csatorna teljesítményadat szükséges.' }
}

export function getHashtagGuide(platform: string) {
  if (platform === 'youtube_shorts') return '3-5 hashtag. #Shorts kotelezo. Niche alapu, magyar kozonseg.'
  if (platform === 'tiktok') return '4-8 hashtag. Discovery + niche mix. Ne spam.'
  if (platform === 'instagram_reels') return '5-10 hashtag. Tema + niche + erdeklodesi kor.'
  return '3-5 SEO hashtag. Kulcsszo alapu.'
}

export const NARRATION_QUALITY_RULES = `
NARRACIOS MINOSEGI SZABALYOK - KOTELEZO:
1. EMBERI SZOVEG: Tapasztalt magyar tartalomgyarto hangja. Termeszetes, gordulekeny, felolvasható.
2. NEM ADATLISTA: Narrativ iv: hook, felvezetes, fo gondolat, felismeres, CTA.
3. EGY FO GONDOLAT: Shorts-nal egyetlen fo gondolatot magyarazz el erosen.
4. CURIOSITY GAP: Az elejen nyiss egy kerdest, csak a vegen zard le.
5. TET: A nezo ertse, miert szamit neki.
6. PREMIUM ERZET: Ne legyen gagyi clickbait.
7. STILUS CSAK A NYELVEZETET MODOSITHATJA - A TENYEKET NEM.`

export const JSON_RULES = `
KRITIKUS JSON SZABALYOK - KOTELEZO:
- SOHA ne hasznalj idezojelet a JSON string ertekek BELSEJEBEN
- A "narration" mezo EGYETLEN soros string legyen - SOHA ne hasznalj sortorést benne
- Minden string ertek egy soros legyen, sortorest nelkul
- Csak pure JSON-t adj vissza, semmi mas szoveget`

export const SOURCE_VIDEO_REWRITE_RULES = `
SOURCE VIDEO SAJAT VERZIO MOD - KOTELEZO:
- A forrasvideo transcriptje ellenorzott primer forrasnak szamit.
- A narracio legyen sajat, eredeti magyar verzio, ne masold szo szerint a forrasvideo mondatait.
- A tenyeket, sorrendet es kulcspontokat a source video fact block alapjan hasznald.
- Ne adj hozza uj konkret tenyt, nevet, szamot vagy vadat, ami nincs a source video fact blockban.
- Ha a transcript csak reszleges, jelolj ovatos kovetkeztetest es ne toltsd ki kitalalt reszletekkel.`

export async function generateCreativeCore(params: {
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
  const channelContext = niche || 'nincs megadva'

  const prompt = isShorts
    ? `Te egy profi magyar YouTube videocsomag-keszito vagy.

TEMA: "${topic}"
AKTUALIS VIDEO TEMA: "${topic}"
CSATORNA ALAPNICHE: ${channelContext}
FONTOS: a csatorna alapniche csak hangnemhez, celkozonseghez es hashtaghez ad kontextust. A konkret allitasokat es a narracio temajat az AKTUALIS VIDEO TEMA es a verified fact block hatarozza meg.
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
  "hook_variations": ["Alternativ hook 1 - mas szog, EGY SOROS", "Alternativ hook 2 - mas szog, EGY SOROS"],
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
AKTUALIS VIDEO TEMA: "${topic}"
CSATORNA ALAPNICHE: ${channelContext}
FONTOS: a csatorna alapniche csak hangnemhez, celkozonseghez es hashtaghez ad kontextust. A konkret allitasokat es a narracio temajat az AKTUALIS VIDEO TEMA es a verified fact block hatarozza meg.
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
  "hook_variations": ["Alternativ hook 1 - mas szog, EGY SOROS", "Alternativ hook 2 - mas szog, EGY SOROS"],
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

  const aiCall = await callAIProvider({
    model: MODELS.primary,
    maxTokens: 6000,
    messages: [{ role: 'user', content: prompt }],
    promptTemplateId: isShorts ? 'video_package_core_shorts' : 'video_package_core_long',
    promptVersion: 'v1',
    stream: true,
    maxRetries: 0,
    streamDeadlineMs: CORE_STREAM_DEADLINE_MS,
    // The SDK's own per-call `timeout` only bounds time-to-headers (see the
    // AICallInput doc comment in ai-provider-service.ts), but WITHOUT this
    // override it still falls back to the shared client's 60s default
    // (getAnthropicClient()) for that header wait -- a second, shorter
    // mechanism than our streamDeadlineMs abort above, and not the one
    // intended to govern this call. Setting it equal to the stream deadline
    // means the header-wait ceiling can never fire before, or instead of,
    // our own full-stream deadline.
    timeoutMs: CORE_STREAM_DEADLINE_MS,
  })

  const parsed = extractJson<Record<string, unknown>>(aiCall.text)

  return {
    parsed,
    inputTokens: aiCall.usage.inputTokens,
    outputTokens: aiCall.usage.outputTokens,
    estimatedCost: aiCall.estimatedCost,
  }
}

// ============================================================
// Platform-natriv feltoltesi checklist
// ============================================================
// Minden platform-csalad tenylegesen eltero mezokeszletet kap —
// nem csak egy kozos sema platform-cimkevel. A schema-t egyetlen
// extra JSON-blokk formajaban kerjuk a mar amugy is futo packaging
// AI-hivastol (nincs kulon harmadik AI-kor, nincs extra koltseg).

export type PlatformChecklistType = 'youtube' | 'tiktok' | 'instagram_reels' | 'facebook_reels'

export function platformToChecklistType(platform: string): PlatformChecklistType {
  if (platform === 'tiktok') return 'tiktok'
  if (platform === 'instagram_reels') return 'instagram_reels'
  if (platform === 'facebook_reels') return 'facebook_reels'
  return 'youtube'
}

export interface YouTubeChecklist {
  type: 'youtube'
  title: string
  description: string
  tags: string[]
  category: string
  language: string
  captions_note: string
  comments_setting: string
  made_for_kids: boolean
  made_for_kids_reason: string
  age_restriction: boolean
  age_restriction_reason: string
  license: string
  paid_promotion_disclosure: boolean
  paid_promotion_disclosure_note: string
  visibility_schedule_advice: string
  playlist_suggestion: string
  end_screens_plan: string | null
  cards_plan: string | null
}

export interface TikTokChecklist {
  type: 'tiktok'
  caption: string
  hashtags: string[]
  cover_image_guidance: string
  sound_note: string
  privacy_setting: string
  duet_stitch_comments_settings: string
  branded_content_disclosure: string
}

export interface InstagramReelsChecklist {
  type: 'instagram_reels'
  caption: string
  hashtags: string[]
  cover_image: string
  audio_note: string
  alt_text: string
  share_to_feed_toggle: string
  collab_tag_guidance: string
  branded_content_disclosure: string
}

export interface FacebookReelsChecklist {
  type: 'facebook_reels'
  caption: string
  cross_post_to_feed: string
  audience_visibility: string
  music_note: string
}

export type PlatformChecklist = YouTubeChecklist | TikTokChecklist | InstagramReelsChecklist | FacebookReelsChecklist

function buildYoutubeChecklistSchema(isShorts: boolean): string {
  const endScreensCards = isShorts
    ? ''
    : `,
    "end_screens_plan": "Konkret javaslat: mit tegyen a creator a video utolso 5-20 masodperceben megjeleno vegkepernyore (pl. ajanlott kovetkezo video + feliratkozas gomb)",
    "cards_plan": "Konkret javaslat: hova erdemes kartyat (card) elhelyezni a video kozepén, mire mutasson"`
  return `"youtube_checklist": {
    "title": "SEO-optimalizalt hivatalos feltoltesi cim (kulon a fenti title_variations listatol)",
    "description": "YouTube leiras SEO-ra optimalizalva, elso sorban a fo kulcsszoval",
    "tags": ["8-12 YouTube tag/kulcsszo, hashtag jel nelkul"],
    "category": "YouTube kategoria neve, pl. Entertainment / Education / Howto & Style / Science & Technology / People & Blogs",
    "language": "A video nyelve, pl. Hungarian",
    "captions_note": "Javaslat: keszitsen-e sajat feliratot a creator vagy elegendo az automatikus, es miert",
    "comments_setting": "Javasolt hozzaszolas-beallitas indoklassal (pl. minden hozzaszolas engedve / lehetseges nem megfelelo tartalom kiszurve / elozetes jovahagyas)",
    "made_for_kids": false,
    "made_for_kids_reason": "1 mondatos indoklas",
    "age_restriction": false,
    "age_restriction_reason": "1 mondatos indoklas",
    "license": "Standard YouTube licenc vagy Creative Commons - indoklassal, melyik illik jobban",
    "paid_promotion_disclosure": false,
    "paid_promotion_disclosure_note": "Ha van fizetett promocio/termekmegjelenites a temaban, jelezd, kulonben irj 'Nincs fizetett promocio'-t",
    "visibility_schedule_advice": "Javaslat: azonnali publikalas vagy utemezett feltoltes, es milyen napszakban",
    "playlist_suggestion": "Melyik lejatszasi listaba illene ez a video"${endScreensCards}
  }`
}

function buildTikTokChecklistSchema(): string {
  return `"tiktok_checklist": {
    "caption": "TikTok caption max 150 karakter, egy soros",
    "hashtags": ["4-8 TikTok hashtag, #-tel"],
    "cover_image_guidance": "Melyik kockat/pillanatot erdemes borito-kepnek valasztani es miert",
    "sound_note": "Javaslat: sajat hang vagy trending TikTok sound hasznalata, milyen tipusu zene/hang illene",
    "privacy_setting": "Javasolt lathatosag (mindenki / baratok / privat) indoklassal",
    "duet_stitch_comments_settings": "Javaslat: engedelyezze-e a Duet-et, Stitch-et es a hozzaszolasokat, indoklassal",
    "branded_content_disclosure": "Ha van fizetett/branded tartalom, jelezd, kulonben irj 'Nincs branded content'-et"
  }`
}

function buildInstagramChecklistSchema(): string {
  return `"instagram_checklist": {
    "caption": "Instagram Reels caption, 1-3 bekezdes",
    "hashtags": ["5-10 Instagram hashtag, #-tel"],
    "cover_image": "Melyik kockat erdemes borito-kepnek valasztani",
    "audio_note": "Javaslat: sajat hang vagy trending audio hasznalata",
    "alt_text": "1 mondatos alt-text javaslat lathassergultseg-korlatozott felhasznaloknak",
    "share_to_feed_toggle": "Javaslat: ossze-e is posztolja a Feedre, ne csak Reels fulre, indoklassal",
    "collab_tag_guidance": "Ha relevans, javaslat collab-tag hasznalatara masik fiokkal, kulonben irj 'Nem relevans'-ot",
    "branded_content_disclosure": "Ha van fizetett/branded tartalom, jelezd, kulonben irj 'Nincs branded content'-et"
  }`
}

function buildFacebookChecklistSchema(): string {
  return `"facebook_checklist": {
    "caption": "Facebook Reels leiras/caption, 1-2 mondat",
    "cross_post_to_feed": "Javaslat: keruljon-e a Feedre is a Reels fulon kivul, indoklassal",
    "audience_visibility": "Javasolt kozonseg/lathatosag beallitas (publikus / baratok / egyeni)",
    "music_note": "Hangulat/mufaj-alapu zenei javaslat, NEM konkret szerzoi jogvedett cim"
  }`
}

export function buildPlatformChecklistSchemaFragment(platform: string, isShorts: boolean): string {
  const type = platformToChecklistType(platform)
  if (type === 'youtube') return buildYoutubeChecklistSchema(isShorts)
  if (type === 'tiktok') return buildTikTokChecklistSchema()
  if (type === 'instagram_reels') return buildInstagramChecklistSchema()
  return buildFacebookChecklistSchema()
}

export function extractPlatformChecklist(platform: string, isShorts: boolean, parsed: Record<string, unknown>): PlatformChecklist {
  const type = platformToChecklistType(platform)
  if (type === 'youtube') {
    const c = (parsed.youtube_checklist || {}) as Partial<YouTubeChecklist>
    return {
      type: 'youtube',
      title: c.title || '',
      description: c.description || '',
      tags: c.tags || [],
      category: c.category || '',
      language: c.language || '',
      captions_note: c.captions_note || '',
      comments_setting: c.comments_setting || '',
      made_for_kids: !!c.made_for_kids,
      made_for_kids_reason: c.made_for_kids_reason || '',
      age_restriction: !!c.age_restriction,
      age_restriction_reason: c.age_restriction_reason || '',
      license: c.license || '',
      paid_promotion_disclosure: !!c.paid_promotion_disclosure,
      paid_promotion_disclosure_note: c.paid_promotion_disclosure_note || '',
      visibility_schedule_advice: c.visibility_schedule_advice || '',
      playlist_suggestion: c.playlist_suggestion || '',
      end_screens_plan: isShorts ? null : (c.end_screens_plan || null),
      cards_plan: isShorts ? null : (c.cards_plan || null),
    }
  }
  if (type === 'tiktok') {
    const c = (parsed.tiktok_checklist || {}) as Partial<TikTokChecklist>
    return {
      type: 'tiktok',
      caption: c.caption || '',
      hashtags: c.hashtags || [],
      cover_image_guidance: c.cover_image_guidance || '',
      sound_note: c.sound_note || '',
      privacy_setting: c.privacy_setting || '',
      duet_stitch_comments_settings: c.duet_stitch_comments_settings || '',
      branded_content_disclosure: c.branded_content_disclosure || '',
    }
  }
  if (type === 'instagram_reels') {
    const c = (parsed.instagram_checklist || {}) as Partial<InstagramReelsChecklist>
    return {
      type: 'instagram_reels',
      caption: c.caption || '',
      hashtags: c.hashtags || [],
      cover_image: c.cover_image || '',
      audio_note: c.audio_note || '',
      alt_text: c.alt_text || '',
      share_to_feed_toggle: c.share_to_feed_toggle || '',
      collab_tag_guidance: c.collab_tag_guidance || '',
      branded_content_disclosure: c.branded_content_disclosure || '',
    }
  }
  const c = (parsed.facebook_checklist || {}) as Partial<FacebookReelsChecklist>
  return {
    type: 'facebook_reels',
    caption: c.caption || '',
    cross_post_to_feed: c.cross_post_to_feed || '',
    audience_visibility: c.audience_visibility || '',
    music_note: c.music_note || '',
  }
}

export async function generatePackaging(params: {
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
  const channelContext = niche || 'nincs megadva'

  const haiku_safety = strictFactMode ? `
HAIKU TENYSZABALYOK - KOTELEZO:
- Ne adj hozza uj tenyt amelyik nincs a narracioban
- A cim ne legyen erosebb allitas mint a narracio
- Ne hasznalj uj szereplot, tisztseget, rokoni kapcsolatot
- Ne hasznalj: LEBUKOTT, HAZUDOTT, TITKOLTAK, BIZONYITOTT - forrás nelkul
- Ha allitas, ne teny - hasznalj kerdjelet` : ''

  const platformChecklistSchema = buildPlatformChecklistSchemaFragment(platform, isShorts)

  const prompt = `Egy magyar ${isShorts ? 'Shorts/TikTok' : 'YouTube'} videohoz kell marketing csomagolas ES platform-natriv feltoltesi checklist.

TEMA: "${topic}"
AKTUALIS VIDEO TEMA: "${topic}"
CSATORNA ALAPNICHE: ${channelContext}
FONTOS: a csatorna alapniche csak hashtag es pozicionalasi kontextus, nem irhatja felul az aktualis videotemat.
CEL PLATFORM: ${platform}
HOOK: ${hook}
NARRACIO RESZLET: ${narration.slice(0, 300)}...
QUALITY STATUS: ${qualityStatus}

HASHTAG SZABALY: ${getHashtagGuide(platform)}

${haiku_safety}

A "platform_checklist" mezoben egy KULON, a CEL PLATFORM-ra szabott feltoltesi checklistet kerek — ez NEM ugyanaz, mint az altalanos cim/thumbnail/hashtag lista fentebb, hanem a tenyleges feltoltes soran kitoltendo platform-specifikus beallitasok (pl. YouTube-nal kategoria/korhatar/licenc, TikToknal borito/hangbeallitas, Instagramnal alt-text/collab-tag, Facebooknal keresztpostazasi beallitas). Csak azokat a mezoket toltsd ki, amik ehhez a CEL PLATFORM-hoz tartoznak.

KRITIKUS JSON SZABALYOK:
- SOHA ne hasznalj idezojelet a JSON string ertekek BELSEJEBEN
- Minden string ertek egy soros legyen sortores nelkul
- Csak pure JSON-t adj vissza

Keszitsd el magyarul, KIZAROLAG valid JSON-ban:
{
  "thumbnail_texts": ["${isShorts ? 'OVERLAY' : 'THUMBNAIL'} szoveg 1 max 4 szo nagybetukkel", "szoveg 2", "szoveg 3", "szoveg 4"],
  "thumbnail_concept": "1-2 mondatos kompozicio-javaslat: mit mutasson a kep, milyen kontraszt/erzelem/szimbolum kelti fel a figyelmet",
  "title_variations": ["Magyar cim 1", "Cim 2", "Cim 3", "Cim 4", "Cim 5"],
  "caption": "${isShorts ? 'Rovid caption max 300 karakter egy soros' : 'rovid caption'}",
  "description": "${isShorts ? '' : 'SEO-barát YouTube leiras min 150 szo LINK placeholderekkel'}",
  "hashtags": {
    "viral": ["#hashtag1", "#hashtag2"],
    "niche": ["#hashtag3", "#hashtag4"],
    "general": ["#hashtag5"]
  },
  "pinned_comment": "Rovid, elkotelezodest generalo hozzaszolas-javaslat, amit a creator kituzhet a video ala",
  "why_it_works": "1-2 mondat, konkretan a fenti hook/tema/quality status alapjan, miert mukodhet ez a video",
  "risks": ["Konkret kockazat 1 (pl. tul altalanos cim, gyenge hook, tulzsufolt thumbnail)", "Konkret kockazat 2"],
  "production_checklist": ["Gyartasi lepes 1", "Gyartasi lepes 2", "Gyartasi lepes 3"],
  ${platformChecklistSchema}
}`

  const aiCall = await callAIProvider({
    model: MODELS.fast,
    maxTokens: 3500,
    messages: [{ role: 'user', content: prompt }],
    promptTemplateId: 'video_package_packaging',
    promptVersion: 'v2',
    maxRetries: 0,
    timeoutMs: PACKAGING_TIMEOUT_MS,
  })

  const parsed = extractJson<Record<string, unknown>>(aiCall.text)

  return {
    parsed,
    inputTokens: aiCall.usage.inputTokens,
    outputTokens: aiCall.usage.outputTokens,
    estimatedCost: aiCall.estimatedCost,
  }
}
