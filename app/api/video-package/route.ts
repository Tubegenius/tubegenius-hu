import { NextRequest, NextResponse } from 'next/server'
import { MODELS } from '@/lib/models'
import { getUserId, checkPaidFeatureAccess, chargeFeature, logUsage, CREDIT_COSTS } from '@/lib/credits'
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
import { resolveCreatorNicheContext } from '@/lib/creator-profile-context'
import {
  STYLE_PROMPTS,
  getShortsTarget,
  getLongTarget,
  getUploadTimes,
  generateCreativeCore,
  generatePackaging,
  extractPlatformChecklist,
} from '@/lib/video-package'
import { topicInputTooLong, topicTooLongResponseMessage } from '@/lib/api-input-validation'

export async function POST(request: NextRequest) {
  try {
    const {
      topic, platform, video_length, narration_style, intensity, goal,
      custom_prompt, niche, channel_context, language, fact_block, sources,
      web_sources, youtube_sources, source_video, opportunity_context,
    } = await request.json()

    if (!topic || typeof topic !== 'string' || !topic.trim()) return NextResponse.json({ error: 'Téma megadása kötelező' }, { status: 400 })
    if (topicInputTooLong(topic)) return NextResponse.json({ error: topicTooLongResponseMessage() }, { status: 400 })

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

    const sourceVideoKey = source_video?.video_id || source_video?.id || source_video?.url || null
    const opportunityKey = opportunity_context?.id || opportunity_context?.title || null
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
      return NextResponse.json({
        ...(polishHungarianOutput(opened.result_json) as object),
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
    // A kliens altal kifejezetten kuldott channel_context/niche tovabbra is
    // elsobbseget elvez (mar korabban is igy volt) — csak akkor esunk vissza
    // a profilra, ha EGYIK sincs megadva, es azt is a megosztott relevancia-
    // kapun (stats_only-tudatos) engedjuk csak at, sose nyersen.
    let creatorContext = channel_context || niche || ''
    if (!creatorContext) {
      const { data: profileRow } = await createAdminClient().from('profiles').select('niche, main_category, specific_focus, channel_usage_mode').eq('user_id', userId).single()
      const gated = resolveCreatorNicheContext({ topic, channelUsageMode: profileRow?.channel_usage_mode, niche: profileRow?.niche, mainCategory: profileRow?.main_category, specificFocus: profileRow?.specific_focus })
      creatorContext = gated.useNiche ? gated.niche : ''
    }
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
      topic, isShorts, t, arc, niche: creatorContext, stylePrompt,
      intensity: final_intensity, goal, factSection, factSafetyRules,
      platform, videoLength: video_length, narrationStyle: narration_style,
      contentType, strictFactMode, sourceVideoMode,
    })

    const packagingResult = await generatePackaging({
      topic, isShorts, platform,
      hook: coreResult.parsed.hook as string,
      narration: coreResult.parsed.narration as string,
      niche: creatorContext, uploadTimes, strictFactMode, qualityStatus,
    })

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
      opportunity_context: opportunity_context || null,
    }

    await logUsage(userId, feature, MODELS.primary, coreResult.inputTokens, coreResult.outputTokens, { topic, platform, video_length, sub_step: 'core', content_type: contentType })
    await logUsage(userId, feature, MODELS.fast, packagingResult.inputTokens, packagingResult.outputTokens, { topic, platform, video_length, sub_step: 'packaging' })

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
    return NextResponse.json({
      ...(polishHungarianOutput(opened.result_json) as object),
      ...paidResultResponseMeta(opened),
    })
  } catch (error) {
    console.error('Video Package GET error:', error)
    return NextResponse.json({ error: 'Szerverhiba' }, { status: 500 })
  }
}
