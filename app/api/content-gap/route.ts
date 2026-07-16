import { NextRequest, NextResponse } from 'next/server'
import { MODELS } from '@/lib/models'
import { getUserId, checkPaidFeatureAccess, chargeFeature, logUsage, CREDIT_COSTS, refundCreditsAfterPersistenceFailure } from '@/lib/credits'
import { callAIProvider, extractJson } from '@/lib/services/ai-provider-service'
import { buildPaidResultHash, normalizePaidResultInput, savePaidResult, getPaidResultByHash, getPaidResultById, openPaidResult, paidResultResponseMeta } from '@/lib/paid-results/paid-results-service'
import { fetchKeywordSignals, fetchSeedVideoStats } from '@/lib/keyword-research'
import { buildContentGapPrompt, validateContentGapSuggestions } from '@/lib/content-gap'
import { polishHungarianOutput } from '@/lib/hungarian-output-polish'
import { acquireRequestLock, releaseRequestLock, REQUEST_IN_PROGRESS_ERROR } from '@/lib/request-lock'
import { topicInputTooLong, topicTooLongResponseMessage } from '@/lib/api-input-validation'
import { renderPromptTemplate } from '@/lib/prompts/template-registry'
import { PROMPT_TEMPLATES } from '@/lib/prompts/catalog'
import { dailySoftLimitError } from '@/lib/daily-soft-limit'
import { filterByRelevance, getConfidenceLevel } from '@/lib/opportunity-scoring'

export async function POST(request: NextRequest) {
  try {
    const { niche, platform, region } = await request.json()
    if (!niche || typeof niche !== 'string' || !niche.trim()) {
      return NextResponse.json({ error: 'Niche/téma megadása kötelező' }, { status: 400 })
    }
    if (topicInputTooLong(niche)) return NextResponse.json({ error: topicTooLongResponseMessage('A niche/téma') }, { status: 400 })
    if (platform != null && platform !== 'youtube') return NextResponse.json({ error: 'Nem támogatott platform.' }, { status: 400 })
    if (region != null && !['HU', 'US'].includes(region)) return NextResponse.json({ error: 'Nem támogatott régió.' }, { status: 400 })
    const nicheValue = niche.trim()

    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const platformValue = platform || 'youtube'
    const regionValue = region || 'HU'

    const normalizedInput = normalizePaidResultInput({ niche: nicheValue, platform: platformValue, region: regionValue })
    const inputHash = buildPaidResultHash({ userId, toolType: 'content_gap', normalizedInput, platform: platformValue, region: regionValue })

    const lock = await acquireRequestLock({ userId, toolType: 'content_gap', inputHash })
    if (!lock.acquired) {
      return NextResponse.json({ error: REQUEST_IN_PROGRESS_ERROR }, { status: 409 })
    }

    try {
    const paid = await getPaidResultByHash({ userId, toolType: 'content_gap', inputHash })
    if (paid) {
      const opened = await openPaidResult(paid)
      return NextResponse.json({ ...(polishHungarianOutput(opened.result_json) as object), ...paidResultResponseMeta(opened) })
    }

    const access = await checkPaidFeatureAccess(userId, 'content_gap_finder', request.headers.get('x-daily-soft-limit-override') === 'true')
    if (access.reason === 'daily_soft_limit' && access.dailyLimit) return NextResponse.json(dailySoftLimitError(access.dailyLimit), { status: 429 })
    if (!access.allowed) {
      return NextResponse.json({ error: `Nincs elég kredited. Ehhez ${CREDIT_COSTS.content_gap_finder} kredit szükséges.` }, { status: 402 })
    }

    const [{ videos }, signals] = await Promise.all([
      fetchSeedVideoStats(nicheValue, regionValue),
      fetchKeywordSignals(nicheValue, regionValue),
    ])

    const relevantVideos = filterByRelevance(videos, nicheValue, 20).map(item => item.video)
    const demandSignals = [...new Set([...signals.relatedSearches, ...signals.peopleAlsoAsk].map(signal => signal.trim()).filter(Boolean))]
    if (demandSignals.length < 3) return NextResponse.json({ error: 'Nem találtunk legalább három valós keresési jelet ehhez a témához. Próbálj konkrétabb vagy más megfogalmazást.' }, { status: 404 })

    const renderedPrompt = renderPromptTemplate(PROMPT_TEMPLATES.contentGap, () => buildContentGapPrompt({
      niche: nicheValue,
      existingVideoTitles: relevantVideos.map(v => v.title),
      relatedSearches: signals.relatedSearches,
      peopleAlsoAsk: signals.peopleAlsoAsk,
    }))

    const aiCall = await callAIProvider({
      model: MODELS.fast,
      maxTokens: 1800,
      messages: [{ role: 'user', content: renderedPrompt.text }],
      promptTemplateId: renderedPrompt.templateId,
      promptVersion: renderedPrompt.version,
    })

    const gaps = validateContentGapSuggestions(extractJson<unknown>(aiCall.text), demandSignals)

    await logUsage(userId, 'content_gap_finder', MODELS.fast, aiCall.usage.inputTokens, aiCall.usage.outputTokens, { niche: nicheValue })

    const charge = await chargeFeature(userId, 'content_gap_finder', { niche: nicheValue })
    if (!charge.success) {
      return NextResponse.json({ error: charge.error || 'Nincs elég kredited ehhez a művelethez.' }, { status: 402 })
    }

    const responsePayload = {
      niche: nicheValue,
      existing_video_count: relevantVideos.length,
      evidence: {
        youtube_sample_size: videos.length,
        relevant_video_count: relevantVideos.length,
        demand_signal_count: demandSignals.length,
        video_sample_confidence: getConfidenceLevel(relevantVideos.length),
        demand_basis: 'google_related_searches_and_people_also_ask',
        is_search_volume: false,
      },
      gaps,
      _credits_remaining: charge.new_balance,
    }

    const paidSave = await savePaidResult({
      userId,
      toolType: 'content_gap',
      inputHash,
      normalizedInput,
      originalInput: nicheValue,
      platform: platformValue,
      region: regionValue,
      resultJson: responsePayload,
      summaryJson: { niche: nicheValue, gap_count: gaps.length, relevant_video_count: relevantVideos.length, demand_signal_count: demandSignals.length },
      creditCost: CREDIT_COSTS.content_gap_finder,
      freshForHours: 24,
      provider: aiCall.provider,
      model: aiCall.model,
      promptTemplateId: aiCall.promptTemplateId,
      promptVersion: aiCall.promptVersion,
      estimatedCost: aiCall.estimatedCost,
    })
    if (!paidSave.success) {
      console.error('[ContentGap] KRITIKUS: paid_results mentés sikertelen, a user már fizetett érte:', paidSave.error)
      const refund = await refundCreditsAfterPersistenceFailure(userId, 'content_gap_finder', CREDIT_COSTS.content_gap_finder, { reason: 'paid_result_save_failed' })
      if (!refund.success) console.error('[ContentGap] KRITIKUS: automatikus kredit-visszatérítés sikertelen')
      return NextResponse.json({ error: refund.success ? 'Az eredmény mentése sikertelen volt, a kreditet visszaadtuk.' : 'Az eredmény mentése és a kredit-visszatérítés sikertelen. Az esetet naplóztuk.' }, { status: 500 })
    }

    return NextResponse.json({ ...(polishHungarianOutput(responsePayload) as object), paid_result_id: paidSave.record?.id || null })
    } finally {
      await releaseRequestLock(lock.lockId)
    }
  } catch (error) {
    console.error('Content gap error:', error)
    return NextResponse.json({ error: 'Elemzés sikertelen. Próbáld újra.' }, { status: 500 })
  }
}

// GET — mentett eredmeny visszanyitasa paidResultId alapjan, kredit nelkul.
export async function GET(request: NextRequest) {
  try {
    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const paidResultId = request.nextUrl.searchParams.get('paidResultId')
    if (!paidResultId) return NextResponse.json({ error: 'paidResultId kötelező' }, { status: 400 })

    const paid = await getPaidResultById(userId, paidResultId)
    if (!paid || paid.tool_type !== 'content_gap') return NextResponse.json({ error: 'Az eredmény nem található' }, { status: 404 })

    const opened = await openPaidResult(paid)
    return NextResponse.json({ ...(polishHungarianOutput(opened.result_json) as object), ...paidResultResponseMeta(opened) })
  } catch (error) {
    console.error('Content gap GET error:', error)
    return NextResponse.json({ error: 'Szerverhiba' }, { status: 500 })
  }
}
