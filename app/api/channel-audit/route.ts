import { NextRequest, NextResponse } from 'next/server'
import { MODELS } from '@/lib/models'
import { getUserId, hasEnoughCredits, chargeFeature, logUsage, CREDIT_COSTS } from '@/lib/credits'
import { callAIProvider, extractJson } from '@/lib/services/ai-provider-service'
import { createAdminClient } from '@/lib/supabase-server'
import { computeDimensionAverages, findWeakestDimension, computePublishRhythm, buildNextVideosPrompt, filterRelevantAudits } from '@/lib/channel-audit'
import { polishHungarianOutput } from '@/lib/hungarian-output-polish'
import { buildPaidResultHash, normalizePaidResultInput, savePaidResult, getPaidResultByHash, getPaidResultById, openPaidResult, paidResultResponseMeta } from '@/lib/paid-results/paid-results-service'
import { acquireRequestLock, releaseRequestLock, REQUEST_IN_PROGRESS_ERROR } from '@/lib/request-lock'

const MIN_AUDITS_REQUIRED = 3

// GET — ket mod egy route-on:
// 1) ?paidResultId=... — egy korabban kifizetett "kovetkezo 10 video"
//    javaslat visszanyitasa, kredit nelkul.
// 2) parameter nelkul — aggregalt Channel Audit elonezet (dimenzio-atlagok,
//    top/bottom auditok, publikalasi ritmus). Kredit nelkul mindket esetben.
export async function GET(request: NextRequest) {
  const userId = await getUserId()
  if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

  const paidResultId = request.nextUrl.searchParams.get('paidResultId')
  if (paidResultId) {
    const paid = await getPaidResultById(userId, paidResultId)
    if (!paid) return NextResponse.json({ error: 'A mentett javaslat nem található' }, { status: 404 })
    const opened = await openPaidResult(paid)
    return NextResponse.json({ ...(polishHungarianOutput(opened.result_json) as object), ...paidResultResponseMeta(opened) })
  }

  const admin = createAdminClient()

  const [{ data: audits }, { data: publishedIdeas }, { data: profileRow }] = await Promise.all([
    admin.from('video_audits').select('id, video_title, topic, overall_score, overall_label, final_scores, created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(50),
    admin.from('video_ideas').select('updated_at').eq('user_id', userId).eq('workflow_status', 'published'),
    admin.from('profiles').select('niche, main_category, specific_focus').eq('user_id', userId).single(),
  ])
  // A profiles.niche mezo a legtobb aktiv route-nal sosem toltodik ki — a
  // valos niche-informacio a main_category/specific_focus mezokben el (lasd
  // lib/niche-relevance.ts shouldUseProfileNiche ugyanezt a mintat koveti).
  const effectiveNiche = [profileRow?.niche, profileRow?.main_category, profileRow?.specific_focus].filter(Boolean).join(' ')

  const auditList = audits || []
  if (auditList.length < MIN_AUDITS_REQUIRED) {
    return NextResponse.json({
      has_enough_data: false,
      audit_count: auditList.length,
      min_required: MIN_AUDITS_REQUIRED,
    })
  }

  const dimensionAverages = computeDimensionAverages(auditList)
  const weakestDimension = dimensionAverages ? findWeakestDimension(dimensionAverages) : null
  // A "legerosebb/leggyengebb temak" kijelzeshez relevancia-szurt lista kell —
  // enelkul egy egyszeri teszt/vicc celbol auditalt, teljesen off-niche videó
  // (pl. zenei klip) is bekerulhet ide es a "kovetkezo 10 video" promptba is.
  // A dimenzio-atlagok (fent) NEM szurtek, mert azok keszseg-mertekek, nem tema-fuggoek.
  const relevantForTopics = filterRelevantAudits(auditList, effectiveNiche)
  const sorted = [...relevantForTopics].sort((a, b) => b.overall_score - a.overall_score)
  const topStrong = sorted.slice(0, 3).map(a => ({ id: a.id, video_title: a.video_title, overall_score: a.overall_score, overall_label: a.overall_label, created_at: a.created_at }))
  const topWeak = sorted.slice(-3).reverse().map(a => ({ id: a.id, video_title: a.video_title, overall_score: a.overall_score, overall_label: a.overall_label, created_at: a.created_at }))
  const publishRhythm = computePublishRhythm(publishedIdeas || [])

  return NextResponse.json({
    has_enough_data: true,
    audit_count: auditList.length,
    dimension_averages: dimensionAverages,
    weakest_dimension: weakestDimension,
    top_strong: topStrong,
    top_weak: topWeak,
    publish_rhythm: publishRhythm,
    niche: effectiveNiche,
  })
}

// POST — AI-generalt "kovetkezo 10 video" javaslat a valos aggregalt
// adatra alapozva. Kredit-koteles. Az input_hash a jelenlegi audit-
// pillanatkepen (leggyengebb dimenzio + erős/gyenge temak) alapul — ha az
// audit-tortenet nem valtozott ket keres kozott, ugyanazt a mentett
// javaslatot kapja vissza a user kredit nelkul; ha valtozott, a hash is
// mas lesz, es termeszetesen uj (fizetos) javaslat keszul.
export async function POST(request: NextRequest) {
  try {
    const { force_refresh } = await request.json().catch(() => ({ force_refresh: false }))

    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const admin = createAdminClient()
    const { data: audits } = await admin
      .from('video_audits')
      .select('video_title, topic, overall_score, final_scores')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50)

    const auditList = audits || []
    if (auditList.length < MIN_AUDITS_REQUIRED) {
      return NextResponse.json({ error: `Legalább ${MIN_AUDITS_REQUIRED} Videódiagnózis szükséges ehhez.` }, { status: 400 })
    }

    const { data: profileRow } = await admin.from('profiles').select('niche, main_category, specific_focus').eq('user_id', userId).single()
    // A profiles.niche mezo sosem toltodik ki a legtobb route-nal — a valos
    // niche-informacio a main_category/specific_focus mezokben el.
    const effectiveNiche = [profileRow?.niche, profileRow?.main_category, profileRow?.specific_focus].filter(Boolean).join(' ')
    const dimensionAverages = computeDimensionAverages(auditList)
    const weakest = dimensionAverages ? findWeakestDimension(dimensionAverages) : null
    // Relevancia-szures — lasd GET agban a reszletes magyarazatot: egy off-niche
    // teszt/vicc audit ne szennyezze a "kovetkezo videok" AI-javaslatot.
    const relevantForTopics = filterRelevantAudits(auditList, effectiveNiche)
    const sorted = [...relevantForTopics].sort((a, b) => b.overall_score - a.overall_score)
    const strongTopics = sorted.slice(0, 3).map(a => a.topic || a.video_title)
    const weakTopics = sorted.slice(-3).map(a => a.topic || a.video_title)

    const normalizedInput = normalizePaidResultInput({ weakest: weakest?.label || '', strongTopics, weakTopics, auditCount: auditList.length })
    const inputHash = buildPaidResultHash({ userId, toolType: 'channel_audit', normalizedInput })

    const lock = await acquireRequestLock({ userId, toolType: 'channel_audit', inputHash })
    if (!lock.acquired) {
      return NextResponse.json({ error: REQUEST_IN_PROGRESS_ERROR }, { status: 409 })
    }

    try {
    if (!force_refresh) {
      const existing = await getPaidResultByHash({ userId, toolType: 'channel_audit', inputHash })
      if (existing) {
        const opened = await openPaidResult(existing)
        return NextResponse.json({ ...(polishHungarianOutput(opened.result_json) as object), ...paidResultResponseMeta(opened) })
      }
    }

    const enoughCredits = await hasEnoughCredits(userId, 'channel_audit')
    if (!enoughCredits) {
      return NextResponse.json({ error: `Nincs elég kredited. Ehhez ${CREDIT_COSTS.channel_audit} kredit szükséges.` }, { status: 402 })
    }

    const prompt = buildNextVideosPrompt({
      weakestDimension: weakest?.label || 'Hook erősség',
      strongTopics,
      weakTopics,
      niche: effectiveNiche,
    })

    const aiCall = await callAIProvider({
      model: MODELS.fast,
      maxTokens: 2000,
      messages: [{ role: 'user', content: prompt }],
      promptTemplateId: 'channel_audit_next_videos',
      promptVersion: 'v1',
    })

    const suggestions = extractJson<Array<{ topic: string; reasoning: string }>>(aiCall.text)

    await logUsage(userId, 'channel_audit', MODELS.fast, aiCall.usage.inputTokens, aiCall.usage.outputTokens, {})

    const charge = await chargeFeature(userId, 'channel_audit', {})
    if (!charge.success) {
      return NextResponse.json({ error: charge.error || 'Nincs elég kredited ehhez a művelethez.' }, { status: 402 })
    }

    const responsePayload = { suggestions }

    const paidSave = await savePaidResult({
      userId,
      toolType: 'channel_audit',
      inputHash,
      normalizedInput,
      originalInput: `channel_audit_${auditList.length}_audits`,
      resultJson: responsePayload,
      summaryJson: { suggestion_count: suggestions.length, weakest_dimension: weakest?.label || null },
      creditCost: CREDIT_COSTS.channel_audit,
      freshForHours: 24 * 7,
      provider: aiCall.provider,
      model: aiCall.model,
      promptTemplateId: aiCall.promptTemplateId,
      promptVersion: aiCall.promptVersion,
      estimatedCost: aiCall.estimatedCost,
    })
    if (!paidSave.success) {
      console.error('[ChannelAudit] KRITIKUS: paid_results mentés sikertelen, a user már fizetett érte:', paidSave.error)
    }

    return NextResponse.json({
      ...(polishHungarianOutput(responsePayload) as object),
      _credits_remaining: charge.new_balance,
      paid_result_id: paidSave.record?.id || null,
    })
    } finally {
      await releaseRequestLock(lock.lockId)
    }
  } catch (error) {
    console.error('Channel audit next-videos error:', error)
    return NextResponse.json({ error: 'Javaslat generálása sikertelen. Próbáld újra.' }, { status: 500 })
  }
}
