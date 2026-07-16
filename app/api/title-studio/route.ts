import { NextRequest, NextResponse } from 'next/server'
import { MODELS } from '@/lib/models'
import { getUserId, checkPaidFeatureAccess, chargeFeature, logUsage, CREDIT_COSTS, refundCreditsAfterPersistenceFailure } from '@/lib/credits'
import { callAIProvider, extractJson } from '@/lib/services/ai-provider-service'
import { buildPaidResultHash, normalizePaidResultInput, savePaidResult, getPaidResultByHash, getPaidResultById, openPaidResult, paidResultResponseMeta } from '@/lib/paid-results/paid-results-service'
import { createAdminClient } from '@/lib/supabase-server'
import { computeTitleHeuristics, buildTitleStudioPrompt, validateHungarianTitle, sanitizeHungarianTitle, validateDistinctTitleVariations } from '@/lib/title-studio'
import { polishHungarianText } from '@/lib/hungarian-output-polish'
import { ensureVideoIdea, buildVideoIdeaInputHash } from '@/lib/video-ideas/video-idea-service'
import { resolveCreatorNicheContext } from '@/lib/creator-profile-context'
import { acquireRequestLock, releaseRequestLock, REQUEST_IN_PROGRESS_ERROR } from '@/lib/request-lock'
import { topicInputTooLong, topicTooLongResponseMessage } from '@/lib/api-input-validation'
import { renderPromptTemplate } from '@/lib/prompts/template-registry'
import { PROMPT_TEMPLATES } from '@/lib/prompts/catalog'
import { dailySoftLimitError } from '@/lib/daily-soft-limit'

export async function POST(request: NextRequest) {
  try {
    const { topic, existing_title, platform, region, force_refresh } = await request.json()
    if (!topic || typeof topic !== 'string' || !topic.trim()) {
      return NextResponse.json({ error: 'Téma megadása kötelező' }, { status: 400 })
    }
    if (topicInputTooLong(topic)) return NextResponse.json({ error: topicTooLongResponseMessage() }, { status: 400 })
    if (existing_title != null && (typeof existing_title !== 'string' || !existing_title.trim() || existing_title.length > 100)) return NextResponse.json({ error: 'A meglévő cím legfeljebb 100 karakter lehet.' }, { status: 400 })
    if (platform != null && platform !== 'youtube') return NextResponse.json({ error: 'Nem támogatott platform.' }, { status: 400 })
    if (region != null && !['HU', 'US'].includes(region)) return NextResponse.json({ error: 'Nem támogatott régió.' }, { status: 400 })
    if (force_refresh != null && typeof force_refresh !== 'boolean') return NextResponse.json({ error: 'Hibás frissítési beállítás.' }, { status: 400 })
    const topicValue = topic.trim()
    const existingTitle = existing_title?.trim() || undefined

    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const admin = createAdminClient()
    const { data: profileRow } = await admin.from('profiles').select('niche, main_category, specific_focus, channel_usage_mode').eq('user_id', userId).single()
    const { niche, useNiche } = resolveCreatorNicheContext({ topic: topicValue, channelUsageMode: profileRow?.channel_usage_mode, niche: profileRow?.niche, mainCategory: profileRow?.main_category, specificFocus: profileRow?.specific_focus })
    const platformValue = platform || 'youtube'
    const regionValue = region || 'HU'

    const normalizedInput = normalizePaidResultInput({ topic: topicValue, existing_title: existingTitle, platform: platformValue, region: regionValue, niche: useNiche ? niche : '', useNiche })
    const inputHash = buildPaidResultHash({ userId, toolType: 'title_studio', normalizedInput, platform: platformValue, region: regionValue })

    // Beta Hardening Test (2026-07-11): ket egyideju azonos keres (pl. ket
    // bongeszofulben) nelkule mindketto vegigfutna es kulon-kulon kreditet
    // vonna le ugyanazert az erdemi eredmenyert — lasd CREATOR_OS_PLAN_STATUS.md.
    const lock = await acquireRequestLock({ userId, toolType: 'title_studio', inputHash })
    if (!lock.acquired) {
      return NextResponse.json({ error: REQUEST_IN_PROGRESS_ERROR }, { status: 409 })
    }

    try {
      if (!force_refresh) {
        const paid = await getPaidResultByHash({ userId, toolType: 'title_studio', inputHash })
        if (paid) {
          const opened = await openPaidResult(paid)
          return NextResponse.json({ ...(opened.result_json as object), ...paidResultResponseMeta(opened) })
        }
      }

      const access = await checkPaidFeatureAccess(userId, 'title_studio', request.headers.get('x-daily-soft-limit-override') === 'true')
      if (access.reason === 'daily_soft_limit' && access.dailyLimit) return NextResponse.json(dailySoftLimitError(access.dailyLimit), { status: 429 })
      if (!access.allowed) {
        return NextResponse.json({ error: `Nincs elég kredited. Ehhez ${CREDIT_COSTS.title_studio} kredit szükséges.` }, { status: 402 })
      }

      const renderedPrompt = renderPromptTemplate(PROMPT_TEMPLATES.titleStudio, () => buildTitleStudioPrompt({ topic: topicValue, niche, useNiche, platform: platformValue, existingTitle }))
      const aiCall = await callAIProvider({
        model: MODELS.fast,
        maxTokens: 2200,
        messages: [{ role: 'user', content: renderedPrompt.text }],
        promptTemplateId: renderedPrompt.templateId,
        promptVersion: renderedPrompt.version,
      })

      const rawVariations = validateDistinctTitleVariations(extractJson<unknown>(aiCall.text))
      const variations = validateDistinctTitleVariations(rawVariations.map(v => {
        const polishedTitle = polishHungarianText(v.title || '')
        const { ok } = validateHungarianTitle(polishedTitle)
        const finalTitle = ok ? polishedTitle : sanitizeHungarianTitle(polishedTitle)
        if (!ok) console.warn('[TitleStudio] Idegen szó cserélve a címben:', polishedTitle, '→', finalTitle)
        return {
          ...v,
          title: finalTitle,
          reasoning: polishHungarianText(v.reasoning || ''),
          heuristics: computeTitleHeuristics(finalTitle),
        }
      }))

      await logUsage(userId, 'title_studio', MODELS.fast, aiCall.usage.inputTokens, aiCall.usage.outputTokens, { topic: topicValue })

      const charge = await chargeFeature(userId, 'title_studio', { topic: topicValue })
      if (!charge.success) {
        return NextResponse.json({ error: charge.error || 'Nincs elég kredited ehhez a művelethez.' }, { status: 402 })
      }

      const responsePayload = {
        topic: topicValue,
        variations,
        scoring_methodology: 'subjective_ai_packaging_review_not_ctr_prediction',
        _credits_remaining: charge.new_balance,
      }

      const paidSave = await savePaidResult({
        userId,
        toolType: 'title_studio',
        inputHash,
        normalizedInput,
        originalInput: topicValue,
        platform: platformValue,
        region: regionValue,
        resultJson: responsePayload,
        summaryJson: { topic: topicValue, variation_count: variations.length, methodology: 'subjective_ai_packaging_review_not_ctr_prediction' },
        creditCost: CREDIT_COSTS.title_studio,
        freshForHours: 24,
        provider: aiCall.provider,
        model: aiCall.model,
        promptTemplateId: aiCall.promptTemplateId,
        promptVersion: aiCall.promptVersion,
        estimatedCost: aiCall.estimatedCost,
      })
      if (!paidSave.success) {
        console.error('[TitleStudio] KRITIKUS: paid_results mentés sikertelen, a user már fizetett érte:', paidSave.error)
        const refund = await refundCreditsAfterPersistenceFailure(userId, 'title_studio', CREDIT_COSTS.title_studio, { reason: 'paid_result_save_failed' })
        if (!refund.success) console.error('[TitleStudio] KRITIKUS: automatikus kredit-visszatérítés sikertelen')
        return NextResponse.json({ error: refund.success ? 'Az eredmény mentése sikertelen volt, a kreditet visszaadtuk.' : 'Az eredmény mentése és a kredit-visszatérítés sikertelen. Az esetet naplóztuk.' }, { status: 500 })
      }

      return NextResponse.json({ ...responsePayload, paid_result_id: paidSave.record?.id || null })
    } finally {
      await releaseRequestLock(lock.lockId)
    }
  } catch (error) {
    console.error('Title studio error:', error)
    return NextResponse.json({ error: 'Cím-generálás sikertelen. Próbáld újra.' }, { status: 500 })
  }
}

// PATCH — kivalasztott cim mentese a Video Idea title_ideas mezojebe.
export async function PATCH(request: NextRequest) {
  try {
    const { topic, title, platform, paid_result_id } = await request.json()
    if (typeof topic !== 'string' || !topic.trim() || topicInputTooLong(topic) || typeof title !== 'string' || !title.trim() || title.length > 100 || typeof paid_result_id !== 'string' || !paid_result_id.trim()) return NextResponse.json({ error: 'Hiányzó vagy hibás adatok' }, { status: 400 })
    if (platform != null && platform !== 'youtube') return NextResponse.json({ error: 'Nem támogatott platform.' }, { status: 400 })
    const topicValue = topic.trim()
    const titleValue = title.trim()

    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const paid = await getPaidResultById(userId, paid_result_id)
    const paidPayload = paid?.result_json as { topic?: unknown; variations?: unknown } | null
    const paidVariations = Array.isArray(paidPayload?.variations) ? paidPayload.variations as Array<{ title?: unknown }> : []
    if (!paid || paid.tool_type !== 'title_studio' || typeof paidPayload?.topic !== 'string' || paidPayload.topic.trim() !== topicValue || !paidVariations.some(v => v?.title === titleValue)) return NextResponse.json({ error: 'A cím nem tartozik a saját fizetett Title Studio eredményedhez.' }, { status: 403 })

    const admin = createAdminClient()
    const platformValue = platform || 'youtube'
    const inputHash = buildVideoIdeaInputHash({ userId, topic: topicValue, platform: platformValue })

    const { data: existing } = await admin
      .from('video_ideas')
      .select('id, title_ideas')
      .eq('user_id', userId)
      .eq('input_hash', inputHash)
      .single()

    const currentTitleIdeas: string[] = Array.isArray(existing?.title_ideas) ? existing.title_ideas : []
    const updatedTitleIdeas = currentTitleIdeas.includes(titleValue) ? currentTitleIdeas : [...currentTitleIdeas, titleValue]

    const result = await ensureVideoIdea(admin, {
      userId,
      topic: topicValue,
      platform: platformValue,
      inputHash,
    })
    if (!result.success || !result.idea) return NextResponse.json({ error: 'Mentés sikertelen.' }, { status: 500 })

    const { error: updateError } = await admin.from('video_ideas').update({ title_ideas: updatedTitleIdeas }).eq('id', result.idea.id).eq('user_id', userId)
    if (updateError) return NextResponse.json({ error: 'Mentés sikertelen.' }, { status: 500 })

    return NextResponse.json({ success: true, video_idea_id: result.idea.id })
  } catch (error) {
    console.error('Title studio save error:', error)
    return NextResponse.json({ error: 'Mentés sikertelen.' }, { status: 500 })
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
    if (!paid || paid.tool_type !== 'title_studio') return NextResponse.json({ error: 'Az eredmény nem található' }, { status: 404 })

    const opened = await openPaidResult(paid)
    return NextResponse.json({ ...(opened.result_json as object), ...paidResultResponseMeta(opened) })
  } catch (error) {
    console.error('Title studio GET error:', error)
    return NextResponse.json({ error: 'Szerverhiba' }, { status: 500 })
  }
}
