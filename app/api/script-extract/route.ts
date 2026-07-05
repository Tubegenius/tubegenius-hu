import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { MODELS } from '@/lib/models'
import { getUserId, logUsage, hasEnoughCredits, chargeFeature, CREDIT_COSTS } from '@/lib/credits'
import { buildPaidResultHash, normalizePaidResultInput, savePaidResult, getPaidResultById, openPaidResult } from '@/lib/paid-results/paid-results-service'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
import { getActiveApiKey } from '@/lib/youtube-service'

function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
  ]
  for (const p of patterns) {
    const m = url.match(p)
    if (m) return m[1]
  }
  return null
}

function parseDuration(iso: string): string {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/)
  if (!m) return 'N/A'
  const h = parseInt(m[1] || '0')
  const min = parseInt(m[2] || '0')
  const s = parseInt(m[3] || '0')
  const totalMin = h * 60 + min + (s > 30 ? 1 : 0)
  if (totalMin <= 1) return '< 1 perc'
  return `${totalMin}-${totalMin + 1} perc`
}

async function tryTranscriptExtraction(videoId: string): Promise<{ available: boolean; text: string | null }> {
  try {
    const { YoutubeTranscript } = await import('youtube-transcript')
    const segments = await YoutubeTranscript.fetchTranscript(videoId)
    if (segments && segments.length > 0) {
      const text = segments.map(s => s.text).join(' ')
      return { available: true, text }
    }
    return { available: false, text: null }
  } catch {
    return { available: false, text: null }
  }
}

function extractJson(text: string): unknown {
  let cleaned = text.replace(/```json|```/g, '').trim()
  const firstBrace = cleaned.indexOf('{')
  const lastBrace = cleaned.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1)
  }
  try { return JSON.parse(cleaned) }
  catch (e) { console.error('JSON parse failed:', cleaned.slice(0, 2000)); throw e }
}

export async function POST(request: NextRequest) {
  try {
    const { url } = await request.json()
    if (!url) return NextResponse.json({ error: 'URL megadása kötelező' }, { status: 400 })

    const videoId = extractVideoId(url)
    if (!videoId) return NextResponse.json({ error: 'Érvénytelen YouTube URL' }, { status: 400 })

    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const enoughCredits = await hasEnoughCredits(userId, 'script_extract')
    if (!enoughCredits) {
      return NextResponse.json({ error: `Nincs elég kredited. Ehhez ${CREDIT_COSTS.script_extract} kredit szükséges.` }, { status: 402 })
    }

    // 1. YouTube metaadatok lekerese
    const YOUTUBE_API_KEY = getActiveApiKey()
    const videoUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${videoId}&key=${YOUTUBE_API_KEY}`
    const videoRes = await fetch(videoUrl)
    const videoData = await videoRes.json()

    if (!videoData.items || videoData.items.length === 0) {
      return NextResponse.json({ error: 'Videó nem található vagy nem publikus' }, { status: 404 })
    }

    const item = videoData.items[0]
    const snippet = item.snippet
    const stats = item.statistics
    const duration = parseDuration(item.contentDetails?.duration || '')

    // 2. Opcionalis transcript
    const transcriptResult = await tryTranscriptExtraction(videoId)

    // 3. Claude elemzes
    let prompt: string

    if (transcriptResult.available && transcriptResult.text) {
      const truncatedTranscript = transcriptResult.text.slice(0, 6000)

      prompt = `Egy YouTube video VALOS feliratszoveget (transcript) kapod. Elemezd a strukturajat MAGYARUL.

CIM: "${snippet.title}"
CSATORNA: ${snippet.channelTitle}
HOSSZ: ${duration}

TRANSCRIPT (a video tenyleges elhangzott szovege, lehet angol):
${truncatedTranscript}

FELADAT:
A VALOS transcript alapjan elemezd MAGYARUL:
- Hook (az elso mondatok, hogyan ragadja meg a figyelmet)
- Narracios struktura szakaszokra bontva, timestamp beclessel
- Kulcspontok
- Miert mukodhetett ez a video (sikerfaktorok)

NE talalj ki semmit, amit nem talalsz a transcriptben. Ez VALOS elemzes, nem becsles.

KRITIKUS JSON SZABALYOK:
- Mindig PARAFRAZALD magyarul a tartalmat, NE irj bele szo szerinti angol idezeteket idezojelekkel.
- SOHA ne hasznalj idezojelet a JSON string ertekek BELSEJEBEN.
- Minden string ertek egy soros legyen, sortores nelkul.
- Rovid, tomor mondatokat irj.

Valaszolj KIZAROLAG valid JSON-ban:
{
  "hook": "Az elso mondatok elemzese magyarul",
  "structure": [
    {"timestamp": "0:00", "label": "Szakasz neve", "content": "Mi tortenik itt magyarul", "type": "hook|intro|main|cta|outro"}
  ],
  "key_points": ["Kulcspont 1 magyarul", "Kulcspont 2 magyarul"],
  "success_factors": "2-3 mondat magyarul"
}`
    } else {
      prompt = `Egy YouTube video METAADATAIT kapod (cim, leiras, statisztikak). Transcript NEM all rendelkezesre, ezert BECSULT strukturaelemzest kell adnod.

CIM: "${snippet.title}"
LEIRAS: ${(snippet.description || '').slice(0, 1000)}
CSATORNA: ${snippet.channelTitle}
HOSSZ: ${duration}
MEGTEKINTES: ${stats.viewCount || 0}

FELADAT:
A cim, leiras es statisztikak alapjan adj BECSLEST a video valoszinu strukturajarol. Jelold a szovegben hogy ez feltetelezes (valoszinuleg, feltehetoen).

KRITIKUS JSON SZABALYOK:
- SOHA ne hasznalj idezojelet a JSON string ertekek BELSEJEBEN.
- Minden string ertek egy soros legyen, sortores nelkul.

Valaszolj KIZAROLAG valid JSON-ban:
{
  "hook": "Feltetelezett hook a cim/leiras alapjan, jelold becslesnek",
  "structure": [
    {"timestamp": "0:00", "label": "Szakasz neve", "content": "Feltetelezett tartalom", "type": "hook|intro|main|cta|outro"}
  ],
  "key_points": ["Feltetelezett kulcspont 1", "Feltetelezett kulcspont 2"],
  "success_factors": "2-3 mondat becsles arrol, miert lehetett sikeres"
}`
    }

    const message = await anthropic.messages.create({
      model: MODELS.primary,
      max_tokens: 2500,
      messages: [{ role: 'user', content: prompt }],
    })

    const responseText = message.content.filter(b => b.type === 'text').map(b => (b as { type: 'text'; text: string }).text).join('')
    const analysis = extractJson(responseText) as {
      hook: string
      structure: Array<{ timestamp: string; label: string; content: string; type: string }>
      key_points: string[]
      success_factors: string
    }

    await logUsage(userId, 'script_extract', MODELS.primary, message.usage.input_tokens, message.usage.output_tokens, { videoId, transcript_available: transcriptResult.available })
    const charge = await chargeFeature(userId, 'script_extract', { videoId })
    if (!charge.success) {
      return NextResponse.json({ error: charge.error || 'Nincs elég kredited ehhez a művelethez.' }, { status: 402 })
    }

    const wordCount = transcriptResult.text ? transcriptResult.text.split(/\s+/).length : 0

    const responsePayload = {
      video_id: videoId,
      title: snippet.title,
      channel: snippet.channelTitle,
      hook: analysis.hook,
      structure: analysis.structure,
      key_points: analysis.key_points,
      success_factors: analysis.success_factors,
      estimated_duration: duration,
      word_count: wordCount,
      stats: {
        view_count: parseInt(stats.viewCount || '0'),
        like_count: parseInt(stats.likeCount || '0'),
        comment_count: parseInt(stats.commentCount || '0'),
      },
      metadata_only: !transcriptResult.available,
      transcript_available: transcriptResult.available,
      transcript_source: transcriptResult.available ? 'transcript' : 'metadata',
      raw_transcript: transcriptResult.available && transcriptResult.text ? transcriptResult.text.slice(0, 12000) : null,
      _credits_remaining: charge.new_balance,
    }

    const normalizedInput = normalizePaidResultInput({ videoId, url })
    const inputHash = buildPaidResultHash({
      userId,
      toolType: 'script_extract',
      normalizedInput,
      platform: 'youtube',
    })
    const paidSave = await savePaidResult({
      userId,
      toolType: 'script_extract',
      inputHash,
      normalizedInput,
      originalInput: snippet.title || url,
      platform: 'youtube',
      resultJson: responsePayload,
      summaryJson: { title: snippet.title, videoId, transcript_available: transcriptResult.available },
      creditCost: CREDIT_COSTS.script_extract,
      freshForHours: 24,
    })
    if (!paidSave.success) {
      console.error('[ScriptExtract] KRITIKUS: paid_results mentés sikertelen, a user már fizetett érte:', paidSave.error)
    }

    return NextResponse.json({ ...responsePayload, paid_result_id: paidSave.record?.id || null })
  } catch (error) {
    console.error('Script extract error:', error)
    return NextResponse.json({ error: 'Elemzés sikertelen. Próbáld újra.' }, { status: 500 })
  }
}

// GET — kinyert script visszanyitása paidResultId alapján (a "Legutóbbi
// történeted" panelről érkező, perzisztens megvett eredmény) — kredit nélkül.
export async function GET(request: NextRequest) {
  try {
    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const paidResultId = request.nextUrl.searchParams.get('paidResultId')
    if (!paidResultId) return NextResponse.json({ error: 'paidResultId kötelező' }, { status: 400 })

    const paid = await getPaidResultById(userId, paidResultId)
    if (!paid) return NextResponse.json({ error: 'A kinyert script nem található' }, { status: 404 })

    const opened = await openPaidResult(paid)
    return NextResponse.json({ ...(opened.result_json as object), paid_result_id: opened.id })
  } catch (error) {
    console.error('Script extract GET error:', error)
    return NextResponse.json({ error: 'Szerverhiba' }, { status: 500 })
  }
}
