// app/api/opportunity/route.ts
// WillViral — Opportunity Engine v4 (Core Trust Engine)

import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { MODELS } from '@/lib/models'
import { createServerSupabaseClient, createAdminClient } from '@/lib/supabase-server'
import {
  buildTrendCandidates,
  type TrendCandidate,
} from '@/lib/trend-radar'
import { generateSeedsForNiche } from '@/lib/seed-generator'
import { expandTopicQueries, suggestSpecificTopics, recommendedAngleForExpansion, recommendedFormatForExpansion, hookPatternForExpansion } from '@/lib/topic-expansion'
import { detectNicheIntent, buildBroadNicheDiscoveryPacks, buildDrilldownSeedsForDirection } from '@/lib/broad-niche-discovery'
import type { OpportunityTopic } from '@/types'
import { logYouTubeSearch } from '@/lib/usage-protection'
import {
  evaluateCandidate,
  applySafeOutput,
  toOpportunityTopic,
  buildClaudePromptContext,
  ENGINE_VERSION,
  type ViralCandidate,
} from '@/lib/core-trust-engine'
import { buildCacheKey, buildTrendCacheKey } from '@/lib/core-trust-engine/cache'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

function extractJson(text: string): unknown {
  let cleaned = text.replace(/```json|```/g, '').trim()
  const firstBrace = cleaned.indexOf('{')
  const lastBrace = cleaned.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1)
  }
  try { return JSON.parse(cleaned) }
  catch (e) { console.error('JSON parse failed:', cleaned.slice(0, 1500)); throw e }
}

// ── Fallback topic builders (research lanes, broad discovery) ────

const RESEARCH_LANE_MAP: Record<string, Array<{ title: string; description: string; keyword: string }>> = {
  'tudomany': [
    { title: 'Friss tudományos felfedezések', description: 'Új kutatások és tudományos áttörések, amelyekből magyarázó vagy figyelemfelkeltő videók készülhetnek.', keyword: 'new science discovery explained' },
    { title: 'AI és technológiai áttörések', description: 'Mesterséges intelligencia és technológiai újdonságok, amelyek világszerte hatást gyakorolnak.', keyword: 'AI breakthrough technology new' },
  ],
  'erdekesseg': [
    { title: 'Furcsa emberi test jelenségek', description: 'Meglepő, tudományosan magyarázható testi jelenségek erős kíváncsiság-hookhoz.', keyword: 'weird human body facts science' },
    { title: 'Tudományosan magyarázható furcsaságok', description: 'Hétköznapi jelenségek mögötti meglepő tudományos magyarázatok.', keyword: 'science explains everyday mystery' },
  ],
  'hir': [
    { title: 'Aktuális világhírek magyarázattal', description: 'Friss hírek és események, amelyeket értelmező videóban fel lehet dolgozni.', keyword: 'latest world news explained' },
    { title: 'Magyar vonatkozású nemzetközi hírek', description: 'Nemzetközi események magyar perspektívából, amelyek relevánsak a magyar közönségnek.', keyword: 'hungary international news' },
  ],
  'egeszseg': [
    { title: 'Friss egészségügyi felfedezések', description: 'Új kutatások, orvosi hírek és egészségügyi áttörések, amelyekből magyarázó videó készülhet.', keyword: 'new health discovery research' },
    { title: 'Alvás, táplálkozás és életmód kutatások', description: 'Friss tudományos eredmények a hétköznapi egészség témakörében.', keyword: 'sleep nutrition research new study' },
  ],
  'pszichologia': [
    { title: 'Pszichológiai kísérletek és viselkedés', description: 'Emberi döntések, észlelési hibák, agyi jelenségek és társas viselkedés.', keyword: 'psychology experiment behavior' },
  ],
  'ur': [
    { title: 'Űrkutatás és kozmikus jelenségek', description: 'Friss űrhírek, égitestek, NASA/ESA fejlemények és látványos magyarázható témák.', keyword: 'space discovery NASA new' },
  ],
  'tortenelem': [
    { title: 'Rejtélyes történelmi események', description: 'Meglepő történelmi tények és felfedezések, amelyek erős sztorielemeket tartalmaznak.', keyword: 'mysterious history discovery' },
  ],
  'sport': [
    { title: 'Sportesemények és meglepetések', description: 'Aktuális sportesemények, meglepő eredmények és sportolói sztorik.', keyword: 'sports news surprise event' },
  ],
  'tech': [
    { title: 'Új technológiák és gadgetek', description: 'Friss tech termékek, appok és innovációk, amelyek érdeklik a közönséget.', keyword: 'new technology gadget innovation' },
  ],
  'motivacio': [
    { title: 'Önfejlesztés és motiváció', description: 'Hatékony szokások, sikersztorik és tudományosan alátámasztott fejlődési stratégiák.', keyword: 'self improvement motivation habits' },
  ],
  'gasztro': [
    { title: 'Receptek és konyhai trendek', description: 'Virális receptek, konyhai tippek és étkezési trendek.', keyword: 'viral recipe cooking trend' },
  ],
  'film': [
    { title: 'Filmek és sorozatok elemzése', description: 'Új megjelenések, rejtett részletek és filmelméletek.', keyword: 'movie review explained new' },
  ],
  'gaming': [
    { title: 'Játékmegjelenések és gaming hírek', description: 'Új játékok, frissítések és gaming közösségi trendek.', keyword: 'new game release gaming news' },
  ],
}

function decomposeNicheToLanes(niche: string): Array<{ title: string; description: string; keyword: string; category: string }> {
  const categories = niche.split(/[,;\/]+/).map(s => s.trim().toLowerCase()).filter(s => s.length > 1)
  const lanes: Array<{ title: string; description: string; keyword: string; category: string }> = []

  for (const cat of categories) {
    const normalized = cat.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s]/g, '').trim()
    let matched = false
    for (const [key, entries] of Object.entries(RESEARCH_LANE_MAP)) {
      if (normalized.includes(key) || key.includes(normalized.slice(0, 5))) {
        for (const entry of entries) {
          if (!lanes.some(l => l.title === entry.title)) {
            lanes.push({ ...entry, category: cat })
          }
        }
        matched = true
        break
      }
    }
    if (!matched) {
      lanes.push({
        title: `${cat.charAt(0).toUpperCase() + cat.slice(1)} — friss temak`,
        description: `Aktualis ${cat} temak es trendek, amelyekbol videoterv keszulhet.`,
        keyword: cat,
        category: cat,
      })
    }
  }

  return lanes.slice(0, 8)
}

function buildResearchFallbackTopics(params: {
  niche: string
  platform?: string
  effectiveRegion: 'HU' | 'US'
  seeds: string[]
  category: string
}) {
  const { niche, platform, effectiveRegion, category } = params
  const now = new Date().toISOString()
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

  const lanes = decomposeNicheToLanes(niche)
  const ideas = lanes.length > 0 ? lanes : [{ title: `${niche} — kutatasi irany`, description: 'A niche-hez most nem talaltunk eleg friss trendet. Keress konkretabb temat.', keyword: niche, category }]

  return ideas.map((lane, index) => ({
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
    ready_to_produce_label: 'Kutatás kell',
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
  packs: ReturnType<typeof buildBroadNicheDiscoveryPacks>
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
      evidence_match_score: 35,
      risk_flags: ['További validálás kell', 'Még nincs elég konkrét bizonyíték'],
      decision_score: 35,
      needs_explanation: false,
      engine_version: ENGINE_VERSION,
    }))
}

// ── Main handler ─────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const niche = (body.niche || '').replace(/[,;\s]+$/, '').trim()
    const { platform, language, region, creator_level, discovery_mode, parent_niche, cache_only, force_refresh } = body
    if (!niche) return NextResponse.json({ error: 'Niche megadása kötelező' }, { status: 400 })

    const supabase = createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const admin = createAdminClient()

    const effectiveRegion: 'HU' | 'US' = region === 'HU' ? 'HU' : 'US'
    const isDrilldown = discovery_mode === 'drilldown'
    const nicheIntent = isDrilldown ? 'specific_topic' : detectNicheIntent(niche)
    const broadDiscoveryPacks = !isDrilldown && nicheIntent === 'broad_niche'
      ? buildBroadNicheDiscoveryPacks(niche, effectiveRegion)
      : []

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

    const { data: oppCached } = await admin
      .from('opportunity_cache')
      .select('*')
      .eq('cache_key', oppCacheKey)
      .gt('expires_at', new Date().toISOString())
      .single()

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
      return NextResponse.json({
        topics: [],
        pool_topics: [],
        cached: false,
        message: 'A trendadatok frissitese folyamatban van. Kattints a Lehetosegek gombra a friss kereseshez.',
      })
    }

    // ── 2. Seed generation ───────────────────────────────────
    const expansion = expandTopicQueries(niche, effectiveRegion, {
      creatorStyle: creator_level || '',
      maxQueries: isDrilldown ? 8 : 12,
    })

    const generatedSeeds = isDrilldown
      ? (() => {
          const drilldown = buildDrilldownSeedsForDirection(niche)
          return {
            seeds: [...new Set([...drilldown.seeds, ...expansion.queries.map(q => q.query)])].slice(0, 8),
            freshness_window_days: drilldown.freshnessWindowDays,
            category: drilldown.category,
          }
        })()
      : nicheIntent === 'broad_niche' && broadDiscoveryPacks.length > 0
        ? {
            seeds: expansion.queries.map(q => q.query).slice(0, 8),
            freshness_window_days: 180,
            category: expansion.category,
          }
        : await generateSeedsForNiche(niche, effectiveRegion, 5)

    const seeds = nicheIntent === 'specific_topic' && !isDrilldown
      ? [...new Set([...expansion.queries.map(q => q.query), ...generatedSeeds.seeds])].slice(0, 12)
      : generatedSeeds.seeds
    const { freshness_window_days, category } = generatedSeeds

    console.log(`[Opportunity] Niche: "${niche}" | Intent: ${nicheIntent} | Seeds: ${seeds.join(', ')} | Freshness: ${freshness_window_days}d | Category: ${category}`)

    // ── 3. Trend Radar ───────────────────────────────────────
    const trendCacheKey = buildTrendCacheKey({
      niche,
      region: effectiveRegion,
      niche_intent: nicheIntent,
      discovery_mode,
      parent_niche,
    })

    const { data: cachedTrend } = await admin
      .from('trend_candidate_cache')
      .select('candidates')
      .eq('cache_key', trendCacheKey)
      .gt('expires_at', new Date().toISOString())
      .single()

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

    if (trendCandidates.length === 0) {
      const fallbackTopics = broadDiscoveryPacks.length > 0
        ? buildBroadDiscoveryFallbackTopics({ niche, platform, effectiveRegion, packs: broadDiscoveryPacks })
        : buildResearchFallbackTopics({ niche, platform, effectiveRegion, seeds, category })

      return NextResponse.json({
        topics: fallbackTopics,
        pool_topics: [],
        cached: false,
        charged: false,
        credits_charged: 0,
        message: force_refresh
          ? 'Most nem találtunk elég erős új témát. Kreditet nem vontunk le.'
          : nicheIntent === 'broad_niche'
          ? 'Ez egy tág csatorna-niche, ezért konkrét gyártható témát kerestünk benne több kategóriában. Most csak kutatási irányt találtunk.'
          : niche.includes(',')
          ? 'Ez a niche túl tág ahhoz, hogy egyetlen pontos témát ajánljunk. Bontottunk belőle néhány kutatási irányt.'
          : 'Ehhez a niche-hez most nem találtunk elég friss, ellenőrzött trendet.',
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
    const { data: memoryItems } = await admin
      .from('creator_memory')
      .select('topic, state')
      .eq('user_id', user.id)

    const completedTopics = new Set((memoryItems || []).filter(m => m.state === 'completed').map(m => m.topic.toLowerCase()))
    const rejectedTopics = new Set((memoryItems || []).filter(m => m.state === 'rejected').map(m => m.topic.toLowerCase()))

    // ── 5. Core Trust Engine evaluation ──────────────────────
    const filteredCandidates = trendCandidates.filter(c => {
      const topicLower = c.candidate_topic.toLowerCase()
      if (completedTopics.has(topicLower)) return false
      if (Array.from(rejectedTopics).some(r => topicLower.includes(r) || r.includes(c.seed_keyword.toLowerCase()))) return false
      return true
    })

    const evaluated: ViralCandidate[] = filteredCandidates
      .map(c => evaluateCandidate(c, niche, expansion))
      .filter((vc): vc is ViralCandidate => vc !== null && vc.decision.user_facing)
      .sort((a, b) => b.scores.total - a.scores.total)

    const VISIBLE_COUNT = isDrilldown ? 6 : nicheIntent === 'broad_niche' ? 8 : 4
    const visibleCandidates = evaluated.slice(0, VISIBLE_COUNT)
    const poolCandidates = evaluated.slice(VISIBLE_COUNT)

    // ── 6. Claude explanation ────────────────────────────────
    let claudeExplanations: Array<{ index: number; title: string; description: string; hook: string }> = []

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

      const message = await anthropic.messages.create({
        model: MODELS.fast,
        max_tokens: 2000,
        messages: [{ role: 'user', content: explainPrompt }],
      })

      const responseText = message.content.filter(b => b.type === 'text').map(b => (b as { type: 'text'; text: string }).text).join('')
      const explained = extractJson(responseText) as { explanations?: typeof claudeExplanations }
      claudeExplanations = explained.explanations || []
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

    // ── 9. Credit charging ───────────────────────────────────
    const validCount = topics.length
    let charged = false
    let creditsCharged = 0

    if (force_refresh && validCount > 0) {
      const { data: credits } = await admin.from('user_credits').select('balance, total_used').eq('user_id', user.id).single()
      if (credits && Number(credits.balance) >= 2) {
        await admin.from('user_credits').update({
          balance: Number(credits.balance) - 2,
          total_used: Number(credits.total_used) + 2,
        }).eq('user_id', user.id)
        await admin.from('ai_usage_logs').insert({
          user_id: user.id, feature_name: 'trend_feed_refresh', model: 'youtube_search',
          input_tokens: 0, output_tokens: 0, estimated_cost_usd: 0, credits_charged: 2,
          metadata: { type: 'trend_feed_manual_refresh', niche, engine_version: ENGINE_VERSION },
        })
        charged = true
        creditsCharged = 2
      }
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

    return NextResponse.json({
      topics,
      pool_topics: poolTopics,
      cached: false,
      charged,
      credits_charged: creditsCharged,
      message: force_refresh && validCount === 0
        ? 'Most nem találtunk elég erős új témát. Kreditet nem vontunk le.'
        : messageText,
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
    })
  } catch (error) {
    console.error('Opportunity Engine error:', error)
    return NextResponse.json({ error: 'Generálás sikertelen. Próbáld újra.', charged: false, credits_charged: 0 }, { status: 500 })
  }
}
