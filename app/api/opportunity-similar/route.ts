import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { MODELS } from '@/lib/models'
import { createServerSupabaseClient, createAdminClient } from '@/lib/supabase-server'
import { getUserId, logUsage } from '@/lib/credits'
import type { SimilarVideo, OpportunityScoreBreakdown } from '@/types'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

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

    const message = await anthropic.messages.create({
      model: MODELS.fast,
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    })

    const responseText = message.content.filter(b => b.type === 'text').map(b => (b as { type: 'text'; text: string }).text).join('')
    let result: { title: string; description: string }
    {
      let cleaned = responseText.replace(/```json|```/g, '').trim()
      const firstBrace = cleaned.indexOf('{')
      const lastBrace = cleaned.lastIndexOf('}')
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        cleaned = cleaned.slice(firstBrace, lastBrace + 1)
      }
      try {
        result = JSON.parse(cleaned)
      } catch (e) {
        console.error('JSON parse failed. Raw response:', cleaned.slice(0, 1000))
        throw e
      }
    }

    await logUsage(userId, 'opportunity_explain', MODELS.fast, message.usage.input_tokens, message.usage.output_tokens, { type: 'similar', keyword })

    return NextResponse.json({ title: result.title, description: result.description })
  } catch (error) {
    console.error('Opportunity similar error:', error)
    return NextResponse.json({ error: 'Generálás sikertelen.' }, { status: 500 })
  }
}
