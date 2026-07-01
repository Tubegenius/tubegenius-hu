import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { MODELS } from '@/lib/models'
import { getUserId, logUsage } from '@/lib/credits'
import type { OpportunityScoreBreakdown, SimilarVideo } from '@/types'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

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

    const message = await anthropic.messages.create({
      model: MODELS.fast,
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    })

    const responseText = message.content.filter(b => b.type === 'text').map(b => (b as { type: 'text'; text: string }).text).join('')
    const cleaned = responseText.replace(/```json|```/g, '').trim()
    const firstBrace = cleaned.indexOf('{')
    const lastBrace = cleaned.lastIndexOf('}')
    const jsonStr = firstBrace !== -1 && lastBrace !== -1 ? cleaned.slice(firstBrace, lastBrace + 1) : cleaned
    let result: { title: string; description: string }
    try {
      result = JSON.parse(jsonStr)
    } catch (e) {
      console.error('JSON parse failed. Raw response:', cleaned.slice(0, 1000))
      throw e
    }

    await logUsage(userId, 'opportunity_explain', MODELS.fast, message.usage.input_tokens, message.usage.output_tokens, { type: 'pool_explain', keyword })

    return NextResponse.json({ title: result.title, description: result.description })
  } catch (error) {
    console.error('Opportunity explain error:', error)
    return NextResponse.json({ error: 'Magyarázat generálása sikertelen.' }, { status: 500 })
  }
}
