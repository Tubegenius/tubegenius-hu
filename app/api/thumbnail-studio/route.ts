import { NextRequest, NextResponse } from 'next/server'
import { MODELS } from '@/lib/models'
import { getUserId, hasEnoughCredits, chargeFeature, logUsage, CREDIT_COSTS } from '@/lib/credits'
import { callAIProvider, extractJson } from '@/lib/services/ai-provider-service'
import { buildPaidResultHash, normalizePaidResultInput, savePaidResult, getPaidResultByHash, getPaidResultById, openPaidResult, paidResultResponseMeta } from '@/lib/paid-results/paid-results-service'
import { createAdminClient } from '@/lib/supabase-server'
import { checkThumbnailText, buildThumbnailStudioPrompt, type ThumbnailConcept } from '@/lib/thumbnail-studio'
import { polishHungarianText } from '@/lib/hungarian-output-polish'
import { ensureVideoIdea, buildVideoIdeaInputHash } from '@/lib/video-ideas/video-idea-service'
import { shouldUseProfileNiche } from '@/lib/niche-relevance'

export async function POST(request: NextRequest) {
  try {
    const { topic, platform, region } = await request.json()
    if (!topic || typeof topic !== 'string') {
      return NextResponse.json({ error: 'Téma megadása kötelező' }, { status: 400 })
    }

    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const admin = createAdminClient()
    const { data: profileRow } = await admin.from('profiles').select('niche, main_category, specific_focus').eq('user_id', userId).single()
    const niche = profileRow?.niche || ''
    const useNiche = shouldUseProfileNiche({ topic, profileNiche: niche, mainCategory: profileRow?.main_category, specificFocus: profileRow?.specific_focus })
    const platformValue = platform || 'youtube'
    const regionValue = region || 'HU'

    const normalizedInput = normalizePaidResultInput({ topic, platform: platformValue })
    const inputHash = buildPaidResultHash({ userId, toolType: 'thumbnail_studio', normalizedInput, platform: platformValue })

    const paid = await getPaidResultByHash({ userId, toolType: 'thumbnail_studio', inputHash })
    if (paid) {
      const opened = await openPaidResult(paid)
      return NextResponse.json({ ...(opened.result_json as object), ...paidResultResponseMeta(opened) })
    }

    const enoughCredits = await hasEnoughCredits(userId, 'thumbnail_studio')
    if (!enoughCredits) {
      return NextResponse.json({ error: `Nincs elég kredited. Ehhez ${CREDIT_COSTS.thumbnail_studio} kredit szükséges.` }, { status: 402 })
    }

    const prompt = buildThumbnailStudioPrompt({ topic, niche, useNiche, platform: platformValue })
    const aiCall = await callAIProvider({
      model: MODELS.fast,
      maxTokens: 1500,
      messages: [{ role: 'user', content: prompt }],
      promptTemplateId: 'thumbnail_studio_concepts',
      promptVersion: 'v1',
    })

    const rawConcepts = extractJson<ThumbnailConcept[]>(aiCall.text)
    const concepts = rawConcepts.map(c => ({
      ...c,
      visual_description: polishHungarianText(c.visual_description || ''),
      thumbnail_text: polishHungarianText(c.thumbnail_text || ''),
      composition_note: polishHungarianText(c.composition_note || ''),
      emotion_or_conflict: polishHungarianText(c.emotion_or_conflict || ''),
      text_check: checkThumbnailText(c.thumbnail_text || ''),
    }))

    await logUsage(userId, 'thumbnail_studio', MODELS.fast, aiCall.usage.inputTokens, aiCall.usage.outputTokens, { topic })

    const charge = await chargeFeature(userId, 'thumbnail_studio', { topic })
    if (!charge.success) {
      return NextResponse.json({ error: charge.error || 'Nincs elég kredited ehhez a művelethez.' }, { status: 402 })
    }

    const responsePayload = {
      topic,
      concepts,
      _credits_remaining: charge.new_balance,
    }

    const paidSave = await savePaidResult({
      userId,
      toolType: 'thumbnail_studio',
      inputHash,
      normalizedInput,
      originalInput: topic,
      platform: platformValue,
      region: regionValue,
      resultJson: responsePayload,
      summaryJson: { topic, concept_count: concepts.length },
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
    }

    return NextResponse.json({ ...responsePayload, paid_result_id: paidSave.record?.id || null })
  } catch (error) {
    console.error('Thumbnail studio error:', error)
    return NextResponse.json({ error: 'Koncepció-generálás sikertelen. Próbáld újra.' }, { status: 500 })
  }
}

// PATCH — kivalasztott koncepcio mentese a Video Idea thumbnail_concepts mezojebe.
export async function PATCH(request: NextRequest) {
  try {
    const { topic, concept, platform } = await request.json()
    if (!topic || !concept) return NextResponse.json({ error: 'Hiányzó adatok' }, { status: 400 })

    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const admin = createAdminClient()
    const platformValue = platform || 'youtube'
    const inputHash = buildVideoIdeaInputHash({ userId, topic, platform: platformValue })

    const { data: existing } = await admin
      .from('video_ideas')
      .select('id, thumbnail_concepts')
      .eq('user_id', userId)
      .eq('input_hash', inputHash)
      .single()

    const current: unknown[] = Array.isArray(existing?.thumbnail_concepts) ? existing.thumbnail_concepts : []
    const updated = [...current, concept]

    const result = await ensureVideoIdea(admin, { userId, topic, platform: platformValue, inputHash })
    if (!result.success || !result.idea) return NextResponse.json({ error: 'Mentés sikertelen.' }, { status: 500 })

    await admin.from('video_ideas').update({ thumbnail_concepts: updated }).eq('id', result.idea.id)

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
    if (!paid) return NextResponse.json({ error: 'Az eredmény nem található' }, { status: 404 })

    const opened = await openPaidResult(paid)
    return NextResponse.json({ ...(opened.result_json as object), ...paidResultResponseMeta(opened) })
  } catch (error) {
    console.error('Thumbnail studio GET error:', error)
    return NextResponse.json({ error: 'Szerverhiba' }, { status: 500 })
  }
}
