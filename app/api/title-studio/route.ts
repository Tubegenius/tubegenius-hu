import { NextRequest, NextResponse } from 'next/server'
import { MODELS } from '@/lib/models'
import { getUserId, hasEnoughCredits, chargeFeature, logUsage, CREDIT_COSTS } from '@/lib/credits'
import { callAIProvider, extractJson } from '@/lib/services/ai-provider-service'
import { buildPaidResultHash, normalizePaidResultInput, savePaidResult, getPaidResultByHash, getPaidResultById, openPaidResult, paidResultResponseMeta } from '@/lib/paid-results/paid-results-service'
import { createAdminClient } from '@/lib/supabase-server'
import { computeTitleHeuristics, buildTitleStudioPrompt, validateHungarianTitle, sanitizeHungarianTitle, type TitleVariation } from '@/lib/title-studio'
import { polishHungarianText } from '@/lib/hungarian-output-polish'
import { ensureVideoIdea, buildVideoIdeaInputHash } from '@/lib/video-ideas/video-idea-service'
import { shouldUseProfileNiche } from '@/lib/niche-relevance'
import { acquireRequestLock, releaseRequestLock, REQUEST_IN_PROGRESS_ERROR } from '@/lib/request-lock'

export async function POST(request: NextRequest) {
  try {
    const { topic, existing_title, platform, region, force_refresh } = await request.json()
    if (!topic || typeof topic !== 'string' || !topic.trim()) {
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

    const normalizedInput = normalizePaidResultInput({ topic, existing_title, platform: platformValue })
    const inputHash = buildPaidResultHash({ userId, toolType: 'title_studio', normalizedInput, platform: platformValue })

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

      const enoughCredits = await hasEnoughCredits(userId, 'title_studio')
      if (!enoughCredits) {
        return NextResponse.json({ error: `Nincs elég kredited. Ehhez ${CREDIT_COSTS.title_studio} kredit szükséges.` }, { status: 402 })
      }

      const prompt = buildTitleStudioPrompt({ topic, niche, useNiche, platform: platformValue, existingTitle: existing_title || undefined })
      const aiCall = await callAIProvider({
        model: MODELS.fast,
        maxTokens: 1500,
        messages: [{ role: 'user', content: prompt }],
        promptTemplateId: 'title_studio_variations',
        promptVersion: 'v1',
      })

      const rawVariations = extractJson<TitleVariation[]>(aiCall.text)
      const variations = rawVariations.map(v => {
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
      })

      await logUsage(userId, 'title_studio', MODELS.fast, aiCall.usage.inputTokens, aiCall.usage.outputTokens, { topic })

      const charge = await chargeFeature(userId, 'title_studio', { topic })
      if (!charge.success) {
        return NextResponse.json({ error: charge.error || 'Nincs elég kredited ehhez a művelethez.' }, { status: 402 })
      }

      const responsePayload = {
        topic,
        variations,
        _credits_remaining: charge.new_balance,
      }

      const paidSave = await savePaidResult({
        userId,
        toolType: 'title_studio',
        inputHash,
        normalizedInput,
        originalInput: topic,
        platform: platformValue,
        region: regionValue,
        resultJson: responsePayload,
        summaryJson: { topic, variation_count: variations.length },
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
    const { topic, title, platform } = await request.json()
    if (!topic || !title) return NextResponse.json({ error: 'Hiányzó adatok' }, { status: 400 })

    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const admin = createAdminClient()
    const platformValue = platform || 'youtube'
    const inputHash = buildVideoIdeaInputHash({ userId, topic, platform: platformValue })

    const { data: existing } = await admin
      .from('video_ideas')
      .select('id, title_ideas')
      .eq('user_id', userId)
      .eq('input_hash', inputHash)
      .single()

    const currentTitleIdeas: string[] = Array.isArray(existing?.title_ideas) ? existing.title_ideas : []
    const updatedTitleIdeas = currentTitleIdeas.includes(title) ? currentTitleIdeas : [...currentTitleIdeas, title]

    const result = await ensureVideoIdea(admin, {
      userId,
      topic,
      platform: platformValue,
      inputHash,
    })
    if (!result.success || !result.idea) return NextResponse.json({ error: 'Mentés sikertelen.' }, { status: 500 })

    await admin.from('video_ideas').update({ title_ideas: updatedTitleIdeas }).eq('id', result.idea.id)

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
    if (!paid) return NextResponse.json({ error: 'Az eredmény nem található' }, { status: 404 })

    const opened = await openPaidResult(paid)
    return NextResponse.json({ ...(opened.result_json as object), ...paidResultResponseMeta(opened) })
  } catch (error) {
    console.error('Title studio GET error:', error)
    return NextResponse.json({ error: 'Szerverhiba' }, { status: 500 })
  }
}
