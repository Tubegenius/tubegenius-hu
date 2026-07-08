import { NextRequest, NextResponse } from 'next/server'
import { MODELS } from '@/lib/models'
import { getUserId, logUsage, chargeFeature, hasEnoughCredits } from '@/lib/credits'
import { callAIProvider, extractJson } from '@/lib/services/ai-provider-service'
import type { OpportunityScoreBreakdown, SimilarVideo } from '@/types'

// Lazy magyarázat-generálás egy pool candidate-hoz (amikor "Mutass mást" előhívja).
// NULLA YouTube hívás — a candidate adatai (score_breakdown, evidence_videos) már megvannak a cache-ből.
export async function POST(request: NextRequest) {
  try {
    const { keyword, niche, score_breakdown, evidence_videos } = await request.json()

    if (!keyword || !score_breakdown) {
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

    const breakdown = score_breakdown as OpportunityScoreBreakdown
    const videos = (evidence_videos || []) as SimilarVideo[]

    const prompt = `A backend rendszer a következő Opportunity Score-ot számolta egy kulcsszóra egy magyar tartalomgyártó számára.

CREATOR NICHE: ${niche || 'általános'}
KULCSSZÓ: "${keyword}"
Opportunity Score: ${breakdown.total}/100
- Trend Lendület: ${breakdown.trend_momentum}
- Niche Illeszkedés: ${breakdown.niche_match}
- Tartalmi Rés: ${breakdown.content_gap}
- Verseny: ${breakdown.competition}
- Frissesség: ${breakdown.freshness}
Top videók: ${videos.slice(0, 3).map(v => `${v.title.replace(/["']/g, '')} (${v.view_count.toLocaleString()} megtekintés, ${v.channel_title})`).join('; ')}

FELADAT:
1. Egy konkrét, magyar videótéma-javaslat a kulcsszó és a top videók alapján (NE általános a kulcsszó)
2. Egy 1-2 mondatos magyar indoklás, ami a fenti score-okra és videókra hivatkozik

NE adj saját score-t.

KRITIKUS JSON SZABÁLYOK:
- SOHA ne használj " vagy ' karaktert a JSON string értékek BELSEJÉBEN.
- Minden string érték egy soros legyen, sortörés nélkül.

Válaszolj KIZÁRÓLAG valid JSON-ban:
{"title": "Konkrét magyar videótéma", "description": "1-2 mondatos magyar indoklás"}`

    const aiCall = await callAIProvider({
      model: MODELS.fast,
      maxTokens: 400,
      messages: [{ role: 'user', content: prompt }],
      promptTemplateId: 'opportunity_explain_pool',
      promptVersion: 'v1',
    })

    const result = extractJson<{ title: string; description: string }>(aiCall.text)

    await logUsage(userId, 'opportunity_explain', MODELS.fast, aiCall.usage.inputTokens, aiCall.usage.outputTokens, { type: 'pool_explain', keyword })

    const chargeResult = await chargeFeature(userId, 'opportunity_explain', { type: 'pool_explain', keyword })
    if (!chargeResult.success) {
      return NextResponse.json({ error: chargeResult.error || 'Nincs elegendő kredited ehhez a művelethez.' }, { status: 402 })
    }

    return NextResponse.json({ title: result.title, description: result.description })
  } catch (error) {
    console.error('Opportunity explain error:', error)
    return NextResponse.json({ error: 'Magyarázat generálása sikertelen.' }, { status: 500 })
  }
}
