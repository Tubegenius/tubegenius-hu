import { NextRequest, NextResponse } from 'next/server'
import { MODELS } from '@/lib/models'
import { getUserId, hasEnoughCredits, chargeFeature, logUsage, CREDIT_COSTS } from '@/lib/credits'
import { callAIProvider, extractJson } from '@/lib/services/ai-provider-service'
import { buildPaidResultHash, normalizePaidResultInput, savePaidResult, getPaidResultByHash, getPaidResultById, openPaidResult, paidResultResponseMeta } from '@/lib/paid-results/paid-results-service'
import { fetchKeywordSignals, fetchSeedVideoStats } from '@/lib/keyword-research'
import { buildContentGapPrompt, type ContentGapSuggestion } from '@/lib/content-gap'
import { polishHungarianOutput } from '@/lib/hungarian-output-polish'

export async function POST(request: NextRequest) {
  try {
    const { niche, platform, region } = await request.json()
    if (!niche || typeof niche !== 'string') {
      return NextResponse.json({ error: 'Niche/téma megadása kötelező' }, { status: 400 })
    }

    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const platformValue = platform || 'youtube'
    const regionValue = region || 'HU'

    const normalizedInput = normalizePaidResultInput({ niche, platform: platformValue })
    const inputHash = buildPaidResultHash({ userId, toolType: 'content_gap', normalizedInput, platform: platformValue })

    const paid = await getPaidResultByHash({ userId, toolType: 'content_gap', inputHash })
    if (paid) {
      const opened = await openPaidResult(paid)
      return NextResponse.json({ ...(polishHungarianOutput(opened.result_json) as object), ...paidResultResponseMeta(opened) })
    }

    const enoughCredits = await hasEnoughCredits(userId, 'content_gap_finder')
    if (!enoughCredits) {
      return NextResponse.json({ error: `Nincs elég kredited. Ehhez ${CREDIT_COSTS.content_gap_finder} kredit szükséges.` }, { status: 402 })
    }

    const [{ videos }, signals] = await Promise.all([
      fetchSeedVideoStats(niche, regionValue),
      fetchKeywordSignals(niche, regionValue),
    ])

    if (videos.length === 0 && signals.relatedSearches.length === 0 && signals.peopleAlsoAsk.length === 0) {
      return NextResponse.json({ error: 'Nem találtunk elég valós adatot ehhez a niche-hez. Próbálj konkrétabb témát.' }, { status: 404 })
    }

    const prompt = buildContentGapPrompt({
      niche,
      existingVideoTitles: videos.map(v => v.title),
      relatedSearches: signals.relatedSearches,
      peopleAlsoAsk: signals.peopleAlsoAsk,
    })

    const aiCall = await callAIProvider({
      model: MODELS.fast,
      maxTokens: 1800,
      messages: [{ role: 'user', content: prompt }],
      promptTemplateId: 'content_gap_finder',
      promptVersion: 'v1',
    })

    const gaps = extractJson<ContentGapSuggestion[]>(aiCall.text)

    await logUsage(userId, 'content_gap_finder', MODELS.fast, aiCall.usage.inputTokens, aiCall.usage.outputTokens, { niche })

    const charge = await chargeFeature(userId, 'content_gap_finder', { niche })
    if (!charge.success) {
      return NextResponse.json({ error: charge.error || 'Nincs elég kredited ehhez a művelethez.' }, { status: 402 })
    }

    const responsePayload = {
      niche,
      existing_video_count: videos.length,
      gaps,
      _credits_remaining: charge.new_balance,
    }

    const paidSave = await savePaidResult({
      userId,
      toolType: 'content_gap',
      inputHash,
      normalizedInput,
      originalInput: niche,
      platform: platformValue,
      region: regionValue,
      resultJson: responsePayload,
      summaryJson: { niche, gap_count: gaps.length },
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
    }

    return NextResponse.json({ ...(polishHungarianOutput(responsePayload) as object), paid_result_id: paidSave.record?.id || null })
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
    if (!paid) return NextResponse.json({ error: 'Az eredmény nem található' }, { status: 404 })

    const opened = await openPaidResult(paid)
    return NextResponse.json({ ...(polishHungarianOutput(opened.result_json) as object), ...paidResultResponseMeta(opened) })
  } catch (error) {
    console.error('Content gap GET error:', error)
    return NextResponse.json({ error: 'Szerverhiba' }, { status: 500 })
  }
}
