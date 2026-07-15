import { NextRequest, NextResponse } from 'next/server'
import { MODELS } from '@/lib/models'
import { getUserId, logUsage, chargeFeature, checkPaidFeatureAccess, CREDIT_COSTS, refundCreditsAfterPersistenceFailure } from '@/lib/credits'
import { dailySoftLimitError } from '@/lib/daily-soft-limit'
import { callAIProvider, extractJson } from '@/lib/services/ai-provider-service'
import { buildPaidResultHash, normalizePaidResultInput, savePaidResult, getPaidResultByHash, getPaidResultById, openPaidResult, paidResultResponseMeta } from '@/lib/paid-results/paid-results-service'
import type { SimilarVideo, OpportunityScoreBreakdown } from '@/types'
import { acquireRequestLock, releaseRequestLock, REQUEST_IN_PROGRESS_ERROR } from '@/lib/request-lock'

// ─── "Mutass hasonlót" — ugyanazon bizonyíték videókból más szöget ad Claude (Haiku) ───
// NULLA YouTube API hívás — cache-elt evidence_videos-ból dolgozunk.
export async function POST(request: NextRequest) {
  try {
    const { original_title, keyword, niche, score_breakdown, evidence_videos, paidResultId, force_refresh } = await request.json()

    if (!original_title || !evidence_videos) {
      return NextResponse.json({ error: 'Hiányzó adatok' }, { status: 400 })
    }

    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    // ─── Amit a user egyszer megvett, azt bármikor visszakapja kredit nélkül —
    // input_hash alapján, ugyanaz az elv, mint minden más fizetős eszköznél.
    // Csak explicit force_refresh indít új, fizetős generálást.
    const normalizedInput = normalizePaidResultInput({ variant: 'similar', original_title, keyword: keyword || '', niche: niche || '' })
    const inputHash = buildPaidResultHash({ userId, toolType: 'opportunity_explain', normalizedInput })

    const lock = await acquireRequestLock({ userId, toolType: 'opportunity_similar', inputHash })
    if (!lock.acquired) {
      return NextResponse.json({ error: REQUEST_IN_PROGRESS_ERROR }, { status: 409 })
    }

    try {
    if (!force_refresh) {
      const paid = (await getPaidResultById(userId, paidResultId)) || (await getPaidResultByHash({ userId, toolType: 'opportunity_explain', inputHash }))
      if (paid) {
        const opened = await openPaidResult(paid)
        return NextResponse.json({ ...(opened.result_json as object), ...paidResultResponseMeta(opened) })
      }
    }

    const access = await checkPaidFeatureAccess(userId, 'opportunity_explain', request.headers.get('x-daily-soft-limit-override') === 'true')
    if (access.reason === 'daily_soft_limit' && access.dailyLimit) return NextResponse.json(dailySoftLimitError(access.dailyLimit), { status: 429 })
    if (!access.allowed) {
      return NextResponse.json({ error: `Nincs elég kredited. Ehhez ${CREDIT_COSTS.opportunity_explain} kredit szükséges.` }, { status: 402 })
    }

    const videos = evidence_videos as SimilarVideo[]
    const breakdown = score_breakdown as OpportunityScoreBreakdown

    const prompt = `Egy magyar tartalomgyártónak korábban ezt a videótéma-javaslatot adtuk:

EREDETI TÉMA: "${original_title}"
KULCSSZÓ: "${keyword}"
NICHE: ${niche || 'általános'}

A user ezt nem szeretné ebben a formában, de a TÉMAKÖR jó neki — más feldolgozási SZÖGET kér ugyanarra a témakörre.

ALAPADATOK (ugyanazok, mint az eredetinél — ezek nem változnak):
- Opportunity Score: ${breakdown.total}/100
- Top videók: ${videos.slice(0, 3).map(v => `${v.title.replace(/["']/g, '')} (${v.view_count.toLocaleString()} megtekintés, ${v.channel_title})`).join('; ')}

FELADAT:
Adj egy MÁSIK, konkrét magyar videótéma-javaslatot UGYANEBBEN a témakörben/kulcsszóban, de más feldolgozási szöggel (más kérdésfelvetés, más nézőpont, más fókusz). NE ismételd meg az eredeti címet vagy annak szinonimáját.

Példa más szögekre: "Miért nem...", "Ami senki nem mond el...", "A valódi ok amiért...", összehasonlítás, jövőbeli hatás, hétköznapi vonatkozás.

Írj 1-2 mondatos magyar indoklást is, ami a fenti adatokra hivatkozik.

KRITIKUS JSON SZABÁLYOK:
- SOHA ne használj " vagy ' karaktert a JSON string értékek BELSEJÉBEN.
- Minden string érték egy soros legyen, sortörés nélkül.

Válaszolj KIZÁRÓLAG valid JSON-ban:
{"title": "Új, más szögű magyar videótéma", "description": "1-2 mondatos magyar indoklás"}`

    const aiCall = await callAIProvider({
      model: MODELS.fast,
      maxTokens: 400,
      messages: [{ role: 'user', content: prompt }],
      promptTemplateId: 'opportunity_explain_similar',
      promptVersion: 'v1',
    })

    const result = extractJson<{ title: string; description: string }>(aiCall.text)

    await logUsage(userId, 'opportunity_explain', MODELS.fast, aiCall.usage.inputTokens, aiCall.usage.outputTokens, { type: 'similar', keyword })

    const chargeResult = await chargeFeature(userId, 'opportunity_explain', { type: 'similar', keyword })
    if (!chargeResult.success) {
      return NextResponse.json({ error: chargeResult.error || 'Nincs elegendő kredited ehhez a művelethez.' }, { status: 402 })
    }

    const responsePayload = { title: result.title, description: result.description }

    const paidSave = await savePaidResult({
      userId,
      toolType: 'opportunity_explain',
      inputHash,
      normalizedInput,
      originalInput: original_title,
      resultJson: responsePayload,
      summaryJson: { variant: 'similar', keyword: keyword || '', title: result.title },
      creditCost: CREDIT_COSTS.opportunity_explain,
      freshForHours: 24,
      provider: aiCall.provider,
      model: aiCall.model,
      promptTemplateId: aiCall.promptTemplateId,
      promptVersion: aiCall.promptVersion,
      estimatedCost: aiCall.estimatedCost,
    })
    if (!paidSave.success) {
      console.error('[OpportunitySimilar] KRITIKUS: paid_results mentés sikertelen, a user már fizetett érte:', paidSave.error)
      const refund = await refundCreditsAfterPersistenceFailure(userId, 'opportunity_explain', CREDIT_COSTS.opportunity_explain, { reason: 'paid_result_save_failed' })
      if (!refund.success) console.error('[OpportunitySimilar] KRITIKUS: automatikus kredit-visszatérítés sikertelen')
      return NextResponse.json({ error: refund.success ? 'Az eredmény mentése sikertelen volt, a kreditet visszaadtuk.' : 'Az eredmény mentése és a kredit-visszatérítés sikertelen. Az esetet naplóztuk.' }, { status: 500 })
    }

    return NextResponse.json({ ...responsePayload, paid_result_id: paidSave.record?.id || null })
    } finally {
      await releaseRequestLock(lock.lockId)
    }
  } catch (error) {
    console.error('Opportunity similar error:', error)
    return NextResponse.json({ error: 'Generálás sikertelen.' }, { status: 500 })
  }
}

// GET — mentett "Mutass hasonlót" eredmény visszanyitása paidResultId alapján, kredit nélkül.
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
    console.error('Opportunity similar GET error:', error)
    return NextResponse.json({ error: 'Szerverhiba' }, { status: 500 })
  }
}
