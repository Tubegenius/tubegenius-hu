import { NextRequest, NextResponse } from 'next/server'
import { MODELS } from '@/lib/models'
import { getUserId, logUsage, chargeFeature, hasEnoughCredits } from '@/lib/credits'
import { callAIProvider, extractJson } from '@/lib/services/ai-provider-service'
import type { SimilarVideo, OpportunityScoreBreakdown } from '@/types'

// ─── "Mutass hasonlót" — ugyanazon bizonyíték videókból más szöget ad Claude (Haiku) ───
// NULLA YouTube API hívás — cache-elt evidence_videos-ból dolgozunk.
export async function POST(request: NextRequest) {
  try {
    const { original_title, keyword, niche, score_breakdown, evidence_videos } = await request.json()

    if (!original_title || !evidence_videos) {
      return NextResponse.json({ error: 'Hiányzó adatok' }, { status: 400 })
    }

    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    // Korabban ez a route nem vont le kreditet, pedig van ra definialt ar
    // (CREDIT_COSTS.opportunity_explain) — ez hiba volt, nem szandekos ingyenesseg.
    const enoughCredits = await hasEnoughCredits(userId, 'opportunity_explain')
    if (!enoughCredits) {
      return NextResponse.json({ error: 'Nincs elegendő kredited ehhez a művelethez.' }, { status: 402 })
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

    return NextResponse.json({ title: result.title, description: result.description })
  } catch (error) {
    console.error('Opportunity similar error:', error)
    return NextResponse.json({ error: 'Generálás sikertelen.' }, { status: 500 })
  }
}
