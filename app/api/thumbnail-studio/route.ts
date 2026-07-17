import { NextRequest, NextResponse } from 'next/server'
import { MODELS } from '@/lib/models'
import { getUserId, checkPaidFeatureAccess, chargeFeature, logUsage, CREDIT_COSTS, refundCreditsAfterPersistenceFailure } from '@/lib/credits'
import { dailySoftLimitError } from '@/lib/daily-soft-limit'
import { callAIProvider, extractJson } from '@/lib/services/ai-provider-service'
import { buildPaidResultHash, normalizePaidResultInput, savePaidResult, getPaidResultByHash, getPaidResultById, openPaidResult, paidResultResponseMeta } from '@/lib/paid-results/paid-results-service'
import { createAdminClient } from '@/lib/supabase-server'
import { checkThumbnailText, isValidThumbnailConcept, buildThumbnailStudioPrompt, sanitizeThumbnailConcept, thumbnailConceptIdentity, validateDistinctThumbnailConcepts, type ThumbnailConcept } from '@/lib/thumbnail-studio'
import { polishHungarianText } from '@/lib/hungarian-output-polish'
import { ensureVideoIdea, buildVideoIdeaInputHash } from '@/lib/video-ideas/video-idea-service'
import { resolveCreatorNicheContext } from '@/lib/creator-profile-context'
import { acquireRequestLock, releaseRequestLock, REQUEST_IN_PROGRESS_ERROR } from '@/lib/request-lock'
import { topicInputTooLong, topicTooLongResponseMessage } from '@/lib/api-input-validation'
import { renderPromptTemplate } from '@/lib/prompts/template-registry'
import { PROMPT_TEMPLATES } from '@/lib/prompts/catalog'

export async function POST(request: NextRequest) {
  try {
    const { topic, platform, region, force_refresh } = await request.json()
    if (!topic || typeof topic !== 'string' || !topic.trim()) {
      return NextResponse.json({ error: 'Téma megadása kötelező' }, { status: 400 })
    }
    if (topicInputTooLong(topic)) return NextResponse.json({ error: topicTooLongResponseMessage() }, { status: 400 })
    if (platform != null && platform !== 'youtube') return NextResponse.json({ error: 'Nem támogatott platform.' }, { status: 400 })
    if (region != null && !['HU', 'US'].includes(region)) return NextResponse.json({ error: 'Nem támogatott régió.' }, { status: 400 })
    if (force_refresh != null && typeof force_refresh !== 'boolean') return NextResponse.json({ error: 'Hibás frissítési beállítás.' }, { status: 400 })
    const topicValue = topic.trim()

    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const admin = createAdminClient()
    const { data: profileRow } = await admin.from('profiles').select('niche, main_category, specific_focus, channel_usage_mode').eq('user_id', userId).single()
    const { niche, useNiche } = resolveCreatorNicheContext({ topic: topicValue, channelUsageMode: profileRow?.channel_usage_mode, niche: profileRow?.niche, mainCategory: profileRow?.main_category, specificFocus: profileRow?.specific_focus })
    const platformValue = platform || 'youtube'
    const regionValue = region || 'HU'

    const normalizedInput = normalizePaidResultInput({ topic: topicValue, platform: platformValue, region: regionValue, niche: useNiche ? niche : '', useNiche })
    const inputHash = buildPaidResultHash({ userId, toolType: 'thumbnail_studio', normalizedInput, platform: platformValue, region: regionValue })

    const lock = await acquireRequestLock({ userId, toolType: 'thumbnail_studio', inputHash })
    if (!lock.acquired) {
      return NextResponse.json({ error: REQUEST_IN_PROGRESS_ERROR }, { status: 409 })
    }

    try {
      const paid = !force_refresh ? await getPaidResultByHash({ userId, toolType: 'thumbnail_studio', inputHash }) : null
      if (paid) {
        const opened = await openPaidResult(paid)
        return NextResponse.json({ ...(opened.result_json as object), ...paidResultResponseMeta(opened) })
      }

      const access = await checkPaidFeatureAccess(userId, 'thumbnail_studio', request.headers.get('x-daily-soft-limit-override') === 'true')
      if (access.reason === 'daily_soft_limit' && access.dailyLimit) return NextResponse.json(dailySoftLimitError(access.dailyLimit), { status: 429 })
      if (!access.allowed) {
        return NextResponse.json({ error: `Nincs elég kredited. Ehhez ${CREDIT_COSTS.thumbnail_studio} kredit szükséges.` }, { status: 402 })
      }

      const renderedPrompt = renderPromptTemplate(PROMPT_TEMPLATES.thumbnailStudioConcepts, () => buildThumbnailStudioPrompt({ topic: topicValue, niche, useNiche, platform: platformValue }))
      const aiCall = await callAIProvider({
        model: MODELS.fast,
        maxTokens: 2000,
        messages: [{ role: 'user', content: renderedPrompt.text }],
        promptTemplateId: renderedPrompt.templateId,
        promptVersion: renderedPrompt.version,
      })

      const rawConcepts = validateDistinctThumbnailConcepts(extractJson<unknown>(aiCall.text))
      const concepts = validateDistinctThumbnailConcepts(rawConcepts.map(c => ({
        ...c,
        concept_label: polishHungarianText(c.concept_label || ''),
        visual_description: polishHungarianText(c.visual_description || ''),
        thumbnail_text: polishHungarianText(c.thumbnail_text || ''),
        composition_note: polishHungarianText(c.composition_note || ''),
        emotion_or_conflict: polishHungarianText(c.emotion_or_conflict || ''),
      }))).map(c => ({ ...c, text_check: checkThumbnailText(c.thumbnail_text) }))

      await logUsage(userId, 'thumbnail_studio', MODELS.fast, aiCall.usage.inputTokens, aiCall.usage.outputTokens, { topic: topicValue })

      const charge = await chargeFeature(userId, 'thumbnail_studio', { topic: topicValue })
      if (!charge.success) {
        return NextResponse.json({ error: charge.error || 'Nincs elég kredited ehhez a művelethez.' }, { status: 402 })
      }

      const responsePayload = {
        topic: topicValue,
        concepts,
        scoring_methodology: 'subjective_ai_visual_review_not_ctr_or_ab_test',
        _credits_remaining: charge.new_balance,
      }

      const paidSave = await savePaidResult({
        userId,
        toolType: 'thumbnail_studio',
        inputHash,
        normalizedInput,
        originalInput: topicValue,
        platform: platformValue,
        region: regionValue,
        resultJson: responsePayload,
        summaryJson: { topic: topicValue, concept_count: concepts.length, methodology: 'subjective_ai_visual_review_not_ctr_or_ab_test' },
        creditCost: CREDIT_COSTS.thumbnail_studio,
        freshForHours: 24,
        provider: aiCall.provider,
        model: aiCall.model,
        promptTemplateId: aiCall.promptTemplateId,
        promptVersion: aiCall.promptVersion,
        estimatedCost: aiCall.estimatedCost,
      })
      if (!paidSave.success) {
        console.error('[ThumbnailStudio] KRITIKUS: paid_results mentés sikertelen, a user már fizetett érte:', paidSave.error)
        const refund = await refundCreditsAfterPersistenceFailure(userId, 'thumbnail_studio', CREDIT_COSTS.thumbnail_studio, { reason: 'paid_result_save_failed' }, charge.credit_transaction_id)
        if (!refund.success) console.error('[ThumbnailStudio] KRITIKUS: automatikus kredit-visszatérítés sikertelen')
        return NextResponse.json({ error: refund.success ? 'Az eredmény mentése sikertelen volt, a kreditet visszaadtuk.' : 'Az eredmény mentése és a kredit-visszatérítés sikertelen. Az esetet naplóztuk.' }, { status: 500 })
      }

      return NextResponse.json({ ...responsePayload, paid_result_id: paidSave.record?.id || null })
    } finally {
      await releaseRequestLock(lock.lockId)
    }
  } catch (error) {
    console.error('Thumbnail studio error:', error)
    return NextResponse.json({ error: 'Koncepció-generálás sikertelen. Próbáld újra.' }, { status: 500 })
  }
}

// PATCH — kivalasztott koncepcio mentese a Video Idea thumbnail_concepts mezojebe.
export async function PATCH(request: NextRequest) {
  try {
    const { topic, concept, platform, paid_result_id } = await request.json()
    if (typeof topic !== 'string' || !topic.trim() || topicInputTooLong(topic) || !isValidThumbnailConcept(concept) || typeof paid_result_id !== 'string' || !paid_result_id.trim()) return NextResponse.json({ error: 'Hiányzó vagy hibás adatok' }, { status: 400 })
    if (platform != null && platform !== 'youtube') return NextResponse.json({ error: 'Nem támogatott platform.' }, { status: 400 })
    const topicValue = topic.trim()
    const conceptValue = sanitizeThumbnailConcept(concept)

    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const paid = await getPaidResultById(userId, paid_result_id)
    const paidPayload = paid?.result_json as { topic?: unknown; concepts?: unknown } | null
    const paidConcepts = Array.isArray(paidPayload?.concepts) ? paidPayload.concepts.filter(isValidThumbnailConcept) : []
    if (!paid || paid.tool_type !== 'thumbnail_studio' || typeof paidPayload?.topic !== 'string' || paidPayload.topic.trim() !== topicValue || !paidConcepts.some(c => thumbnailConceptIdentity(c) === thumbnailConceptIdentity(conceptValue))) return NextResponse.json({ error: 'A koncepció nem tartozik a saját fizetett Thumbnail Studio eredményedhez.' }, { status: 403 })

    const admin = createAdminClient()
    const platformValue = platform || 'youtube'
    const inputHash = buildVideoIdeaInputHash({ userId, topic: topicValue, platform: platformValue })

    const { data: existing } = await admin
      .from('video_ideas')
      .select('id, thumbnail_concepts')
      .eq('user_id', userId)
      .eq('input_hash', inputHash)
      .single()

    const current: unknown[] = Array.isArray(existing?.thumbnail_concepts) ? existing.thumbnail_concepts : []
    const conceptIdentity = thumbnailConceptIdentity(conceptValue)
    const alreadySaved = current.some(item => isValidThumbnailConcept(item) && thumbnailConceptIdentity(item) === conceptIdentity)
    const updated = alreadySaved ? current : [...current, conceptValue]

    const result = await ensureVideoIdea(admin, { userId, topic: topicValue, platform: platformValue, inputHash })
    if (!result.success || !result.idea) return NextResponse.json({ error: 'Mentés sikertelen.' }, { status: 500 })

    const { error: updateError } = await admin.from('video_ideas').update({ thumbnail_concepts: updated }).eq('id', result.idea.id).eq('user_id', userId)
    if (updateError) return NextResponse.json({ error: 'Mentés sikertelen.' }, { status: 500 })

    return NextResponse.json({ success: true, video_idea_id: result.idea.id })
  } catch (error) {
    console.error('Thumbnail studio save error:', error)
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
    if (!paid || paid.tool_type !== 'thumbnail_studio') return NextResponse.json({ error: 'Az eredmény nem található' }, { status: 404 })

    const opened = await openPaidResult(paid)
    return NextResponse.json({ ...(opened.result_json as object), ...paidResultResponseMeta(opened) })
  } catch (error) {
    console.error('Thumbnail studio GET error:', error)
    return NextResponse.json({ error: 'Szerverhiba' }, { status: 500 })
  }
}
