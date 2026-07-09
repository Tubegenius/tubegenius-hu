import { NextRequest, NextResponse } from 'next/server'
import { MODELS } from '@/lib/models'
import { getUserId, hasEnoughCredits, chargeFeature, logUsage, CREDIT_COSTS } from '@/lib/credits'
import { callAIProvider, extractJson } from '@/lib/services/ai-provider-service'
import { buildPaidResultHash, normalizePaidResultInput, savePaidResult, getPaidResultByHash, getPaidResultById, openPaidResult, paidResultResponseMeta } from '@/lib/paid-results/paid-results-service'
import { createAdminClient } from '@/lib/supabase-server'
import { buildScoreBreakdown, getConfidenceLevel } from '@/lib/opportunity-scoring'
import { fetchKeywordSignals, fetchSeedVideoStats, buildKeywordClusterPrompt, type RelatedKeywordSuggestion } from '@/lib/keyword-research'
import { polishHungarianText } from '@/lib/hungarian-output-polish'

export async function POST(request: NextRequest) {
  try {
    const { seed_keyword, platform, region, niche: nicheOverride } = await request.json()
    if (!seed_keyword || typeof seed_keyword !== 'string') {
      return NextResponse.json({ error: 'Kulcsszó megadása kötelező' }, { status: 400 })
    }

    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const admin = createAdminClient()
    const { data: profileRow } = await admin.from('profiles').select('niche').eq('user_id', userId).single()
    const niche = nicheOverride || profileRow?.niche || ''
    const platformValue = platform || 'youtube'
    const regionValue = region || 'HU'

    const normalizedInput = normalizePaidResultInput({ seed_keyword, niche, platform: platformValue, region: regionValue })
    const inputHash = buildPaidResultHash({
      userId,
      toolType: 'keyword_research',
      normalizedInput,
      region: regionValue,
      platform: platformValue,
    })

    const paid = await getPaidResultByHash({ userId, toolType: 'keyword_research', inputHash })
    if (paid) {
      const opened = await openPaidResult(paid)
      return NextResponse.json({ ...(opened.result_json as object), ...paidResultResponseMeta(opened) })
    }

    const enoughCredits = await hasEnoughCredits(userId, 'keyword_research')
    if (!enoughCredits) {
      return NextResponse.json({ error: `Nincs elég kredited. Ehhez ${CREDIT_COSTS.keyword_research} kredit szükséges.` }, { status: 402 })
    }

    const [{ videos, totalResults }, signals] = await Promise.all([
      fetchSeedVideoStats(seed_keyword, regionValue),
      fetchKeywordSignals(seed_keyword, regionValue),
    ])

    const breakdown = videos.length > 0 ? buildScoreBreakdown(videos, totalResults, seed_keyword, niche) : null
    const confidence = getConfidenceLevel(videos.length)

    const prompt = buildKeywordClusterPrompt({
      seedKeyword: seed_keyword,
      niche,
      platform: platformValue,
      language: regionValue === 'HU' ? 'hu' : 'en',
      relatedSearches: signals.relatedSearches,
      peopleAlsoAsk: signals.peopleAlsoAsk,
      seedVideoCount: videos.length,
      seedCompetition: breakdown?.competition ?? 0,
    })

    const aiCall = await callAIProvider({
      model: MODELS.fast,
      maxTokens: 1500,
      messages: [{ role: 'user', content: prompt }],
      promptTemplateId: 'keyword_research_cluster',
      promptVersion: 'v1',
    })

    const relatedKeywords = extractJson<RelatedKeywordSuggestion[]>(aiCall.text)
      .map(item => ({
        keyword: item.keyword,
        angle: polishHungarianText(item.angle || ''),
        content_format_hint: item.content_format_hint || '',
      }))

    await logUsage(userId, 'keyword_research', MODELS.fast, aiCall.usage.inputTokens, aiCall.usage.outputTokens, { seed_keyword })

    const charge = await chargeFeature(userId, 'keyword_research', { seed_keyword })
    if (!charge.success) {
      return NextResponse.json({ error: charge.error || 'Nincs elég kredited ehhez a művelethez.' }, { status: 402 })
    }

    const responsePayload = {
      seed_keyword,
      seed_score: breakdown ? {
        total: breakdown.total,
        competition: breakdown.competition,
        content_gap: breakdown.content_gap,
        trend_momentum: breakdown.trend_momentum,
        freshness: breakdown.freshness,
        confidence,
        video_count: videos.length,
      } : null,
      related_keywords: relatedKeywords,
      people_also_ask: signals.peopleAlsoAsk,
      _credits_remaining: charge.new_balance,
    }

    const paidSave = await savePaidResult({
      userId,
      toolType: 'keyword_research',
      inputHash,
      normalizedInput,
      originalInput: seed_keyword,
      region: regionValue,
      platform: platformValue,
      resultJson: responsePayload,
      summaryJson: { seed_keyword, video_count: videos.length, related_count: relatedKeywords.length },
      creditCost: CREDIT_COSTS.keyword_research,
      freshForHours: 24,
      provider: aiCall.provider,
      model: aiCall.model,
      promptTemplateId: aiCall.promptTemplateId,
      promptVersion: aiCall.promptVersion,
      estimatedCost: aiCall.estimatedCost,
    })
    if (!paidSave.success) {
      console.error('[KeywordResearch] KRITIKUS: paid_results mentés sikertelen, a user már fizetett érte:', paidSave.error)
    }

    return NextResponse.json({ ...responsePayload, paid_result_id: paidSave.record?.id || null })
  } catch (error) {
    console.error('Keyword research error:', error)
    return NextResponse.json({ error: 'Kulcsszókutatás sikertelen. Próbáld újra.' }, { status: 500 })
  }
}

// GET — mentett kutatás visszanyitása paidResultId alapján, kredit nélkül.
export async function GET(request: NextRequest) {
  try {
    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const paidResultId = request.nextUrl.searchParams.get('paidResultId')
    if (!paidResultId) return NextResponse.json({ error: 'paidResultId kötelező' }, { status: 400 })

    const paid = await getPaidResultById(userId, paidResultId)
    if (!paid) return NextResponse.json({ error: 'A kutatás nem található' }, { status: 404 })

    const opened = await openPaidResult(paid)
    return NextResponse.json({ ...(opened.result_json as object), ...paidResultResponseMeta(opened) })
  } catch (error) {
    console.error('Keyword research GET error:', error)
    return NextResponse.json({ error: 'Szerverhiba' }, { status: 500 })
  }
}
