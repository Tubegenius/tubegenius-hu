import { NextRequest, NextResponse } from 'next/server'
import { MODELS } from '@/lib/models'
import { getUserId, checkPaidFeatureAccess, chargeFeature, logUsage, CREDIT_COSTS, refundCreditsAfterPersistenceFailure } from '@/lib/credits'
import { dailySoftLimitError } from '@/lib/daily-soft-limit'
import { callAIProvider, extractJson } from '@/lib/services/ai-provider-service'
import { isValidNextVideoSuggestions } from '@/lib/generated-output-validation'
import { createAdminClient } from '@/lib/supabase-server'
import { computeDimensionAverages, findWeakestDimension, computePublishRhythm, buildNextVideosPrompt, filterRelevantAudits, hasValidOverallScore, hasValidDimensionScores } from '@/lib/channel-audit'
import { polishHungarianOutput } from '@/lib/hungarian-output-polish'
import { buildPaidResultHash, normalizePaidResultInput, savePaidResult, getPaidResultByHash, getPaidResultById, openPaidResult, paidResultResponseMeta } from '@/lib/paid-results/paid-results-service'
import { acquireRequestLock, releaseRequestLock, REQUEST_IN_PROGRESS_ERROR } from '@/lib/request-lock'
import { isNicheReviewRequired } from '@/lib/channel-scope'

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

  const { data: profileRow, error: profileError } = await admin.from('profiles')
    .select('niche, main_category, specific_focus, active_channel_id, niche_needs_review, niche_validated_for_channel_id, detected_niche_candidates')
    .eq('user_id', userId).single()
  if (profileError || !profileRow) return NextResponse.json({ error: 'A Channel Audit forrasadatainak betoltese sikertelen.' }, { status: 500 })
  const activeChannelId = profileRow.active_channel_id as string | null
  const nicheReviewRequired = isNicheReviewRequired({
    storedReviewFlag: Boolean(profileRow.niche_needs_review),
    validatedForChannelId: profileRow.niche_validated_for_channel_id || null,
    candidates: profileRow.detected_niche_candidates,
    activeChannelId,
  })
  if (!activeChannelId) return NextResponse.json({ has_enough_data: false, audit_count: 0, min_required: MIN_AUDITS_REQUIRED, relevant_audit_count: 0, min_relevant_required: MIN_AUDITS_REQUIRED, can_generate_suggestions: false, niche_review_required: nicheReviewRequired, active_channel_id: null, no_active_channel: true })
  const [{ data: audits, error: auditsError }, { data: publishedIdeas, error: publishedIdeasError }, { count: legacyAuditCount, error: legacyCountError }] = await Promise.all([
    admin.from('video_audits').select('id, video_title, topic, overall_score, overall_label, final_scores, created_at').eq('user_id', userId).eq('youtube_channel_id', activeChannelId).order('created_at', { ascending: false }).limit(50),
    admin.from('video_ideas').select('updated_at').eq('user_id', userId).eq('workflow_status', 'published'),
    admin.from('video_audits').select('id', { count: 'exact', head: true }).eq('user_id', userId).is('youtube_channel_id', null),
  ])
  if (legacyCountError) return NextResponse.json({ error: 'A legacy auditok szamlalasa sikertelen.' }, { status: 500 })
  if (auditsError || publishedIdeasError || profileError) return NextResponse.json({ error: 'A Channel Audit forrásadatainak betöltése sikertelen.' }, { status: 500 })
  // A profiles.niche mezo a legtobb aktiv route-nal sosem toltodik ki — a
  // valos niche-informacio a main_category/specific_focus mezokben el (lasd
  // lib/niche-relevance.ts shouldUseProfileNiche ugyanezt a mintat koveti).
  const effectiveNiche = nicheReviewRequired
    ? ''
    : [profileRow.niche, profileRow.main_category, profileRow.specific_focus].filter(Boolean).join(' ')

  const auditList = (audits || []).filter(audit => hasValidOverallScore(audit) && hasValidDimensionScores(audit))
  const relevantForTopics = filterRelevantAudits(auditList, effectiveNiche)
  // These audits are already scoped to the active YouTube channel. Lexical
  // niche matching may rank them, but a false negative must not force the
  // creator to purchase the same three audits again.
  const topicEvidence = relevantForTopics.length >= MIN_AUDITS_REQUIRED ? relevantForTopics : auditList
  if (auditList.length < MIN_AUDITS_REQUIRED) {
    return NextResponse.json({
      has_enough_data: false,
      audit_count: auditList.length,
      min_required: MIN_AUDITS_REQUIRED,
      relevant_audit_count: relevantForTopics.length,
      min_relevant_required: MIN_AUDITS_REQUIRED,
      can_generate_suggestions: false,
      niche_review_required: nicheReviewRequired,
      active_channel_id: activeChannelId,
      legacy_unassigned_audit_count: legacyAuditCount || 0,
    })
  }

  const dimensionAverages = computeDimensionAverages(auditList)
  const weakestDimension = dimensionAverages ? findWeakestDimension(dimensionAverages) : null
  // A "legerosebb/leggyengebb temak" kijelzeshez relevancia-szurt lista kell —
  // enelkul egy egyszeri teszt/vicc celbol auditalt, teljesen off-niche videó
  // (pl. zenei klip) is bekerulhet ide es a "kovetkezo 10 video" promptba is.
  // A dimenzio-atlagok (fent) NEM szurtek, mert azok keszseg-mertekek, nem tema-fuggoek.
  const sorted = [...topicEvidence].sort((a, b) => b.overall_score - a.overall_score)
  const topStrong = sorted.slice(0, 3).map(a => ({ id: a.id, video_title: a.video_title, overall_score: a.overall_score, overall_label: a.overall_label, created_at: a.created_at }))
  const topWeak = sorted.slice(-3).reverse().map(a => ({ id: a.id, video_title: a.video_title, overall_score: a.overall_score, overall_label: a.overall_label, created_at: a.created_at }))
  const publishRhythm = computePublishRhythm(publishedIdeas || [])

  return NextResponse.json({
    has_enough_data: true,
    audit_count: auditList.length,
    relevant_audit_count: relevantForTopics.length,
    min_relevant_required: MIN_AUDITS_REQUIRED,
    can_generate_suggestions: !nicheReviewRequired && auditList.length >= MIN_AUDITS_REQUIRED,
    using_channel_scope_fallback: relevantForTopics.length < MIN_AUDITS_REQUIRED,
    dimension_averages: dimensionAverages,
    weakest_dimension: weakestDimension,
    top_strong: topStrong,
    top_weak: topWeak,
    workflow_completion_rhythm: publishRhythm,
    niche: effectiveNiche,
    niche_review_required: nicheReviewRequired,
    active_channel_id: activeChannelId,
    legacy_unassigned_audit_count: legacyAuditCount || 0,
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
    const { data: channelProfileRow, error: channelProfileError } = await admin.from('profiles')
      .select('active_channel_id, niche_needs_review, niche_validated_for_channel_id, detected_niche_candidates')
      .eq('user_id', userId).single()
    if (channelProfileError || !channelProfileRow) return NextResponse.json({ error: 'A csatornaprofil betoltese sikertelen.' }, { status: 500 })
    const activeChannelId = channelProfileRow.active_channel_id as string | null
    if (!activeChannelId) return NextResponse.json({ error: 'Elobb valassz aktiv YouTube-csatornat.', no_active_channel: true }, { status: 400 })
    const nicheReviewRequired = isNicheReviewRequired({
      storedReviewFlag: Boolean(channelProfileRow.niche_needs_review),
      validatedForChannelId: channelProfileRow.niche_validated_for_channel_id || null,
      candidates: channelProfileRow.detected_niche_candidates,
      activeChannelId,
    })
    if (nicheReviewRequired) {
      return NextResponse.json({ error: 'A Creator Profile niche megerositese szukseges az uj csatornahoz.', niche_review_required: true }, { status: 409 })
    }
    const { data: audits, error: auditsError } = await admin
      .from('video_audits')
      .select('video_title, topic, overall_score, final_scores')
      .eq('user_id', userId)
      .eq('youtube_channel_id', activeChannelId)
      .order('created_at', { ascending: false })
      .limit(50)
    if (auditsError) return NextResponse.json({ error: 'A Videódiagnózis-előzmények betöltése sikertelen.' }, { status: 500 })

    const auditList = (audits || []).filter(audit => hasValidOverallScore(audit) && hasValidDimensionScores(audit))
    if (auditList.length < MIN_AUDITS_REQUIRED) {
      return NextResponse.json({ error: `Legalább ${MIN_AUDITS_REQUIRED} Videódiagnózis szükséges ehhez.` }, { status: 400 })
    }

    const { data: profileRow, error: profileError } = await admin.from('profiles').select('niche, main_category, specific_focus').eq('user_id', userId).single()
    if (profileError) return NextResponse.json({ error: 'A csatornaprofil betöltése sikertelen.' }, { status: 500 })
    // A profiles.niche mezo sosem toltodik ki a legtobb route-nal — a valos
    // niche-informacio a main_category/specific_focus mezokben el.
    const effectiveNiche = [profileRow?.niche, profileRow?.main_category, profileRow?.specific_focus].filter(Boolean).join(' ')
    const dimensionAverages = computeDimensionAverages(auditList)
    const weakest = dimensionAverages ? findWeakestDimension(dimensionAverages) : null
    // Relevancia-szures — lasd GET agban a reszletes magyarazatot: egy off-niche
    // teszt/vicc audit ne szennyezze a "kovetkezo videok" AI-javaslatot.
    const relevantForTopics = filterRelevantAudits(auditList, effectiveNiche)
    const topicEvidence = relevantForTopics.length >= MIN_AUDITS_REQUIRED ? relevantForTopics : auditList
    const sorted = [...topicEvidence].sort((a, b) => b.overall_score - a.overall_score)
    const strongTopics = sorted.slice(0, 3).map(a => a.topic || a.video_title)
    const weakTopics = sorted.slice(-3).map(a => a.topic || a.video_title)

    const auditSnapshot = auditList.map(a => ({ title: a.video_title, topic: a.topic, score: a.overall_score, final: a.final_scores }))
    const normalizedInput = normalizePaidResultInput({ activeChannelId, weakest: weakest?.label || '', strongTopics, weakTopics, auditSnapshot, niche: effectiveNiche })
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

    const access = await checkPaidFeatureAccess(userId, 'channel_audit', request.headers.get('x-daily-soft-limit-override') === 'true')
    if (access.reason === 'daily_soft_limit' && access.dailyLimit) return NextResponse.json(dailySoftLimitError(access.dailyLimit), { status: 429 })
    if (!access.allowed) {
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
    if (!isValidNextVideoSuggestions(suggestions)) throw new Error('Invalid channel audit suggestions returned by AI provider')

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
      const refund = await refundCreditsAfterPersistenceFailure(userId, 'channel_audit', CREDIT_COSTS.channel_audit, { reason: 'paid_result_save_failed' }, charge.credit_transaction_id)
      if (!refund.success) console.error('[ChannelAudit] KRITIKUS: automatikus kredit-visszatérítés sikertelen')
      return NextResponse.json({ error: refund.success ? 'Az eredmény mentése sikertelen volt, a kreditet visszaadtuk.' : 'Az eredmény mentése és a kredit-visszatérítés sikertelen. Az esetet naplóztuk.' }, { status: 500 })
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
