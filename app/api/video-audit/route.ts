// app/api/video-audit/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { fetchExternal } from '@/lib/external-fetch'
import { createServerSupabaseClient, createAdminClient } from '@/lib/supabase-server'
import { MODELS } from '@/lib/models'
import { chargeFeature, checkPaidFeatureAccess, logUsage, CREDIT_COSTS, refundCreditsAfterPersistenceFailure } from '@/lib/credits'
import { dailySoftLimitError } from '@/lib/daily-soft-limit'
import { callAIProvider, extractJson } from '@/lib/services/ai-provider-service'
import { buildPaidResultHash, normalizePaidResultInput, savePaidResult, getPaidResultByHash, getPaidResultById, openPaidResult, paidResultResponseMeta } from '@/lib/paid-results/paid-results-service'
import { polishHungarianOutput } from '@/lib/hungarian-output-polish'
import {
  Platform,
  scoreYouTubeBackend,
  scoreManualBackend,
  computeFinalScores,
  computeDecision,
  computeConfidence,
  interpretScore,
  YouTubeApiData,
  ManualPlatformData,
  BackendScores,
  isAuditPlatform,
  validateManualPlatformData,
} from '@/lib/video-audit-scoring'
import { acquireRequestLock, releaseRequestLock, REQUEST_IN_PROGRESS_ERROR } from '@/lib/request-lock'

async function fetchYouTubeData(videoId: string): Promise<YouTubeApiData | null> {
  const { getActiveApiKey } = await import('@/lib/youtube-service')
  const apiKey = getActiveApiKey()
  if (!apiKey) return null
  try {
    const res = await fetchExternal('YouTube',
      `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&part=snippet,statistics,contentDetails&key=${apiKey}`
    )
    const data = await res.json()
    if (!data.items?.length) return null
    const item = data.items[0]
    const s = item.statistics
    const sn = item.snippet
    const dur = item.contentDetails.duration as string
    const match = dur.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/)
    const seconds = (parseInt(match?.[1] ?? '0') * 3600) +
                    (parseInt(match?.[2] ?? '0') * 60) +
                    (parseInt(match?.[3] ?? '0'))
    return {
      title: sn.title ?? '',
      description: sn.description ?? '',
      duration_seconds: seconds,
      views: parseInt(s.viewCount ?? '0'),
      likes: parseInt(s.likeCount ?? '0'),
      comments: parseInt(s.commentCount ?? '0'),
      published_at: sn.publishedAt ?? new Date().toISOString(),
      channel_subscribers: undefined,
      tags: sn.tags ?? [],
      thumbnail_url: sn.thumbnails?.high?.url ?? sn.thumbnails?.default?.url,
    }
  } catch { return null }
}

function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:v=|\/embed\/|\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ]
  for (const p of patterns) {
    const m = url.match(p)
    if (m) return m[1]
  }
  return null
}

interface ClaudeInterpretationResult {
  parsed: Record<string, unknown>
  inputTokens: number
  outputTokens: number
  estimatedCost: number
  provider: string
  model: string
  promptTemplateId: string | null
  promptVersion: string | null
}

async function getClaudeInterpretation(
  platform: Platform,
  inputData: YouTubeApiData | ManualPlatformData,
  backendScores: BackendScores,
): Promise<ClaudeInterpretationResult> {
  const title = 'title' in inputData ? inputData.title : (inputData as ManualPlatformData).title
  const topic = 'topic' in inputData ? (inputData as ManualPlatformData).topic : title

  const prompt = `Te egy magyar creator intelligence rendszer vagy. Elemezz egy ${platform} videot.

Video adatok:
- Cim: ${title}
- Tema: ${topic}
- Platform: ${platform}
- Backend hook score: ${backendScores.hook_strength?.score}
- Backend retencio score: ${backendScores.retention_potential?.score}
- Backend engagement score: ${backendScores.engagement_quality?.score}
- Backend platform fit score: ${backendScores.platform_fit?.score}
- Backend csomagolas score: ${backendScores.packaging_quality?.score}

MAGYAR NYELVI MINŐSÉG - KÖTELEZŐ:
- Minden magyar szöveg helyes magyar ékezetekkel készüljön.
- Ne írj ilyeneket: passszív, szoveg, fo problema, uj cim, ajanlas.
- Használj természetes, prémium magyar megfogalmazást, ne gépies fordítást.

KRITIKUS JSON SZABÁLYOK:
- SOHA ne használj idézőjelet a JSON string értékek BELSEJÉBEN.
- Minden string érték egy soros legyen, sortörés nélkül.
- Csak pure JSON-t adj vissza, semmi más szöveget.

Adj vissza egy JSON objektumot ezzel a struktúrával:
{
  "hook_strength": {
    "quality_score": 75,
    "assessment": "medium",
    "reason": "egy soros szoveg",
    "suggested_fix": "egy soros szoveg"
  },
  "retention_potential": {
    "quality_score": 70,
    "assessment": "medium",
    "reason": "egy soros szoveg",
    "suggested_fix": "egy soros szoveg"
  },
  "engagement_quality": {
    "quality_score": 65,
    "assessment": "medium",
    "reason": "egy soros szoveg",
    "suggested_fix": "egy soros szoveg"
  },
  "platform_fit": {
    "quality_score": 70,
    "assessment": "medium",
    "reason": "egy soros szoveg",
    "suggested_fix": "egy soros szoveg"
  },
  "packaging_quality": {
    "quality_score": 65,
    "assessment": "medium",
    "reason": "egy soros szoveg",
    "suggested_fix": "egy soros szoveg"
  },
  "diagnosis": "egy soros szoveg - mi a fo problema",
  "new_hook_suggestion": "egy soros szoveg - konkret uj hook javaslat",
  "new_title_suggestion": "egy soros szoveg - konkret uj cim javaslat",
  "new_caption_suggestion": "egy soros szoveg - uj caption javaslat",
  "hashtag_suggestions": ["hashtag1", "hashtag2", "hashtag3"],
  "upload_time_suggestion": "egy soros szoveg",
  "platform_specific_tip": "egy soros szoveg"
}`

  const aiCall = await callAIProvider({
    model: MODELS.primary,
    maxTokens: 1500,
    messages: [{ role: 'user', content: prompt }],
    promptTemplateId: 'video_audit_interpretation',
    promptVersion: 'v1',
  })

  return {
    parsed: extractJson<Record<string, unknown>>(aiCall.text),
    inputTokens: aiCall.usage.inputTokens,
    outputTokens: aiCall.usage.outputTokens,
    estimatedCost: aiCall.estimatedCost,
    provider: aiCall.provider,
    model: aiCall.model,
    promptTemplateId: aiCall.promptTemplateId,
    promptVersion: aiCall.promptVersion,
  }
}

export async function POST(req: NextRequest) {
  try {
    // Auth: user kliens
    const supabase = createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await req.json()
    const { platform, video_url, manual_data } = body as {
      platform: Platform
      video_url?: string
      manual_data?: ManualPlatformData
    }

    if (!isAuditPlatform(platform)) return NextResponse.json({ error: 'Érvénytelen vagy hiányzó platform' }, { status: 400 })

    let validatedManualData: ManualPlatformData | undefined
    if (manual_data !== undefined) {
      const validation = validateManualPlatformData(manual_data, platform)
      if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 })
      validatedManualData = validation.data
    }
    if (video_url !== undefined && (typeof video_url !== 'string' || video_url.length > 500)) {
      return NextResponse.json({ error: 'Érvénytelen videó URL' }, { status: 400 })
    }

    const isYouTube = platform === 'youtube_long' || platform === 'youtube_shorts'
    const videoIdForHash = isYouTube && video_url ? extractVideoId(video_url) : null
    const paidNormalizedInput = normalizePaidResultInput({
      platform,
      video_id: videoIdForHash || null,
      video_url: videoIdForHash ? null : (video_url || null),
      manual_data: videoIdForHash ? null : (validatedManualData || null),
    })
    const paidInputHash = buildPaidResultHash({
      userId: user.id,
      toolType: 'video_audit',
      normalizedInput: paidNormalizedInput,
      platform,
    })
    const lock = await acquireRequestLock({ userId: user.id, toolType: 'video_audit', inputHash: paidInputHash })
    if (!lock.acquired) {
      return NextResponse.json({ error: REQUEST_IN_PROGRESS_ERROR }, { status: 409 })
    }

    try {
    const paid = await getPaidResultByHash({ userId: user.id, toolType: 'video_audit', inputHash: paidInputHash })
    if (paid) {
      const opened = await openPaidResult(paid)
      return NextResponse.json({
        ...(polishHungarianOutput(opened.result_json) as object),
        ...paidResultResponseMeta(opened),
      })
    }

    const access = await checkPaidFeatureAccess(user.id, 'video_audit', req.headers.get('x-daily-soft-limit-override') === 'true')
    if (access.reason === 'daily_soft_limit' && access.dailyLimit) return NextResponse.json(dailySoftLimitError(access.dailyLimit), { status: 429 })
    if (!access.allowed) {
      return NextResponse.json({ error: 'Nincs elég kredited. Ehhez ' + CREDIT_COSTS.video_audit + ' kredit szükséges.' }, { status: 402 })
    }

    // Admin kliens: RLS bypass a mentéshez
    const admin = createAdminClient()
    let inputData: YouTubeApiData | ManualPlatformData
    let backendScores
    let hasApiData = false

    if (isYouTube && video_url) {
      const videoId = extractVideoId(video_url)
      if (!videoId) return NextResponse.json({ error: 'Érvénytelen YouTube URL' }, { status: 400 })
      const ytData = await fetchYouTubeData(videoId)
      if (!ytData) return NextResponse.json({ error: 'YouTube videó nem található' }, { status: 404 })
      inputData = ytData
      backendScores = scoreYouTubeBackend(ytData, platform)
      hasApiData = true
    } else if (validatedManualData) {
      inputData = validatedManualData
      backendScores = scoreManualBackend(validatedManualData)
    } else {
      return NextResponse.json({ error: 'Hiányzó videóadat' }, { status: 400 })
    }

    // Claude interpretáció
    const aiResult = await getClaudeInterpretation(platform, inputData, backendScores)
    const claudeInterpretation = polishHungarianOutput(aiResult.parsed) as Record<string, unknown>
    await logUsage(user.id, 'video_audit', aiResult.model, aiResult.inputTokens, aiResult.outputTokens, { platform })

    // Final scores
    const finalScores = computeFinalScores(
      backendScores,
      claudeInterpretation as Record<string, { quality_score: number }>,
      platform,
    )

    // Decision
    const { decision, weakest_dimension, decision_reason } = computeDecision(finalScores)

    // Overall értelmezés
    const overallInterpretation = interpretScore(finalScores.overall, 'audit')

    // Kredit levonás — csak sikeres elemzés után
    const chargeResult = await chargeFeature(user.id, 'video_audit')
    if (!chargeResult.success) {
      return NextResponse.json({ error: chargeResult.error || 'Nincs elég kredited ehhez a művelethez.' }, { status: 402 })
    }

    // Confidence
    const views = 'views' in inputData ? inputData.views : 0
    const hasBehavioralMetrics = !hasApiData && 'completion_rate' in inputData && (
      inputData.completion_rate !== undefined || inputData.avg_watch_time_seconds !== undefined
    )
    const confidence = computeConfidence(platform, views, hasApiData, hasBehavioralMetrics)

    const title = 'title' in inputData ? inputData.title : (inputData as ManualPlatformData).title
    const topic = 'topic' in inputData ? (inputData as ManualPlatformData).topic : title

    // Mentés admin klienssel (RLS bypass)
    const { data: savedAudit, error: insertError } = await admin.from('video_audits').insert({
      user_id: user.id,
      platform,
      video_url: video_url ?? null,
      video_title: title,
      topic,
      input_data: inputData,
      backend_scores: backendScores,
      claude_interpretation: claudeInterpretation,
      final_scores: finalScores,
      overall_score: finalScores.overall,
      overall_label: overallInterpretation.label,
      confidence,
      diagnosis: (claudeInterpretation.diagnosis as string) ?? '',
      recommendations: {
        new_hook: claudeInterpretation.new_hook_suggestion,
        new_title: claudeInterpretation.new_title_suggestion,
        new_caption: claudeInterpretation.new_caption_suggestion,
        hashtags: claudeInterpretation.hashtag_suggestions,
        upload_time: claudeInterpretation.upload_time_suggestion,
        platform_tip: claudeInterpretation.platform_specific_tip,
        dimension_fixes: {
          hook: (claudeInterpretation.hook_strength as Record<string, unknown>)?.suggested_fix,
          retention: (claudeInterpretation.retention_potential as Record<string, unknown>)?.suggested_fix,
          engagement: (claudeInterpretation.engagement_quality as Record<string, unknown>)?.suggested_fix,
          platform_fit: (claudeInterpretation.platform_fit as Record<string, unknown>)?.suggested_fix,
          packaging: (claudeInterpretation.packaging_quality as Record<string, unknown>)?.suggested_fix,
        },
      },
      decision,
      created_at: new Date().toISOString(),
    }).select('id').single()

    if (insertError) {
      console.error('video_audits insert error:', insertError)
    }

    // Creator Memory auto-mentés admin klienssel
    if (savedAudit?.id) {
      await admin.from('creator_memory').upsert({
        user_id: user.id,
        topic,
        search_keyword: topic,
        state: 'saved',
        platform,
        audit_score: finalScores.overall,
        audit_id: savedAudit.id,
      }, { onConflict: 'user_id,topic' })
    }

    const responsePayload = {
      audit_id: savedAudit?.id,
      platform,
      video_title: title,
      overall_score: finalScores.overall,
      overall_label: overallInterpretation.label,
      overall_meaning: overallInterpretation.meaning,
      overall_risk: overallInterpretation.risk_level,
      overall_action: overallInterpretation.recommended_action,
      confidence,
      decision,
      weakest_dimension,
      decision_reason,
      final_scores: finalScores,
      backend_scores: backendScores,
      claude_interpretation: claudeInterpretation,
      diagnosis: claudeInterpretation.diagnosis,
      recommendations: {
        new_hook: claudeInterpretation.new_hook_suggestion,
        new_title: claudeInterpretation.new_title_suggestion,
        new_caption: claudeInterpretation.new_caption_suggestion,
        hashtags: claudeInterpretation.hashtag_suggestions,
        upload_time: claudeInterpretation.upload_time_suggestion,
        platform_tip: claudeInterpretation.platform_specific_tip,
      },
    }

    const paidSave = await savePaidResult({
      userId: user.id,
      toolType: 'video_audit',
      inputHash: paidInputHash,
      normalizedInput: paidNormalizedInput,
      originalInput: title || topic || video_url || 'Video audit',
      platform,
      resultJson: responsePayload,
      summaryJson: { title, topic, platform, overall_score: finalScores.overall, decision },
      creditCost: CREDIT_COSTS.video_audit,
      freshForHours: 24,
      sourceRunId: savedAudit?.id || null,
      provider: aiResult.provider,
      model: aiResult.model,
      promptTemplateId: aiResult.promptTemplateId,
      promptVersion: aiResult.promptVersion,
      estimatedCost: aiResult.estimatedCost,
    })
    if (!paidSave.success) {
      console.error('[VideoAudit] KRITIKUS: paid_results mentés sikertelen, a user már fizetett érte:', paidSave.error)
      const refund = await refundCreditsAfterPersistenceFailure(user.id, 'video_audit', CREDIT_COSTS.video_audit, { reason: 'paid_result_save_failed' }, chargeResult.credit_transaction_id)
      if (!refund.success) console.error('[VideoAudit] KRITIKUS: automatikus kredit-visszatérítés sikertelen')
      return NextResponse.json({ error: refund.success ? 'Az eredmény mentése sikertelen volt, a kreditet visszaadtuk.' : 'Az eredmény mentése és a kredit-visszatérítés sikertelen. Az esetet naplóztuk.' }, { status: 500 })
    }

    return NextResponse.json({ ...responsePayload, paid_result_id: paidSave.record?.id || null })
    } finally {
      await releaseRequestLock(lock.lockId)
    }
  } catch (err) {
    console.error('Video audit error:', err)
    return NextResponse.json({ error: 'Szerverhiba' }, { status: 500 })
  }
}

// GET — audit visszanyitás id VAGY paidResultId alapján
export async function GET(req: NextRequest) {
  try {
    const supabase = createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const paidResultId = req.nextUrl.searchParams.get('paidResultId')
    if (paidResultId) {
      const paid = await getPaidResultById(user.id, paidResultId)
      if (!paid) return NextResponse.json({ error: 'Audit nem található' }, { status: 404 })
      const opened = await openPaidResult(paid)
      return NextResponse.json({
        ...(polishHungarianOutput(opened.result_json) as object),
        ...paidResultResponseMeta(opened),
      })
    }

    const admin = createAdminClient()
    const id = req.nextUrl.searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'id kötelező' }, { status: 400 })

    const { data, error } = await admin
      .from('video_audits')
      .select('*')
      .eq('id', id)
      .eq('user_id', user.id)
      .single()

    if (error || !data) return NextResponse.json({ error: 'Audit nem található' }, { status: 404 })
    return NextResponse.json(data)
  } catch (err) {
    return NextResponse.json({ error: 'Szerverhiba' }, { status: 500 })
  }
}
