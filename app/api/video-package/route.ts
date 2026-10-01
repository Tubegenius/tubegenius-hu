import { NextRequest, NextResponse } from 'next/server'
import { MODELS } from '@/lib/models'
import { getUserId, checkPaidFeatureAccess, chargeFeature, logUsage, CREDIT_COSTS, refundCreditsAfterPersistenceFailure } from '@/lib/credits'
import { dailySoftLimitError } from '@/lib/daily-soft-limit'
import { buildPaidResultHash, normalizePaidResultInput, savePaidResult, getPaidResultByHash, getPaidResultById, openPaidResult, paidResultResponseMeta } from '@/lib/paid-results/paid-results-service'
import { polishHungarianOutput } from '@/lib/hungarian-output-polish'
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
import { acquireRequestLock, releaseRequestLock, REQUEST_IN_PROGRESS_ERROR } from '@/lib/request-lock'
import { createAdminClient } from '@/lib/supabase-server'
import { getOpportunityEvidenceSnapshot, verifyOwnVideoIdea } from '@/lib/opportunity-evidence/evidence-service'
import { resolveCreatorNicheContext } from '@/lib/creator-profile-context'
import {
  STYLE_PROMPTS,
  getShortsTarget,
  getLongTarget,
  getUploadTimes,
  generateCreativeCore,
  generatePackaging,
  extractPlatformChecklist,
  hasTimeBudgetForPackaging,
  hasTimeBudgetForChargeAndSave,
} from '@/lib/video-package'
import { isJsonWithinLimit, isPlainRecord, topicInputTooLong, topicTooLongResponseMessage } from '@/lib/api-input-validation'

interface PackageSource {
  title: string; url?: string; snippet?: string; source?: string
  video_id?: string; channel_title?: string; thumbnail_url?: string
  view_count?: number; like_count?: number; comment_count?: number; published_at?: string
}
interface PackageSourceVideo { video_id?: string; id?: string; url?: string; title?: string; channel?: string; hook?: string; key_points?: string[]; transcript_available?: boolean; raw_transcript?: string }
interface PackageOpportunityContext { id?: string; title?: string; ready_to_produce_status?: string; ready_to_produce_label?: string; confidence?: string; opportunity_score?: number; risk_flags?: unknown[] }
interface VideoPackageRequestBody {
  topic?: string; platform?: string; video_length?: string; narration_style?: string; intensity?: string; goal?: string
  custom_prompt?: string; niche?: string; channel_context?: string; language?: string; fact_block?: string
  sources?: PackageSource[]; web_sources?: PackageSource[]; youtube_sources?: PackageSource[]
  source_video?: PackageSourceVideo; opportunity_context?: PackageOpportunityContext
  // Owner-scoped server resolution overrides opportunity_context/web_sources/
  // youtube_sources below when present and a snapshot exists -- see the
  // resolution block right after auth. Never trust the client's own
  // opportunity_context/web_sources/youtube_sources over this when it's set.
  video_idea_id?: string
}

export async function POST(request: NextRequest) {
  // Remaining-time guard reference point -- see hasTimeBudgetForPackaging/
  // hasTimeBudgetForChargeAndSave in lib/video-package.ts for why this is
  // measured from here, not from the AI calls themselves.
  const routeStartedAt = Date.now()
  try {
    const parsedBody: unknown = await request.json().catch(() => null)
    if (!isPlainRecord(parsedBody) || !isJsonWithinLimit(parsedBody, 100_000)) return NextResponse.json({ error: 'Érvénytelen vagy túl nagy kérés.' }, { status: 400 })
    const textFields = ['topic', 'platform', 'video_length', 'narration_style', 'intensity', 'goal', 'custom_prompt', 'niche', 'channel_context', 'language', 'fact_block']
    if (textFields.some(key => parsedBody[key] !== undefined && parsedBody[key] !== null && typeof parsedBody[key] !== 'string')) return NextResponse.json({ error: 'Érvénytelen szöveges mező.' }, { status: 400 })
    const {
      topic, platform, video_length, narration_style, intensity, goal,
      custom_prompt, niche, channel_context, language, fact_block, sources,
      web_sources, youtube_sources, source_video, opportunity_context, video_idea_id,
    } = parsedBody as VideoPackageRequestBody
    if (video_idea_id !== undefined && (typeof video_idea_id !== 'string' || !video_idea_id)) return NextResponse.json({ error: 'Érvénytelen videóötlet-azonosító.' }, { status: 400 })

    if (!topic || typeof topic !== 'string' || !topic.trim()) return NextResponse.json({ error: 'Téma megadása kötelező' }, { status: 400 })
    if (topicInputTooLong(topic)) return NextResponse.json({ error: topicTooLongResponseMessage() }, { status: 400 })
    const allowedPlatforms = ['youtube_shorts', 'youtube_long', 'youtube', 'tiktok', 'instagram_reels', 'facebook_reels']
    const allowedStyles = Object.keys(STYLE_PROMPTS)
    if (typeof platform !== 'string' || typeof video_length !== 'string' || typeof narration_style !== 'string' || typeof intensity !== 'string' || typeof goal !== 'string' || !allowedPlatforms.includes(platform) || !allowedStyles.includes(narration_style) || !['light', 'classic', 'extreme'].includes(intensity) || !['views', 'comments', 'shares', 'saves', 'subscribers', 'affiliate'].includes(goal)) return NextResponse.json({ error: 'Érvénytelen videóbeállítás.' }, { status: 400 })
    if (typeof custom_prompt === 'string' && custom_prompt.length > 2000) return NextResponse.json({ error: 'Az egyéni prompt túl hosszú.' }, { status: 400 })
    if (opportunity_context !== undefined && !isPlainRecord(opportunity_context)) return NextResponse.json({ error: 'Érvénytelen Opportunity kontextus.' }, { status: 400 })
    if (['sources', 'web_sources', 'youtube_sources'].some(key => parsedBody[key] !== undefined && (!Array.isArray(parsedBody[key]) || (parsedBody[key] as unknown[]).length > 20))) return NextResponse.json({ error: 'Érvénytelen vagy túl nagy forráslista.' }, { status: 400 })
    for (const key of ['sources', 'web_sources', 'youtube_sources']) {
      const items = parsedBody[key]
      if (Array.isArray(items) && items.some(item => !isPlainRecord(item) || typeof item.title !== 'string' || item.title.length > 500 || (item.url !== undefined && typeof item.url !== 'string') || (item.snippet !== undefined && (typeof item.snippet !== 'string' || item.snippet.length > 5000)))) return NextResponse.json({ error: 'Érvénytelen forrásadat.' }, { status: 400 })
    }

    if (opportunity_context?.ready_to_produce_status === 'rejected') {
      return NextResponse.json({
        error: 'opportunity_rejected',
        message: 'Ez az Opportunity téma nem ajánlott gyártásra. Válassz másik témát vagy futtass új validálást.',
      }, { status: 422 })
    }

    const isShorts = ['youtube_shorts', 'tiktok', 'instagram_reels', 'facebook_reels'].includes(platform)
    const feature = isShorts ? 'video_package_shorts' : 'video_package_long'

    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    // Owner-scoped, server-side evidence resolution -- when video_idea_id is
    // present and a snapshot exists for it, this OVERRIDES whatever
    // opportunity_context/web_sources/youtube_sources the client sent for
    // THOSE three fields specifically (never trusted from the client once a
    // resolvable snapshot exists). Falls back to the client-supplied values
    // unchanged when there's no video_idea_id or no snapshot for it -- this
    // preserves the existing behaviour for the source_video-only flow and
    // for pre-migration/snapshot-less saved ideas (see evidence-service.ts).
    let resolvedOpportunityContext: PackageOpportunityContext | undefined = opportunity_context
    let resolvedWebSources: PackageSource[] = web_sources || []
    let resolvedYoutubeSources: PackageSource[] = youtube_sources || []
    let opportunityEvidenceSource: 'server_snapshot' | 'client_supplied' | 'none' = opportunity_context ? 'client_supplied' : 'none'
    let opportunityEvidenceCapturedAt: string | null = null
    if (video_idea_id) {
      const evidenceAdmin = createAdminClient()
      // Ownership gate BEFORE anything else -- a foreign or non-existent
      // video_idea_id must fail closed here, strictly before the request
      // lock, checkPaidFeatureAccess, chargeFeature or any AI provider call
      // below. getOpportunityEvidenceSnapshot() alone cannot distinguish
      // "my own idea, no snapshot yet" from "not mine/doesn't exist" (both
      // read as null, correctly, for a passive read) -- this is the writer-
      // side check that makes the distinction, per verifyOwnVideoIdea()'s
      // own documented rationale.
      const owns = await verifyOwnVideoIdea(evidenceAdmin, { userId, videoIdeaId: video_idea_id })
      if (!owns) {
        return NextResponse.json({ error: 'A megadott videóötlet nem található vagy nem hozzáférhető.' }, { status: 404 })
      }
      const snapshot = await getOpportunityEvidenceSnapshot(evidenceAdmin, { userId, videoIdeaId: video_idea_id })
      if (snapshot) {
        resolvedOpportunityContext = {
          id: video_idea_id,
          title: snapshot.title,
          confidence: snapshot.confidence || undefined,
          opportunity_score: snapshot.opportunity_score ?? undefined,
          risk_flags: Array.isArray(snapshot.risk_flags) ? snapshot.risk_flags : [],
        }
        resolvedWebSources = Array.isArray(snapshot.web_sources) ? snapshot.web_sources as PackageSource[] : []
        resolvedYoutubeSources = Array.isArray(snapshot.evidence_videos) ? snapshot.evidence_videos as PackageSource[] : []
        opportunityEvidenceSource = 'server_snapshot'
        opportunityEvidenceCapturedAt = snapshot.captured_at
      }
      // video_idea_id given but no snapshot found: this is the explicit
      // "old/snapshot-less idea, continue without evidence" case -- the
      // resolved_* variables stay at their client-supplied fallback (set
      // above), never a fabricated snapshot.
    }

    const sourceVideoKey = source_video?.video_id || source_video?.id || source_video?.url || null
    const opportunityKey = resolvedOpportunityContext?.id || resolvedOpportunityContext?.title || null
    const normalizedInput = normalizePaidResultInput({
      topic,
      platform,
      video_length,
      narration_style,
      source_video_id: sourceVideoKey,
      opportunity_id: opportunityKey,
      fact_block: fact_block || null,
    })
    const inputHash = buildPaidResultHash({
      userId,
      toolType: 'video_package',
      normalizedInput,
      region: language || null,
      language: language || null,
      platform: platform || null,
    })
    const legacyNormalizedInput = normalizePaidResultInput({ topic, platform, video_length, narration_style, source_video_id: source_video?.video_id || null })
    const legacyInputHash = buildPaidResultHash({
      userId,
      toolType: 'video_package',
      normalizedInput: legacyNormalizedInput,
      region: language || null,
      language: language || null,
      platform: platform || null,
    })
    const lock = await acquireRequestLock({ userId, toolType: 'video_package', inputHash })
    if (!lock.acquired) {
      return NextResponse.json({ error: REQUEST_IN_PROGRESS_ERROR }, { status: 409 })
    }

    try {
    const paid = await getPaidResultByHash({ userId, toolType: 'video_package', inputHash })
      || (legacyInputHash !== inputHash
        ? await getPaidResultByHash({ userId, toolType: 'video_package', inputHash: legacyInputHash })
        : null)
    if (paid) {
      const opened = await openPaidResult(paid)
      const polishedResult = polishHungarianOutput(opened.result_json) as Record<string, unknown>
      const { _credits_remaining: _historicalCreditBalance, ...reopenableResult } = polishedResult
      return NextResponse.json({
        ...reopenableResult,
        ...paidResultResponseMeta(opened),
      })
    }

    const access = await checkPaidFeatureAccess(userId, feature, request.headers.get('x-daily-soft-limit-override') === 'true')
    if (access.reason === 'daily_soft_limit' && access.dailyLimit) return NextResponse.json(dailySoftLimitError(access.dailyLimit), { status: 429 })
    if (!access.allowed) {
      return NextResponse.json({ error: `Nincs elég kredited. Ehhez ${CREDIT_COSTS[feature]} kredit szükséges.` }, { status: 402 })
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
    const webSourceItems = resolvedWebSources
    const youtubeSourceItems = resolvedYoutubeSources
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
      ...(sourceVideoSnippet ? [{ title: `Source video transcript: ${source_video?.title || topic}`, url: source_video?.url, snippet: sourceVideoSnippet, source: 'source_video_transcript' }] : []),
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

    // Quality status
    const qualityStatus = determineQualityStatus(factBlock, contentType)

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
    // A kliens altal kifejezetten kuldott channel_context/niche tovabbra is
    // elsobbseget elvez (mar korabban is igy volt) — csak akkor esunk vissza
    // a profilra, ha EGYIK sincs megadva, es azt is a megosztott relevancia-
    // kapun (stats_only-tudatos) engedjuk csak at, sose nyersen.
    let creatorContext = channel_context || niche || ''
    if (!creatorContext) {
      const { data: profileRow, error: profileError } = await createAdminClient().from('profiles').select('niche, main_category, specific_focus, channel_usage_mode').eq('user_id', userId).maybeSingle()
      if (profileError) throw new Error(`Video Package profile read failed: ${profileError.message}`)
      const gated = resolveCreatorNicheContext({ topic, channelUsageMode: profileRow?.channel_usage_mode, niche: profileRow?.niche, mainCategory: profileRow?.main_category, specificFocus: profileRow?.specific_focus })
      creatorContext = gated.useNiche ? gated.niche : ''
    }
    const uploadTimes = getUploadTimes(platform)

    const opportunitySection = resolvedOpportunityContext
      ? `\nOPPORTUNITY_CONTEXT:\nStatus: ${resolvedOpportunityContext.ready_to_produce_label || resolvedOpportunityContext.ready_to_produce_status || 'unknown'}\nConfidence: ${resolvedOpportunityContext.confidence || 'unknown'}\nOpportunity score: ${resolvedOpportunityContext.opportunity_score || 'unknown'}\nRisk flags: ${Array.isArray(resolvedOpportunityContext.risk_flags) ? resolvedOpportunityContext.risk_flags.slice(0, 10).map(String).join(' | ') || 'none' : 'none'}\nAz OPPORTUNITY_CONTEXT csak strategiai priorizalasi metaadat, NEM tenyforras. Konkret allitast kizarolag a VERIFIED_FACT_BLOCK tamaszthat ala.`
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
      topic, isShorts, t, arc, niche: creatorContext, stylePrompt,
      intensity: final_intensity, goal, factSection, factSafetyRules,
      platform, videoLength: video_length, narrationStyle: narration_style,
      contentType, strictFactMode, sourceVideoMode,
    })

    // Usage logging is unconditional from here on, independent of whether
    // we go on to charge/save below -- the provider tokens were genuinely
    // spent, so the measurement must never be lost just because a later
    // remaining-time guard decides not to proceed (see guards below).
    await logUsage(userId, feature, MODELS.primary, coreResult.inputTokens, coreResult.outputTokens, { topic, platform, video_length, sub_step: 'core', content_type: contentType })

    const elapsedBeforePackagingMs = Date.now() - routeStartedAt
    if (!hasTimeBudgetForPackaging(elapsedBeforePackagingMs)) {
      console.error(`[VideoPackage] Hátralévőidő-védelem: packaging indítása előtt nincs elegendő biztonságos tartalék (eltelt=${elapsedBeforePackagingMs}ms). Nincs levonás, nincs mentés, nincs automatikus retry.`)
      return NextResponse.json({ error: 'A generálás a biztonságos időkereten belül nem fejeződött volna be. Kredit nem került levonásra. Próbáld újra.' }, { status: 504 })
    }

    const packagingResult = await generatePackaging({
      topic, isShorts, platform,
      hook: coreResult.parsed.hook as string,
      narration: coreResult.parsed.narration as string,
      niche: creatorContext, uploadTimes, strictFactMode, qualityStatus,
    })

    await logUsage(userId, feature, MODELS.fast, packagingResult.inputTokens, packagingResult.outputTokens, { topic, platform, video_length, sub_step: 'packaging' })

    const elapsedBeforeChargeMs = Date.now() - routeStartedAt
    if (!hasTimeBudgetForChargeAndSave(elapsedBeforeChargeMs)) {
      console.error(`[VideoPackage] Hátralévőidő-védelem: kreditlevonás előtt nincs elegendő biztonságos tartalék (eltelt=${elapsedBeforeChargeMs}ms). Nincs levonás, nincs mentés, nincs automatikus retry.`)
      return NextResponse.json({ error: 'A generálás elkészült, de a biztonságos mentéshez már nem maradt elég idő. Kredit nem került levonásra. Próbáld újra.' }, { status: 504 })
    }

    const polishedCore = polishHungarianOutput(coreResult.parsed) as Record<string, unknown>
    const polishedPackaging = polishHungarianOutput(packagingResult.parsed) as Record<string, unknown>
    const polishedUploadTimes = polishHungarianOutput(uploadTimes)
    const platformChecklist = extractPlatformChecklist(platform, isShorts, packagingResult.parsed)

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
      hook: polishedCore.hook,
      hook_variations: polishedCore.hook_variations || [],
      narration: polishedCore.narration,
      scene_structure: polishedCore.scene_structure,
      broll_ideas: polishedCore.broll_ideas,
      timestamps: polishedCore.timestamps,
      thumbnail_texts: polishedPackaging.thumbnail_texts,
      thumbnail_concept: polishedPackaging.thumbnail_concept || null,
      title_variations: polishedPackaging.title_variations,
      caption: polishedPackaging.caption,
      description: polishedPackaging.description,
      hashtags: polishedPackaging.hashtags,
      pinned_comment: polishedPackaging.pinned_comment || null,
      why_it_works: polishedPackaging.why_it_works || null,
      risks: polishedPackaging.risks || [],
      production_checklist: polishedPackaging.production_checklist || [],
      upload_times: polishedUploadTimes,
      platform_checklist: platformChecklist,
      cta: polishedCore.cta,
      sources_used: polishedCore.sources_used || sources || [],
      verified_fact_block: factBlock,
      forbidden_claims: factBlock.forbidden_claims,
      // A fizetett eredmény a teljes forrássnapshotot őrzi. Így a bizonyítékok
      // paidResultId-s újranyitáskor nem a böngésző sessionStorage-ából élnek.
      // A `resolvedOpportunityContext`/`webSourceItems`/`youtubeSourceItems`
      // itt PONTOSAN azt tükrözi, ami a generáláshoz ténylegesen felhasználásra
      // került (szerver-oldali snapshot, ha volt video_idea_id, egyébként a
      // kliens által küldött érték) -- ez a fagyasztott, visszakövethető
      // másolat, függetlenül attól, hogy a forrás snapshot időközben frissül-e.
      opportunity_context: resolvedOpportunityContext ? {
        ...resolvedOpportunityContext,
        web_sources: webSourceItems,
        evidence_videos: youtubeSourceItems,
      } : null,
      // Explicit eredet-jelzés: honnan jött a ténylegesen felhasznált bizonyíték.
      opportunity_evidence_source: opportunityEvidenceSource,
      opportunity_evidence_captured_at: opportunityEvidenceCapturedAt,
    }

    const chargeResult = await chargeFeature(userId, feature, { topic, platform, video_length })
    if (!chargeResult.success) {
      return NextResponse.json({ error: chargeResult.error || 'Nincs elég kredited ehhez a művelethez.' }, { status: 402 })
    }

    const responsePayload = { ...result, _credits_remaining: chargeResult.new_balance }
    const paidSave = await savePaidResult({
      userId,
      toolType: 'video_package',
      inputHash,
      normalizedInput,
      originalInput: topic,
      region: language || null,
      language: language || null,
      platform: platform || null,
      resultJson: responsePayload,
      summaryJson: { topic, platform, video_length, quality_status: qualityStatus },
      creditCost: CREDIT_COSTS[feature],
      freshForHours: 24,
      // Ket kulon AI-hivas (core + packaging) tortenik egy Video Package
      // generalasnal, de a paid_results tablaban csak egy provider/model
      // mezo van soronkent — a "combined" ugyanaz a konvencio, amit a
      // chargeFeature() mar hasznal az ai_usage_logs-ban tobb-lepeses feature-oknel.
      provider: 'anthropic',
      model: 'combined',
      promptTemplateId: 'video_package',
      promptVersion: 'v1',
      estimatedCost: coreResult.estimatedCost + packagingResult.estimatedCost,
    })
    if (!paidSave.success) {
      console.error('[VideoPackage] KRITIKUS: paid_results mentés sikertelen, a user már fizetett érte:', paidSave.error)
      const refund = await refundCreditsAfterPersistenceFailure(userId, feature, CREDIT_COSTS[feature], { reason: 'paid_result_save_failed' }, chargeResult.credit_transaction_id)
      if (!refund.success) console.error('[VideoPackage] KRITIKUS: automatikus kredit-visszatérítés sikertelen')
      return NextResponse.json({ error: refund.success ? 'Az eredmény mentése sikertelen volt, a kreditet visszaadtuk.' : 'Az eredmény mentése és a kredit-visszatérítés sikertelen. Az esetet naplóztuk.' }, { status: 500 })
    }

    return NextResponse.json({ ...responsePayload, paid_result_id: paidSave.record?.id || null })
    } finally {
      await releaseRequestLock(lock.lockId)
    }
  } catch (error) {
    console.error('Video Package error:', error)
    return NextResponse.json({ error: 'Generálás sikertelen. Próbáld újra.' }, { status: 500 })
  }
}

// GET — csomag visszanyitása paidResultId alapján (a "Legutóbbi történeted"
// panelről érkező, perzisztens megvett eredmény) — kredit nélkül, ingyenesen.
export async function GET(request: NextRequest) {
  try {
    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const paidResultId = request.nextUrl.searchParams.get('paidResultId')
    if (!paidResultId) return NextResponse.json({ error: 'paidResultId kötelező' }, { status: 400 })

    const paid = await getPaidResultById(userId, paidResultId)
    if (!paid) return NextResponse.json({ error: 'Videócsomag nem található' }, { status: 404 })

    const opened = await openPaidResult(paid)
    const polishedResult = polishHungarianOutput(opened.result_json) as Record<string, unknown>
    const { _credits_remaining: _historicalCreditBalance, ...reopenableResult } = polishedResult
    return NextResponse.json({
      ...reopenableResult,
      ...paidResultResponseMeta(opened),
    })
  } catch (error) {
    console.error('Video Package GET error:', error)
    return NextResponse.json({ error: 'Szerverhiba' }, { status: 500 })
  }
}
