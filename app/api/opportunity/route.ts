// app/api/opportunity/route.ts
// WillViral — Opportunity Engine v4 (Core Trust Engine)

import { NextRequest, NextResponse } from 'next/server'
import { isJsonWithinLimit, isPlainRecord, topicInputTooLong, topicTooLongResponseMessage } from '@/lib/api-input-validation'
import { MODELS } from '@/lib/models'
import { callAIProvider, extractJson } from '@/lib/services/ai-provider-service'
import { createServerSupabaseClient, createAdminClient } from '@/lib/supabase-server'
import {
  buildTrendCandidates,
  getSerperHealthStatus,
  type TrendCandidate,
} from '@/lib/trend-radar'
import { expandTopicQueries, suggestSpecificTopics, recommendedAngleForExpansion, recommendedFormatForExpansion, hookPatternForExpansion } from '@/lib/topic-expansion'
import { detectNicheIntent, buildBroadNicheDiscoveryPacks, buildDrilldownSeedsForDirection, type BroadDiscoveryPack } from '@/lib/broad-niche-discovery'
import { buildNicheExpansion } from '@/lib/niche-expansion'
import type { OpportunityTopic, OpportunitySearchMode } from '@/types'
import { logYouTubeSearch, checkUsagePermission, chargeProtectedFeature, logFreeProductUse } from '@/lib/usage-protection'
import { logUsage, refundCreditsAfterPersistenceFailure } from '@/lib/credits'
import { promoteToTrackedCandidate } from '@/lib/trend-tracking'
import { validateSpecificFocus } from '@/lib/search/validate-focus'
import {
  evaluateCandidate,
  applySafeOutput,
  toOpportunityTopic,
  buildClaudePromptContext,
  ENGINE_VERSION,
  type ViralCandidate,
} from '@/lib/core-trust-engine'
import { buildCacheKey, buildTrendCacheKey } from '@/lib/core-trust-engine/cache'
import { buildPaidResultHash, getPaidResultByHash, getPaidResultById, normalizePaidResultInput, openPaidResult, paidResultResponseMeta, savePaidResult } from '@/lib/paid-results/paid-results-service'
import { acquireRequestLock, releaseRequestLock, REQUEST_IN_PROGRESS_ERROR } from '@/lib/request-lock'

// ── Fallback topic builders (research lanes, broad discovery) ────
// A korabbi RESEARCH_LANE_MAP/decomposeNicheToLanes ~13 hardcode-olt
// kategoriaval dolgozott — helyette a Niche Expansion Engine (lib/niche-expansion.ts)
// adja a "kutatasi irany" cimkeket es kulcsszavakat, barmilyen niche-re dinamikusan.

async function buildResearchFallbackTopics(params: {
  niche: string
  platform?: string
  effectiveRegion: 'HU' | 'US'
  seeds: string[]
  category: string
}) {
  const { niche, platform, effectiveRegion, category } = params
  const now = new Date().toISOString()
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

  const expansion = await buildNicheExpansion({ niche, region: effectiveRegion, language: effectiveRegion === 'HU' ? 'hu' : 'en' })
  const lanes = expansion.packs.length > 0
    ? expansion.packs.map(pack => ({ title: pack.label, description: `Kereshető tartalomirány a(z) "${niche}" niche-en belül: ${pack.seeds.slice(0, 3).join(', ')}.`, keyword: pack.seeds[0] || pack.label, category }))
    : [{ title: `${niche} — kutatasi irany`, description: 'A niche-hez most nem talaltunk eleg friss trendet. Keress konkretabb temat.', keyword: niche, category }]

  return lanes.map((lane, index) => ({
    id: 'research-' + lane.category + '-' + index + '-' + Date.now(),
    title: lane.title,
    description: lane.description,
    opportunity_score: 0,
    score_breakdown: { trend_momentum: 0, niche_match: 0, content_gap: 0, competition: 0, freshness: 0, total: 0 },
    region: effectiveRegion as OpportunityTopic['region'],
    platform: (platform || 'youtube') as OpportunityTopic['platform'],
    niche,
    generated_at: now,
    expires_at: expires,
    evidence_videos: [],
    web_sources: [],
    confidence: 'alacsony',
    keyword: lane.keyword,
    niche_cluster: lane.category,
    trend_source_type: 'research_fallback',
    trend_confidence: 'low',
    trend_source_label: 'Kutatasi irany — konkretabb temakeresest igenyel.',
    user_input: niche,
    expanded_from_query: lane.keyword,
    expansion_type: 'storytelling',
    expansion_intent: 'find_story_angle',
    story_potential_score: 48,
    recommended_angle: recommendedAngleForExpansion('storytelling', lane.title),
    recommended_format: recommendedFormatForExpansion('storytelling', 48),
    hook_pattern: hookPatternForExpansion('storytelling', lane.title),
    hook_suggestion: '',
    ready_to_produce_status: 'research' as const,
    ready_to_produce_label: 'Kutatási irány',
    evidence_strength: 'none',
    validation_reason: 'Tág niche-ből bontott kutatási irány. Még nincs elég konkrét webes vagy videós bizonyíték a gyártási ajánláshoz.',
    recommended_next_action: 'refine_topic',
    data_limitations: ['Nincs validált webes forrás', 'Nincs releváns YouTube bizonyíték', 'Téma szűkítése szükséges'],
    evidence_match_score: 20,
    risk_flags: ['Nincs elég friss bizonyíték', 'Túl tág niche', 'További szűkítés javasolt'],
    needs_explanation: false,
    engine_version: ENGINE_VERSION,
  }))
}

function buildBroadDiscoveryFallbackTopics(params: {
  niche: string
  platform?: string
  effectiveRegion: 'HU' | 'US'
  packs: BroadDiscoveryPack[]
  existingTitles?: string[]
}): Array<OpportunityTopic & { needs_explanation?: boolean }> {
  const { niche, platform, effectiveRegion, packs, existingTitles = [] } = params
  const existing = new Set(existingTitles.map(t => t.toLowerCase()))
  const now = new Date().toISOString()
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

  return packs
    .filter(pack => !existing.has(pack.label.toLowerCase()))
    .slice(0, 6)
    .map((pack, index) => ({
      id: 'broad-discovery-' + pack.category + '-' + index + '-' + Date.now(),
      title: pack.label,
      description: 'Ez egy kereshető tartalomirány a megadott tág niche-en belül. A rendszer globális forrásokból és YouTube-jelekből próbál konkrét gyártható témát találni hozzá.',
      opportunity_score: 0,
      score_breakdown: { trend_momentum: 0, niche_match: 0, content_gap: 0, competition: 0, freshness: 0, total: 0 },
      region: effectiveRegion as OpportunityTopic['region'],
      platform: (platform || 'youtube') as OpportunityTopic['platform'],
      niche,
      generated_at: now,
      expires_at: expires,
      evidence_videos: [],
      web_sources: [],
      confidence: 'alacsony',
      keyword: pack.seeds[0] || pack.label,
      niche_cluster: pack.category,
      trend_source_type: 'broad_niche_discovery',
      trend_confidence: 'low',
      trend_source_label: 'Tág niche-ből bontott keresési irány. Nem kész gyártási ajánlás, hanem további validálási út.',
      user_input: niche,
      expanded_from_query: pack.seeds[0] || pack.label,
      expansion_type: 'storytelling',
      expansion_intent: 'find_story_angle',
      story_potential_score: 52,
      recommended_angle: recommendedAngleForExpansion('storytelling', pack.label),
      recommended_format: recommendedFormatForExpansion('storytelling', 52),
      hook_pattern: hookPatternForExpansion('storytelling', pack.label),
      hook_suggestion: 'Kezdd egy meglepő példával, majd mutasd meg, miért nem úgy működik, ahogy elsőre gondolnánk.',
      ready_to_produce_status: 'research' as const,
      ready_to_produce_label: 'Kutatási irány',
      evidence_strength: 'none',
      validation_reason: 'Ez keresési irány, nem kész gyártási téma. Mély frissítéssel vagy konkrétabb kulcsszóval validálható.',
      recommended_next_action: 'refine_topic',
      data_limitations: ['Nincs validált webes forrás', 'Nincs releváns YouTube bizonyíték', 'Tág niche-ből bontott irány'],
      evidence_match_score: 35,
      risk_flags: ['További validálás kell', 'Még nincs elég konkrét bizonyíték'],
      decision_score: 35,
      needs_explanation: false,
      engine_version: ENGINE_VERSION,
    }))
}

// ── Main handler ─────────────────────────────────────────────

interface OpportunityRequestBody {
  niche?: string
  topic?: string
  platform?: string
  language?: string
  region?: string
  creator_level?: string
  discovery_mode?: string
  parent_niche?: string
  main_category?: string
  specific_focus?: string
  audience?: string
  avoid_topics?: string
  paidResultId?: string
  paid_result_id?: string
  search_mode?: string
  channel_usage_mode?: string
  cache_only?: boolean
  force_refresh?: boolean
  use_channel_signals?: boolean
  exclude_titles?: string[]
}

export async function POST(request: NextRequest) {
  try {
    const parsedBody: unknown = await request.json().catch(() => null)
    if (!isPlainRecord(parsedBody) || !isJsonWithinLimit(parsedBody)) {
      return NextResponse.json({ error: 'Érvénytelen vagy túl nagy kérés.' }, { status: 400 })
    }
    const textFields = ['niche', 'topic', 'platform', 'language', 'region', 'creator_level', 'discovery_mode', 'parent_niche', 'main_category', 'specific_focus', 'audience', 'avoid_topics', 'paidResultId', 'paid_result_id', 'search_mode', 'channel_usage_mode']
    if (textFields.some(key => parsedBody[key] !== undefined && parsedBody[key] !== null && typeof parsedBody[key] !== 'string')) {
      return NextResponse.json({ error: 'Érvénytelen szöveges mező.' }, { status: 400 })
    }
    if (['cache_only', 'force_refresh', 'use_channel_signals'].some(key => parsedBody[key] !== undefined && typeof parsedBody[key] !== 'boolean')) {
      return NextResponse.json({ error: 'Érvénytelen logikai mező.' }, { status: 400 })
    }
    if (parsedBody.exclude_titles !== undefined && (!Array.isArray(parsedBody.exclude_titles) || parsedBody.exclude_titles.length > 50 || parsedBody.exclude_titles.some(value => typeof value !== 'string' || value.length > 300))) {
      return NextResponse.json({ error: 'Érvénytelen kizárási lista.' }, { status: 400 })
    }
    const body = parsedBody as OpportunityRequestBody
    const { platform, language, region, creator_level, discovery_mode, parent_niche, cache_only, force_refresh, exclude_titles, main_category: bodyMainCategory, specific_focus: bodySpecificFocus, audience, avoid_topics, paidResultId, paid_result_id, topic, use_channel_signals, channel_usage_mode: bodyChannelUsageMode } = body
    const searchMode: OpportunitySearchMode | undefined = ['niche_based', 'specific_topic', 'discovery_random'].includes(body.search_mode as string) ? body.search_mode as OpportunitySearchMode : undefined
    const excludeTitles: string[] = Array.isArray(exclude_titles)
      ? exclude_titles.map((t: string) => String(t).toLowerCase().trim()).filter(Boolean)
      : []

    const supabase = createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const admin = createAdminClient()
    const effectiveRegion: 'HU' | 'US' = region === 'HU' ? 'HU' : 'US'

    // ── search_mode ág-szétválasztás ──────────────────────────────
    // niche_based: a `niche` STRATEGIAI IRANY, sose direkt query — lent a
    // Niche Expansion Engine bontja fel. specific_topic: a `topic` mar
    // kozvetlen validacios query lehet, a profil niche-e NEM torzithatja
    // el (a `niche` valtozo itt szandekosan magat a topicot kapja, igy a
    // lejjebbi kod — evaluateCandidate niche-fit scoring is — mar
    // automatikusan a topicra, nem a profil niche-ere hivatkozik).
    // discovery_random: nincs kotelezo user-inputolt niche/topic — a
    // creator profil/csatorna-jelekbol szarmaztatunk egy kiindulasi niche-t.
    let niche = String(body.niche || '').replace(/[,;\s]+$/, '').trim()
    let main_category = bodyMainCategory
    let specific_focus = bodySpecificFocus
    let channelUsageMode: string | null = bodyChannelUsageMode || null

    if (searchMode === 'specific_topic') {
      const specificTopic = String(topic || specific_focus || '').trim()
      if (!specificTopic) return NextResponse.json({ error: 'Téma megadása kötelező' }, { status: 400 })
      niche = specificTopic
      specific_focus = specificTopic
    } else if (searchMode === 'discovery_random') {
      const { data: profileRow, error: profileError } = await admin
        .from('profiles')
        .select('main_category, specific_focus, niche, channel_usage_mode, detected_niche_candidates, selected_main_niche')
        .eq('user_id', user.id)
        .maybeSingle()
      if (profileError) throw new Error(`Opportunity profile read failed: ${profileError.message}`)
      channelUsageMode = profileRow?.channel_usage_mode || null
      const candidates = Array.isArray(profileRow?.detected_niche_candidates) ? profileRow.detected_niche_candidates : []

      if (use_channel_signals && channelUsageMode === 'niche_discovery' && candidates.length > 0) {
        main_category = candidates[0].main_category
        specific_focus = candidates[0].specific_focus
        niche = candidates[0].specific_focus
      } else if (channelUsageMode === 'primary_profile' || channelUsageMode === 'manual' || !channelUsageMode) {
        // stats_only eseten (vagy ha nincs semmilyen mod) SEM kenyszeritunk
        // csatorna-niche-t — ilyenkor is a profil kezi/altalanos mezoire esunk
        // vissza, sose a csatorna teljesitmenyjeleire (ld. spec: stats_only
        // ne kenyszeritsen niche-t).
        main_category = profileRow?.main_category
        specific_focus = profileRow?.specific_focus
        niche = profileRow?.specific_focus || profileRow?.niche || ''
      }

      if (!niche) {
        // Nincs semmilyen profil/csatorna-jel — meg mindig NEM vak random:
        // egy minimalis, temaira-fuggetlen "inspiralj" iranyt adunk a Niche
        // Expansion Engine-nek, ami utana ugyanugy validalja az eredmenyt.
        niche = avoid_topics ? `friss videóötletek, kerülve: ${avoid_topics}` : 'friss, validált videóötletek'
      }
    }

    if (!niche) return NextResponse.json({ error: 'Niche megadása kötelező' }, { status: 400 })
    if (topicInputTooLong(niche)) return NextResponse.json({ error: topicTooLongResponseMessage('A niche/téma') }, { status: 400 })

    // Strukturált search context logolása (lib/search/search-context.ts) — a niche
    // pipeline egyelőre a kompatibilis `niche` stringgel dolgozik tovább, hogy ne
    // törjük el a meglévő, finomhangolt Opportunity Engine flow-t. A strukturált
    // mezők itt már elérhetők a következő iterációhoz (Trend Radar / Similar
    // Videos / Video Package források átállításához).
    if (main_category || specific_focus) {
      console.log('[Opportunity] SearchContext:', {
        main_category: main_category || null,
        specific_focus: specific_focus || null,
        audience: audience || null,
        avoid_topics: avoid_topics || null,
        region, language,
      })
    }

    const isDrilldown = discovery_mode === 'drilldown'
    // Ha a niche a strukturált, validált "specifikus fókusz" mezőből jön
    // (lib/search/validate-focus.ts már ellenőrizte), ne találgassa újra a
    // szándékot a detectNicheIntent() törékeny heurisztikája (pl. "nincs
    // nagybetűs entitás a szövegben" tévesen broad_niche-nek jelölt rövid,
    // teljesen valid magyar fókuszmondatokat). Explicit search_mode mindig
    // felulirja a heurisztikat (backward-compat: ha nincs search_mode, a
    // regi heurisztika dont, pl. a Command Center meglevo deep-linkjeinél).
    const isFromStructuredFocus = typeof specific_focus === 'string' && specific_focus.trim() === niche
    const isValidatedFocus = isFromStructuredFocus && validateSpecificFocus(niche).status === 'ok'
    const nicheIntent = searchMode === 'specific_topic'
      ? 'specific_topic'
      : searchMode === 'niche_based' || searchMode === 'discovery_random'
        ? (isDrilldown ? 'specific_topic' : detectNicheIntent(niche))
        : (isDrilldown || isValidatedFocus ? 'specific_topic' : detectNicheIntent(niche))
    const broadDiscoveryPacks = !isDrilldown && nicheIntent === 'broad_niche' && searchMode !== 'specific_topic'
      ? await buildBroadNicheDiscoveryPacks(niche, effectiveRegion)
      : []

    const paidNormalizedInput = normalizePaidResultInput({
      niche,
      discovery_mode: discovery_mode || 'standard',
      parent_niche: parent_niche || '',
      main_category: main_category || '',
      specific_focus: specific_focus || '',
      audience: audience || '',
      avoid_topics: avoid_topics || '',
    })
    const paidInputHash = buildPaidResultHash({
      userId: user.id,
      toolType: 'opportunity_engine',
      normalizedInput: paidNormalizedInput,
      mainCategory: main_category || null,
      specificFocus: specific_focus || null,
      region: effectiveRegion,
      language: language || null,
      platform: platform || 'youtube',
    })

    const lock = await acquireRequestLock({ userId: user.id, toolType: 'opportunity_engine', inputHash: paidInputHash })
    if (!lock.acquired) {
      return NextResponse.json({ error: REQUEST_IN_PROGRESS_ERROR }, { status: 409 })
    }

    try {
    if (!force_refresh) {
      const paidById = await getPaidResultById(user.id, paidResultId || paid_result_id)
      const paid = paidById || await getPaidResultByHash({ userId: user.id, toolType: 'opportunity_engine', inputHash: paidInputHash })
      if (paid) {
        const opened = await openPaidResult(paid)
        return NextResponse.json({
          ...(opened.result_json as object),
          cached: true,
          ...paidResultResponseMeta(opened),
        })
      }
    }

    // ── 1. Cache check ───────────────────────────────────────
    const oppCacheKey = buildCacheKey({
      niche,
      platform,
      region: effectiveRegion,
      language,
      discovery_mode,
      parent_niche,
      niche_intent: nicheIntent,
    })

    // A cache_key tartalmazza a mai naptári dátumot is (lásd buildCacheKey,
    // szándékosan — így külön snapshotok íródhatnak, a heti dashboard pedig a legutóbbi érvényes ajánlást mutatja).
    // A keresésnél viszont ez NEM számíthat: a valódi frissesség-határt az
    // expires_at adja (24 óra a generálástól). Ha csak a pontos, mai dátumú
    // kulcsra keresnénk, nap-váltáskor egy még órák óta ténylegesen érvényes
    // cache is "eltűnne" — és a rendszer feleslegesen (friss YouTube/Serper/
    // Claude hívások, akár kredit árán) újragenerálná ugyanazt minden egyes
    // nap első kérésekor. Ez volt a nap-váltás utáni "üres Top lehetőségek"
    // hiba VALÓDI, gyökér oka — nem csak megjelenítési, hanem költség-hiba is.
    const oppCacheKeyPrefix = oppCacheKey.replace(/-\d{4}-\d{2}-\d{2}$/, '')
    const { data: oppCached, error: oppCacheReadError } = await admin
      .from('opportunity_cache')
      .select('*')
      .like('cache_key', `${oppCacheKeyPrefix}-%`)
      .gt('expires_at', new Date().toISOString())
      .order('generated_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (oppCacheReadError) throw new Error(`Opportunity cache read failed: ${oppCacheReadError.message}`)

    if (oppCached && !force_refresh) {
      const allTopics = oppCached.topics as (OpportunityTopic & { needs_explanation?: boolean; engine_version?: string })[]
      const isCurrentEngine = allTopics.length > 0 && allTopics[0].engine_version === ENGINE_VERSION
      if (isCurrentEngine) {
        const visibleTopics = allTopics.filter(t => !t.needs_explanation)
        const poolTopics = allTopics.filter(t => t.needs_explanation)
        if (visibleTopics.length > 0 || poolTopics.length > 0) {
          return NextResponse.json({
            topics: visibleTopics,
            pool_topics: poolTopics,
            cached: true,
            generated_at: oppCached.generated_at,
          })
        }
      }
    }

    if (cache_only) {
      // A cache_key tartalmazza a mai naptári dátumot is (lásd buildCacheKey),
      // hogy a Trend Feed heti ajánlása korrektül visszatölthető legyen,
      // és ne tűnjön el csak napváltás miatt. Emiatt egy olyan panel, ami csak "van-e már
      // validált top lehetőségem" kérdez (cache_only), nap-váltás után
      // hamisan üresnek látja a tegnap még érvényes eredményt is — a user
      // adata megvan, csak a pontos (mai dátumú) kulcs nem talál rá.
      // Essünk vissza a legutóbbi (max 7 napos) egyező niche/régió/nyelv
      // találatra, hogy a "Top lehetőségek" panel sose mutasson üres
      // állapotot olyankor, amikor valójában van már validált adat.
      const stableKeyPrefix = oppCacheKey.replace(/-\d{4}-\d{2}-\d{2}$/, '')
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
      const { data: fallbackCached, error: fallbackCacheReadError } = await admin
        .from('opportunity_cache')
        .select('*')
        .like('cache_key', `${stableKeyPrefix}-%`)
        .gt('generated_at', sevenDaysAgo)
        .order('generated_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (fallbackCacheReadError) throw new Error(`Opportunity fallback cache read failed: ${fallbackCacheReadError.message}`)

      if (fallbackCached) {
        const allTopics = fallbackCached.topics as (OpportunityTopic & { needs_explanation?: boolean; engine_version?: string })[]
        const isCurrentEngine = allTopics.length > 0 && allTopics[0].engine_version === ENGINE_VERSION
        if (isCurrentEngine) {
          const visibleTopics = allTopics.filter(t => !t.needs_explanation)
          const poolTopics = allTopics.filter(t => t.needs_explanation)
          if (visibleTopics.length > 0 || poolTopics.length > 0) {
            return NextResponse.json({
              topics: visibleTopics,
              pool_topics: poolTopics,
              cached: true,
              stale: true,
              generated_at: fallbackCached.generated_at,
            })
          }
        }
      }

      return NextResponse.json({
        topics: [],
        pool_topics: [],
        cached: false,
        message: 'A trendadatok frissítése folyamatban van. Kattints a Lehetőségek gombra a friss kereséshez.',
      })
    }

    // ── Usage/kredit ellenőrzés — SZERVER OLDALON, nem a kliensre bízva ──
    // Korábban csak a kézzel indított extra ajánlás gomb (force_refresh) ment át
    // a /api/credit-check előzetes ellenőrzésen; az automatikus (pl. oldal
    // betöltéskori) friss generálás semmilyen kvóta-ellenőrzést nem futtatott,
    // ezért sessionStorage törlésével korlátlanul lehetett ingyenes friss
    // Opportunity Engine futtatást indítani a heti 1 ingyenes keret megkerülésével.
    //
    // KRITIKUS SZABÁLY: kreditlevonást soha nem kezdeményezünk user megerősítés
    // nélkül. Ha a heti ingyenes keret elfogyott és a kérés nem force_refresh
    // (vagyis nem egy már megerősítő modalon átment, explicit user akció),
    // itt megállunk — nem indítunk drága Serper/YouTube munkát, és nem vonunk
    // le semmit. A kliensnek ilyenkor meg kell jelenítenie a megerősítő modalt,
    // és csak elfogadás után hívhatja újra force_refresh: true-val (ami a
    // meglévő, változatlan "mindig 2 kredit" ágon fut le sikeres eredménynél).
    if (!force_refresh) {
      const usage = await checkUsagePermission(user.id, 'opportunity_engine', request.headers.get('x-daily-soft-limit-override') === 'true')
      if (!usage.canRun) {
        return NextResponse.json({
          topics: [],
          pool_topics: [],
          cached: false,
          charged: false,
          credits_charged: 0,
          usage_blocked: true,
          message: usage.message || 'A heti ingyenes Top Opportunity ajánlásod már megvan, és nincs elég kredited extra kereséshez.',
        })
      }
      if (usage.currency === 'credit') {
        // Van elég kredit, de a user MÉG NEM erősítette meg a levonást — kérjünk megerősítést,
        // ne indítsunk drága munkát, és ne vonjunk le semmit.
        return NextResponse.json({
          topics: [],
          pool_topics: [],
          cached: false,
          charged: false,
          credits_charged: 0,
          needs_confirmation: true,
          confirmation_cost: usage.cost,
          message: usage.message || `A heti ingyenes Top Opportunity ajánlásod már megvan. Ez az extra keresés ${usage.cost} kreditbe kerül.`,
        })
      }
    }

    // ── 2. Seed generation — Niche Expansion Engine ───────────
    // A niche STRATEGIAI IRANY, sose direkt kereso-query. A dinamikus
    // (AI-alapu) es a szabaly-alapu (a user sajat szoveget sablonozo,
    // hardcode-mentes) reteg egyutt adja a "szabaly + AI hibrid" seed
    // generaciot — lasd lib/niche-expansion.ts. broad_niche eseten korabban
    // az AI-motor SOSE futott le, csak a (most mar hardcode-mentes, de
    // gyengebb) szabaly-alapu expanzio — ez most mindket intent-re fut.
    const expansion = expandTopicQueries(niche, effectiveRegion, {
      creatorStyle: creator_level || '',
      maxQueries: isDrilldown ? 8 : 12,
    })

    const isSpecificTopicMode = searchMode === 'specific_topic'
    const auxiliaryAiUsage = { inputTokens: 0, outputTokens: 0, estimatedCost: 0 }
    const collectAiUsage = (usage: typeof auxiliaryAiUsage) => {
      auxiliaryAiUsage.inputTokens += usage.inputTokens
      auxiliaryAiUsage.outputTokens += usage.outputTokens
      auxiliaryAiUsage.estimatedCost += usage.estimatedCost
    }
    const nicheExpansion = isDrilldown
      ? null
      : await buildNicheExpansion({
          niche,
          main_category,
          specific_focus,
          platform,
          region: effectiveRegion,
          language: language === 'en' ? 'en' : 'hu',
          creator_profile: { audience, avoid_topics },
          channel_usage_mode: channelUsageMode,
          // specific_topic modban a topic mar kozel-direkt validacios query —
          // csak annyi kiegeszito seedet kerunk, ami a YouTube-kereseshez
          // szukseges robusztussagot adja (a nyers Serper-cimsor tul hosszu
          // ehhez, ld. lib/trend-radar.ts megjegyzese), NEM nagy niche expanziot.
          maxValidationSeeds: isSpecificTopicMode ? 3 : 12,
        })
    if (nicheExpansion?.ai_usage) collectAiUsage(nicheExpansion.ai_usage)

    const rejectedSeedTopics = nicheExpansion?.rejected_seed_topics || []

    const generatedSeeds = isDrilldown
      ? (() => {
          const drilldown = buildDrilldownSeedsForDirection(niche)
          return {
            seeds: [...new Set([...drilldown.seeds, ...expansion.queries.map(q => q.query)])].slice(0, 8),
            freshness_window_days: drilldown.freshnessWindowDays,
            category: drilldown.category,
          }
        })()
      : {
          seeds: isSpecificTopicMode
            ? [...new Set([niche, ...(nicheExpansion?.validation_seeds || [])])].slice(0, 4)
            : [...new Set([...(nicheExpansion?.validation_seeds || []), ...expansion.queries.map(q => q.query)])].slice(0, 12),
          freshness_window_days: nicheExpansion?.freshness_window_days || 120,
          category: nicheExpansion?.category || expansion.category,
        }

    const seeds = generatedSeeds.seeds
    const { freshness_window_days, category } = generatedSeeds

    console.log('[Opportunity] Query generation:', {
      search_mode: searchMode || `heuristic:${nicheIntent}`,
      original_niche: niche,
      original_topic: isSpecificTopicMode ? topic || specific_focus || null : null,
      generated_seed_topics: nicheExpansion?.seeds || [],
      rejected_seed_topics: rejectedSeedTopics,
      validation_queries: seeds,
      language: language || 'hu',
      region: effectiveRegion,
      platform: platform || 'youtube',
      niche_expansion_source: nicheExpansion?.source || (isDrilldown ? 'drilldown' : 'n/a'),
    })

    // ── 3. Trend Radar ───────────────────────────────────────
    const trendCacheKey = buildTrendCacheKey({
      niche,
      region: effectiveRegion,
      niche_intent: nicheIntent,
      discovery_mode,
      parent_niche,
    })

    // Ugyanaz a nap-váltás-tolerancia, mint az opportunity_cache-nél fentebb —
    // a trendCacheKey is tartalmaz egy dátum-bucketet, de a valódi frissesség-
    // határ az expires_at, nem a pontos kulcsegyezés.
    const trendCacheKeyPrefix = trendCacheKey.replace(/_\d{4}-\d{2}-\d{2}$/, '')
    const { data: cachedTrend, error: trendCacheReadError } = await admin
      .from('trend_candidate_cache')
      .select('candidates')
      .like('cache_key', `${trendCacheKeyPrefix}_%`)
      .gt('expires_at', new Date().toISOString())
      .order('generated_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (trendCacheReadError) throw new Error(`Trend candidate cache read failed: ${trendCacheReadError.message}`)

    let trendCandidates: TrendCandidate[]

    if (cachedTrend && !force_refresh) {
      trendCandidates = cachedTrend.candidates as TrendCandidate[]
    } else {
      if (broadDiscoveryPacks.length > 0) {
        const broadResults = await Promise.all(broadDiscoveryPacks.map(pack =>
          buildTrendCandidates({
            seeds: pack.seeds,
            category: pack.category,
            region: pack.searchRegion,
            freshnessWindowDays: pack.freshnessWindowDays,
            maxCandidates: 4,
            discoveryMode: 'evergreen_fact',
            mainCategory: main_category || '',
            specificFocus: specific_focus || '',
            language: language || 'hu',
            onAIUsage: collectAiUsage,
          })
        ))
        trendCandidates = broadResults
          .flat()
          .sort((a, b) =>
            (b.relevance_average + b.freshness_score + b.serper_evidence_count * 8 + b.youtube_relevant_videos_count * 6) -
            (a.relevance_average + a.freshness_score + a.serper_evidence_count * 8 + a.youtube_relevant_videos_count * 6)
          )
          .slice(0, 16)
      } else {
        trendCandidates = await buildTrendCandidates({
          seeds,
          category,
          region: isDrilldown && effectiveRegion === 'HU' ? 'US' : effectiveRegion,
          freshnessWindowDays: freshness_window_days,
          maxCandidates: isDrilldown ? 8 : 6,
          discoveryMode: isDrilldown ? 'evergreen_fact' : 'trend',
          mainCategory: main_category || '',
          specificFocus: specific_focus || '',
          language: language === 'en' ? 'en' : 'hu',
          onAIUsage: collectAiUsage,
        })
      }

      if (trendCandidates.length > 0) {
        const cacheHours = freshness_window_days <= 14 ? 6
          : freshness_window_days <= 30 ? 12
          : 24

        await admin.from('trend_candidate_cache').upsert({
          cache_key: trendCacheKey,
          region: effectiveRegion,
          language: language || 'hu',
          niche,
          category,
          candidates: trendCandidates,
          generated_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + cacheHours * 3600000).toISOString(),
        })
      }
    }

    console.log('[Opportunity] Validation result:', {
      search_mode: searchMode || `heuristic:${nicheIntent}`,
      original_niche: niche,
      youtube_results_count: trendCandidates.reduce((sum, c) => sum + (c.youtube_relevant_videos_count || 0), 0),
      serper_results_count: trendCandidates.reduce((sum, c) => sum + (c.serper_evidence_count || 0), 0),
      final_validated_topics: trendCandidates.length,
    })

    if (trendCandidates.length === 0) {
      const fallbackTopics = broadDiscoveryPacks.length > 0
        ? buildBroadDiscoveryFallbackTopics({ niche, platform, effectiveRegion, packs: broadDiscoveryPacks })
        : await buildResearchFallbackTopics({ niche, platform, effectiveRegion, seeds, category })

      // Ha a Serper web-evidence forrás teljesen elérhetetlen volt (pl. elfogyott
      // kredit, API hiba), ne "túl tág niche"-t írjunk — az félrevezető. Ez nem a
      // niche minőségének a hibája, hanem ideiglenes szolgáltatás-kimaradás.
      const serperHealth = getSerperHealthStatus()
      if (serperHealth.unavailable) {
        console.error(`[Opportunity] Serper unavailable (${serperHealth.failures}/${serperHealth.attempts} kérés hibázott): ${serperHealth.lastError}`)
      }

      if (!isDrilldown && fallbackTopics.length > 0) {
        const todayDate = new Date().toISOString().slice(0, 10)
        await admin.from('trend_feed_daily_snapshots').upsert({
          user_id: user.id,
          snapshot_date: todayDate,
          niche,
          topics: fallbackTopics,
        }, { onConflict: 'user_id,snapshot_date' }).then(({ error }) => {
          if (error) console.warn('[Opportunity] fallback trend_feed_daily_snapshots mentes hiba (non-blocking):', error)
        })
      }

      return NextResponse.json({
        topics: fallbackTopics,
        pool_topics: [],
        cached: false,
        charged: false,
        credits_charged: 0,
        service_status: serperHealth.unavailable ? 'web_evidence_unavailable' : 'ok',
        message: serperHealth.unavailable
          ? 'Ideiglenes szolgáltatás-kimaradás a web-forrás ellenőrzésénél. Ez nem a niche-ed hibája — próbáld újra néhány perc múlva.'
          : force_refresh
          ? 'Most nem találtunk elég erős új témát. Kreditet nem vontunk le.'
          : nicheIntent === 'broad_niche'
          ? 'Ez egy tág csatorna-niche, ezért konkrét gyártható témát kerestünk benne több kategóriában. Most csak kutatási irányt találtunk.'
          : 'Ehhez a niche-hez most nem találtunk elég friss, ellenőrzött trendet. Próbáld újra pár perc múlva, vagy válassz más megfogalmazást.',
        trend_summary: {
          category,
          freshness_window_days,
          seeds_used: broadDiscoveryPacks.length > 0 ? broadDiscoveryPacks.flatMap(pack => pack.seeds) : seeds,
          topic_expansion: expansion.queries,
          suggested_specific_topics: suggestSpecificTopics(niche),
          niche_intent: nicheIntent,
          candidates_found: 0,
          strong_signals: 0,
          early_opportunities: 0,
          fallback: true,
        },
      })
    }

    // ── 4. Creator Memory exclusions ─────────────────────────
    const { data: memoryItems, error: memoryReadError } = await admin
      .from('creator_memory')
      .select('topic, state')
      .eq('user_id', user.id)
    if (memoryReadError) throw new Error(`Creator memory read failed: ${memoryReadError.message}`)

    const completedTopics = new Set((memoryItems || []).filter(m => m.state === 'completed').map(m => m.topic.toLowerCase()))
    const rejectedTopics = new Set((memoryItems || []).filter(m => m.state === 'rejected').map(m => m.topic.toLowerCase()))

    // ── 5. Core Trust Engine evaluation ──────────────────────
    const filteredCandidates = trendCandidates.filter(c => {
      const topicLower = c.candidate_topic.toLowerCase()
      if (completedTopics.has(topicLower)) return false
      if (Array.from(rejectedTopics).some(r => topicLower.includes(r) || r.includes(c.seed_keyword.toLowerCase()))) return false
      // Force refresh esetén ne adjuk vissza ugyanazt a témát, amit épp az imént mutattunk —
      // különben a felhasználó fizet a kreditért, de vizuálisan semmi új nem történik.
      if (force_refresh && excludeTitles.length > 0 && excludeTitles.some(et => topicLower.includes(et) || et.includes(topicLower))) return false
      return true
    })

    const rejectedCandidateLog: { candidate_topic: string; reason: string }[] = []
    const evaluated: ViralCandidate[] = filteredCandidates
      .map(c => {
        const vc = evaluateCandidate(c, niche, expansion)
        if (!vc) {
          rejectedCandidateLog.push({ candidate_topic: c.candidate_topic, reason: 'no_web_or_video_sources' })
        } else if (!vc.decision.user_facing) {
          rejectedCandidateLog.push({ candidate_topic: c.candidate_topic, reason: vc.decision.final_decision })
        }
        return vc
      })
      .filter((vc): vc is ViralCandidate => vc !== null && vc.decision.user_facing)
      .sort((a, b) => b.scores.total - a.scores.total)

    if (rejectedCandidateLog.length > 0) {
      console.log('[Opportunity] Rejected candidates:', rejectedCandidateLog)
    }

    const VISIBLE_COUNT = isDrilldown ? 6 : nicheIntent === 'broad_niche' ? 8 : 4
    const visibleCandidates = evaluated.slice(0, VISIBLE_COUNT)
    const poolCandidates = evaluated.slice(VISIBLE_COUNT)

    // ── 6. Claude explanation ────────────────────────────────
    let claudeExplanations: Array<{ index: number; title: string; description: string; hook: string }> = []
    let opportunityAiCall: Awaited<ReturnType<typeof callAIProvider>> | null = null

    if (visibleCandidates.length > 0) {
      const explainPrompt = `Te egy magyar creator intelligence rendszer vagy.

CREATOR NICHE: ${niche}
RÉGIÓ: ${effectiveRegion}
GENERÁLT SEED-EK: ${seeds.join(', ')}
FRESHNESS WINDOW: ${freshness_window_days} nap

VALIDÁLT TREND CANDIDATE-EK:
${visibleCandidates.map((vc, i) => `
${i + 1}. Trend téma: "${vc.candidate_topic}"
   Trend forrás: ${vc.trend_source_type} (${vc.raw_confidence})
   Web források: ${vc.validation.valid_web_sources.length} db
   Videó források: ${vc.validation.valid_video_sources.length} db
   Opportunity Score: ${vc.scores.total}/100
   Top web: ${vc.validation.valid_web_sources.slice(0, 2).map(s => s.title).join('; ')}
   Top videók: ${vc.validation.valid_video_sources.slice(0, 2).map(v => `"${v.title}" (${v.viewCount.toLocaleString()} megtekintés)`).join('; ')}
   ${buildClaudePromptContext({ decision: vc.decision, validation: vc.validation })}
`).join('\n')}

HOOK TOPIC LOCK SZABÁLY:
- Minden hook KIZÁRÓLAG az adott candidate_topic-ról szólhat
- NE írj más témáról, más helyszínről, más eseményről
- Ha nincs elég anyag jó hookhoz, írj rövid, óvatos hookot
- A hook SOHA ne tartalmazzon olyan állítást ami nincs az adott candidate forrásaiban

VALIDÁCIÓS ÖSSZEHANGOLÁS - KÖTELEZŐ:
- Minden candidate-hez kaptál egy VALIDÁCIÓS ÖSSZEFOGLALÓ-t és VALIDÁCIÓS TÍPUS-t
- A te description-öd NEM mondhat ellent ezeknek
- Ha a validáció azt mondja nincs YouTube evidence, TE SEM állíthatod hogy YouTube-on trendel
- Ha a validáció azt mondja gyenge a webes alátámasztás, TE SEM állíthatod hogy webes forrásokkal erősen alátámasztott

FORBIDDEN CLAIMS:
- Ne állítsd YouTube-on trendel ha nincs YouTube evidence
- Ne állítsd weben trendel ha nincs Serper evidence
- Ne nevezd magyar trendnek ha csak globális evidence van
- Ne adj hozzá új forrásokat
- Ne emeld high confidence-re ha backend medium vagy low confidence-t adott

FELADAT: Minden candidate-hez írj:
1. Konkrét magyar videótéma-javaslatot (valódi videócím stílusban)
2. 1-2 mondatos magyar magyarázatot: miért trend most, mire alapozzuk
3. Konkrét hook ötletet (mivel kezdd a videót)

FONTOS:
- A videótéma (title) MINDIG magyarul legyen
- A title csak olyan konkrét állítást tartalmazhat, amely a megadott forrásokban ténylegesen szerepel
- Ne alakíts általános forrást konkrét új tudományos állítássá
- Ha a confidence low, légy óvatosabb a megfogalmazásban

KRITIKUS JSON SZABÁLYOK:
- SOHA ne használj idézőjelet a JSON string értékek BELSEJÉBEN
- Minden string érték egy soros legyen
- Csak pure JSON-t adj vissza

{
  "explanations": [
    {
      "index": 0,
      "title": "Konkrét magyar videótéma",
      "description": "1-2 mondatos magyar magyarázat",
      "hook": "Konkrét hook ötlet"
    }
  ]
}`

      const aiCall = await callAIProvider({
        model: MODELS.fast,
        maxTokens: 2000,
        messages: [{ role: 'user', content: explainPrompt }],
        promptTemplateId: 'opportunity_engine_explanations',
        promptVersion: 'v1',
      })

      const explained = extractJson<{ explanations?: typeof claudeExplanations }>(aiCall.text)
      claudeExplanations = explained.explanations || []
      opportunityAiCall = aiCall
    }

    const totalAiUsage = {
      inputTokens: auxiliaryAiUsage.inputTokens + (opportunityAiCall?.usage.inputTokens || 0),
      outputTokens: auxiliaryAiUsage.outputTokens + (opportunityAiCall?.usage.outputTokens || 0),
      estimatedCost: auxiliaryAiUsage.estimatedCost + (opportunityAiCall?.estimatedCost || 0),
    }
    if (totalAiUsage.inputTokens + totalAiUsage.outputTokens > 0) {
      await logUsage(user.id, 'opportunity_engine', MODELS.fast, totalAiUsage.inputTokens, totalAiUsage.outputTokens, { type: 'opportunity_engine_ai' })
    }

    // ── 7. Apply safe output + convert to OpportunityTopic ───
    let topics = visibleCandidates
      .map((vc, i) => {
        const claudeExp = claudeExplanations.find(e => e.index === i) || claudeExplanations[i]
        const withSafeOutput = applySafeOutput(vc, claudeExp)
        return toOpportunityTopic(withSafeOutput, { niche, platform, region: effectiveRegion })
      })

    let poolTopics = poolCandidates
      .map(vc => toOpportunityTopic(vc, { niche, platform, region: effectiveRegion, needsExplanation: true }))

    if (nicheIntent === 'broad_niche' && topics.length < 4 && broadDiscoveryPacks.length > 0) {
      const fillers = buildBroadDiscoveryFallbackTopics({
        niche,
        platform,
        effectiveRegion,
        packs: broadDiscoveryPacks,
        existingTitles: topics.map(t => t.title),
      })
      const needed = Math.max(0, 4 - topics.length)
      topics = [...topics, ...(fillers.slice(0, needed) as typeof topics)]
      poolTopics = [...poolTopics, ...(fillers.slice(needed) as typeof poolTopics)]
    }

    const validCount = topics.length
    let charged = false
    let creditsCharged = 0
    let creditTransactionId: string | undefined

    if (force_refresh && validCount > 0) {
      const charge = await chargeProtectedFeature(user.id, 'opportunity_engine', { topic: niche, engine_version: ENGINE_VERSION })
      if (!charge.success) {
        return NextResponse.json({
          topics: [],
          pool_topics: [],
          cached: false,
          charged: false,
          credits_charged: 0,
          usage_blocked: true,
          message: charge.error || 'Nincs elég kredited ehhez az extra Opportunity kereséshez.',
        }, { status: 402 })
      }
      charged = true
      creditsCharged = 2
      creditTransactionId = charge.credit_transaction_id
    } else if (!force_refresh && validCount > 0) {
      // Ingyenes heti kvotabol futott (friss generalas, nem cache-hit) - nincs
      // kredit levonás, de a "Legutóbbi történeted" panelen meg kell jelennie.
      await logFreeProductUse(user.id, 'opportunity_engine', { topic: niche }).catch(() => {})
    }

    // Magas confidence / magas score / friss trend topicokat limitáltan trackeljük
    // (háttérfrissítés célra) — a gatekeeper (isTrackWorthy) dönti el, melyik éri meg.
    // Hiba esetén nem törheti el a fő választ.
    await Promise.all(
      topics.map(t => promoteToTrackedCandidate({
        userId: user.id,
        candidateTopic: t.title,
        niche,
        region: effectiveRegion,
        language,
        trendSourceType: t.trend_source_type || null,
        confidence: t.confidence || null,
        opportunityScore: t.opportunity_score,
        youtubeVideoIds: (t.evidence_videos || []).map(v => v.video_id).filter(Boolean),
        webSourceIds: (t.web_sources || []).map(s => ({
          title: s.title,
          url: s.url,
          snippet: s.snippet,
          source: s.source,
          date: s.date,
        })).filter(s => !!s.url),
        generatedAt: t.generated_at,
      }).catch(() => {}))
    )

    // ── 8. Cache save ────────────────────────────────────────
    const now = new Date().toISOString()
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

    await admin.from('opportunity_cache').upsert({
      cache_key: oppCacheKey,
      topics: [...topics, ...poolTopics],
      generated_at: now,
      expires_at: expires,
      generated_by: user.id,
    })

    await logYouTubeSearch({
      userId: user.id,
      featureName: 'opportunity_engine',
      query: niche,
      searchCount: trendCandidates.length,
      wasCached: false,
      planType: 'beta',
    }).catch(() => {})

    // Trend Feed snapshot mentese - hogy a user vissza tudja nezni a
    // korabbi ajanlast is, ne csak a legutobbi cache-t.
    if (!isDrilldown && validCount > 0) {
      const todayDate = new Date().toISOString().slice(0, 10)
      await admin.from('trend_feed_daily_snapshots').upsert({
        user_id: user.id,
        snapshot_date: todayDate,
        niche,
        topics,
      }, { onConflict: 'user_id,snapshot_date' }).then(({ error }) => {
        if (error) console.warn('[Opportunity] trend_feed_daily_snapshots mentés hiba (non-blocking):', error)
      })
    }

    const messageText = isDrilldown
      ? (validCount === 0
          ? 'Ebben a kutatási irányban most nem találtunk elég erős, forrással validált konkrét témát.'
          : 'A kutatási irányból konkrétabb, ellenőrzött témákat kerestünk.')
      : validCount === 0
      ? (nicheIntent === 'broad_niche'
          ? 'A tág niche-t több konkrét irányra bontottuk, de most nincs elég erős gyártható téma.'
          : 'Most nincs elég erős validált téma ebben a kategóriában.')
      : nicheIntent === 'broad_niche'
      ? 'A tág niche-t konkrét kategóriákra bontottuk. A validált témák elöl vannak.'
      : validCount < 3
      ? `Most ${validCount} erős témát találtunk. A többit kiszűrtük.`
      : undefined

    const responsePayload = {
      topics,
      pool_topics: poolTopics,
      cached: false,
      charged,
      credits_charged: creditsCharged,
      message: force_refresh && validCount === 0
        ? 'Most nem találtunk elég erős új témát. Kreditet nem vontunk le.'
        : messageText,
      search_mode: searchMode || null,
      search_directions: broadDiscoveryPacks.length > 0 ? [...new Set(broadDiscoveryPacks.flatMap(pack => pack.seeds))] : seeds,
      trend_summary: {
        category,
        freshness_window_days,
        seeds_used: broadDiscoveryPacks.length > 0 ? broadDiscoveryPacks.flatMap(pack => pack.seeds) : seeds,
        topic_expansion: expansion.queries,
        suggested_specific_topics: suggestSpecificTopics(niche),
        niche_intent: nicheIntent,
        candidates_found: trendCandidates.length,
        strong_signals: trendCandidates.filter(c => c.trend_source_type === 'serper_youtube').length,
        early_opportunities: trendCandidates.filter(c => c.trend_source_type === 'serper_only').length,
      },
    }

    let savedPaidResultId: string | null = null
    if (validCount > 0) {
      const paidSave = await savePaidResult({
        userId: user.id,
        toolType: 'opportunity_engine',
        inputHash: paidInputHash,
        normalizedInput: paidNormalizedInput,
        originalInput: niche,
        mainCategory: main_category || null,
        specificFocus: specific_focus || null,
        region: effectiveRegion,
        language: language || null,
        platform: platform || 'youtube',
        resultJson: responsePayload,
        summaryJson: { topic_count: topics.length, pool_count: poolTopics.length, niche },
        creditCost: creditsCharged,
        freshForHours: 24,
        // opportunityAiCall csak akkor van kitoltve, ha ebben a futasban tenyleg
        // volt magyarazo Claude-hivas (visibleCandidates.length > 0) — cache-talalat
        // vagy nulla validalt candidate eseten nincs megbizhato provider/model adat.
        ...(opportunityAiCall ? {
          provider: opportunityAiCall.provider,
          model: opportunityAiCall.model,
          promptTemplateId: opportunityAiCall.promptTemplateId,
          promptVersion: opportunityAiCall.promptVersion,
          estimatedCost: totalAiUsage.estimatedCost,
        } : {}),
      })
      if (!paidSave.success) {
        console.error('[Opportunity] KRITIKUS: paid_results mentés sikertelen:', paidSave.error)
        if (creditsCharged > 0) {
          const refund = await refundCreditsAfterPersistenceFailure(user.id, 'opportunity_engine', creditsCharged, { reason: 'paid_result_save_failed' }, creditTransactionId)
          if (!refund.success) console.error('[Opportunity] KRITIKUS: automatikus kredit-visszatérítés sikertelen')
          return NextResponse.json({ error: refund.success ? 'Az eredmény mentése sikertelen volt, a kreditet visszaadtuk.' : 'Az eredmény mentése és a kredit-visszatérítés sikertelen. Az esetet naplóztuk.' }, { status: 500 })
        }
        return NextResponse.json({ error: 'Az ingyenes eredmény mentése sikertelen volt. Próbáld újra.' }, { status: 500 })
      }
      savedPaidResultId = paidSave.record?.id || null
    }

    return NextResponse.json({
      ...responsePayload,
      from_paid_result: false,
      cache_status: 'fresh',
      requires_credit: creditsCharged > 0,
      paid_result_id: savedPaidResultId,
    })
    } finally {
      await releaseRequestLock(lock.lockId)
    }
  } catch (error) {
    console.error('Opportunity Engine error:', error)
    return NextResponse.json({ error: 'Generálás sikertelen. Próbáld újra.', charged: false, credits_charged: 0 }, { status: 500 })
  }
}
