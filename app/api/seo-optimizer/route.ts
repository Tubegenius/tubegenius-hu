import { NextRequest, NextResponse } from 'next/server'
import { MODELS } from '@/lib/models'
import { getUserId, checkPaidFeatureAccess, chargeFeature, logUsage, CREDIT_COSTS, refundCreditsAfterPersistenceFailure } from '@/lib/credits'
import { dailySoftLimitError } from '@/lib/daily-soft-limit'
import { callAIProvider, extractJson } from '@/lib/services/ai-provider-service'
import { buildPaidResultHash, normalizePaidResultInput, savePaidResult, getPaidResultByHash, getPaidResultById, openPaidResult, paidResultResponseMeta } from '@/lib/paid-results/paid-results-service'
import { createAdminClient } from '@/lib/supabase-server'
import { computeSeoHeuristics, computeSeoScore, isValidSeoPackage, buildSeoOptimizerPrompt, type SeoPackage } from '@/lib/seo-optimizer'
import { polishHungarianOutput } from '@/lib/hungarian-output-polish'
import { resolveCreatorNicheContext } from '@/lib/creator-profile-context'
import { acquireRequestLock, releaseRequestLock, REQUEST_IN_PROGRESS_ERROR } from '@/lib/request-lock'
import { topicInputTooLong, topicTooLongResponseMessage } from '@/lib/api-input-validation'

export async function POST(request: NextRequest) {
  try {
    const { topic, existing_title, keywords, platform, region, force_refresh } = await request.json()
    if (!topic || typeof topic !== 'string' || !topic.trim()) {
      return NextResponse.json({ error: 'Téma megadása kötelező' }, { status: 400 })
    }
    if (topicInputTooLong(topic)) return NextResponse.json({ error: topicTooLongResponseMessage() }, { status: 400 })
    if (existing_title !== undefined && (typeof existing_title !== 'string' || existing_title.length > 120)) return NextResponse.json({ error: 'A meglévő cím legfeljebb 120 karakter lehet.' }, { status: 400 })
    if (platform !== undefined && platform !== 'youtube') return NextResponse.json({ error: 'Nem támogatott platform.' }, { status: 400 })
    if (region !== undefined && !['HU', 'US'].includes(region)) return NextResponse.json({ error: 'Nem támogatott régió.' }, { status: 400 })

    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const admin = createAdminClient()
    const { data: profileRow } = await admin.from('profiles').select('niche, main_category, specific_focus, channel_usage_mode').eq('user_id', userId).single()
    const { niche, useNiche } = resolveCreatorNicheContext({ topic, channelUsageMode: profileRow?.channel_usage_mode, niche: profileRow?.niche, mainCategory: profileRow?.main_category, specificFocus: profileRow?.specific_focus })
    const platformValue = platform || 'youtube'
    const regionValue = region || 'HU'
    const rawKeywords: unknown[] = Array.isArray(keywords) ? keywords : (typeof keywords === 'string' ? keywords.split(',') : [])
    if (rawKeywords.some(keyword => typeof keyword !== 'string')) return NextResponse.json({ error: 'A kulcsszavak csak szövegek lehetnek.' }, { status: 400 })
    const keywordList = Array.from(new Set((rawKeywords as string[]).map(keyword => keyword.trim()).filter(Boolean)))
    if (keywordList.length > 20 || keywordList.some(keyword => keyword.length > 100)) return NextResponse.json({ error: 'Legfeljebb 20, egyenként 100 karakteres kulcsszó adható meg.' }, { status: 400 })
    const normalizedTopic = topic.trim()

    const normalizedInput = normalizePaidResultInput({ topic, existing_title, keywords: keywordList, platform: platformValue, region: regionValue, niche: useNiche ? niche : '', useNiche })
    const inputHash = buildPaidResultHash({ userId, toolType: 'seo_optimizer', normalizedInput, platform: platformValue, region: regionValue })

    const lock = await acquireRequestLock({ userId, toolType: 'seo_optimizer', inputHash })
    if (!lock.acquired) {
      return NextResponse.json({ error: REQUEST_IN_PROGRESS_ERROR }, { status: 409 })
    }

    try {
      // Csak explicit force_refresh (a user tudatosan új generálást kér) hagyja ki
      // a mentett eredményt — enélkül ugyanaz a téma örökre ugyanazt a cache-elt
      // csomagot adná vissza, kredit-levonás lehetősége nélkül.
      if (!force_refresh) {
        const paid = await getPaidResultByHash({ userId, toolType: 'seo_optimizer', inputHash })
        if (paid) {
          const opened = await openPaidResult(paid)
          return NextResponse.json({ ...(polishHungarianOutput(opened.result_json) as object), ...paidResultResponseMeta(opened) })
        }
      }

      const access = await checkPaidFeatureAccess(userId, 'seo_optimizer', request.headers.get('x-daily-soft-limit-override') === 'true')
      if (access.reason === 'daily_soft_limit' && access.dailyLimit) return NextResponse.json(dailySoftLimitError(access.dailyLimit), { status: 429 })
      if (!access.allowed) {
        return NextResponse.json({ error: `Nincs elég kredited. Ehhez ${CREDIT_COSTS.seo_optimizer} kredit szükséges.` }, { status: 402 })
      }

      const prompt = buildSeoOptimizerPrompt({ topic: normalizedTopic, existingTitle: existing_title?.trim() || undefined, keywords: keywordList, niche, useNiche, platform: platformValue })
      const aiCall = await callAIProvider({
        model: MODELS.fast,
        maxTokens: 2000,
        messages: [{ role: 'user', content: prompt }],
        promptTemplateId: 'seo_optimizer_package',
        promptVersion: 'v1',
      })

      const seoPackage = extractJson<SeoPackage>(aiCall.text)
      if (!isValidSeoPackage(seoPackage)) throw new Error('Invalid SEO package returned by AI provider')
      const heuristics = computeSeoHeuristics({
        title: seoPackage.seo_title || existing_title || normalizedTopic,
        description: seoPackage.description || '',
        keywords: keywordList.length > 0 ? keywordList : [normalizedTopic],
        tags: seoPackage.tags || [],
      })
      const seoScore = computeSeoScore(heuristics)

      await logUsage(userId, 'seo_optimizer', MODELS.fast, aiCall.usage.inputTokens, aiCall.usage.outputTokens, { topic: normalizedTopic })

      const charge = await chargeFeature(userId, 'seo_optimizer', { topic: normalizedTopic })
      if (!charge.success) {
        return NextResponse.json({ error: charge.error || 'Nincs elég kredited ehhez a művelethez.' }, { status: 402 })
      }

      const checklist = [
        { label: 'Cím hossza megfelelő (15-70 karakter)', done: heuristics.title_length_flag === 'ok' },
        { label: 'Leírás első sora tartalmaz kulcsszót', done: heuristics.description_first_line_has_keyword },
        { label: 'Elég tag van megadva (5-15)', done: heuristics.tag_count_flag === 'ok' },
        { label: 'Van fejezetvázlat (az időbélyegeket a kész videóhoz kell igazítani)', done: (seoPackage.chapters || []).length > 0 },
        { label: 'Van kitűzhető komment', done: !!seoPackage.pinned_comment },
        { label: 'Van végképernyő CTA', done: !!seoPackage.end_screen_cta },
      ]

      const responsePayload = {
        topic: normalizedTopic,
        seo_package: seoPackage,
        heuristics,
        seo_score: seoScore,
        score_methodology: 'deterministic_metadata_readiness_v1',
        score_disclaimer: 'Heurisztikus feltöltési metaadat-készültség, nem keresési helyezés- vagy nézettség-előrejelzés.',
        checklist,
        _credits_remaining: charge.new_balance,
      }

      const paidSave = await savePaidResult({
        userId,
        toolType: 'seo_optimizer',
        inputHash,
        normalizedInput,
        originalInput: normalizedTopic,
        platform: platformValue,
        region: regionValue,
        resultJson: responsePayload,
        summaryJson: { topic: normalizedTopic, seo_score: seoScore, score_methodology: 'deterministic_metadata_readiness_v1' },
        creditCost: CREDIT_COSTS.seo_optimizer,
        freshForHours: 24,
        provider: aiCall.provider,
        model: aiCall.model,
        promptTemplateId: aiCall.promptTemplateId,
        promptVersion: aiCall.promptVersion,
        estimatedCost: aiCall.estimatedCost,
      })
      if (!paidSave.success) {
        console.error('[SeoOptimizer] KRITIKUS: paid_results mentés sikertelen, a user már fizetett érte:', paidSave.error)
        const refund = await refundCreditsAfterPersistenceFailure(userId, 'seo_optimizer', CREDIT_COSTS.seo_optimizer, { reason: 'paid_result_save_failed' }, charge.credit_transaction_id)
        if (!refund.success) console.error('[SeoOptimizer] KRITIKUS: automatikus kredit-visszatérítés sikertelen')
        return NextResponse.json({ error: refund.success ? 'Az eredmény mentése sikertelen volt, a kreditet visszaadtuk.' : 'Az eredmény mentése és a kredit-visszatérítés sikertelen. Az esetet naplóztuk.' }, { status: 500 })
      }

      return NextResponse.json({ ...(polishHungarianOutput(responsePayload) as object), paid_result_id: paidSave.record?.id || null })
    } finally {
      await releaseRequestLock(lock.lockId)
    }
  } catch (error) {
    console.error('SEO optimizer error:', error)
    return NextResponse.json({ error: 'SEO csomag generálása sikertelen. Próbáld újra.' }, { status: 500 })
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
    console.error('SEO optimizer GET error:', error)
    return NextResponse.json({ error: 'Szerverhiba' }, { status: 500 })
  }
}
