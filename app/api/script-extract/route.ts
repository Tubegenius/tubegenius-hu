import { NextRequest, NextResponse } from 'next/server'
import { fetchExternal } from '@/lib/external-fetch'
import { MODELS } from '@/lib/models'
import { getUserId, logUsage, checkPaidFeatureAccess, chargeFeature, CREDIT_COSTS, refundCreditsAfterPersistenceFailure } from '@/lib/credits'
import { dailySoftLimitError } from '@/lib/daily-soft-limit'
import { callAIProvider, extractJson } from '@/lib/services/ai-provider-service'
import { buildPaidResultHash, normalizePaidResultInput, savePaidResult, getPaidResultByHash, getPaidResultById, openPaidResult, paidResultResponseMeta } from '@/lib/paid-results/paid-results-service'
import { polishHungarianOutput } from '@/lib/hungarian-output-polish'
import { getActiveApiKey } from '@/lib/youtube-service'
import { acquireRequestLock, releaseRequestLock, REQUEST_IN_PROGRESS_ERROR } from '@/lib/request-lock'

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

export async function POST(request: NextRequest) {
  try {
    const { url } = await request.json()
    if (!url) return NextResponse.json({ error: 'URL megadása kötelező' }, { status: 400 })

    const videoId = extractVideoId(url)
    if (!videoId) return NextResponse.json({ error: 'Érvénytelen YouTube URL' }, { status: 400 })

    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const normalizedInput = normalizePaidResultInput({ videoId, url })
    const inputHash = buildPaidResultHash({
      userId,
      toolType: 'script_extract',
      normalizedInput,
      platform: 'youtube',
    })
    const lock = await acquireRequestLock({ userId, toolType: 'script_extract', inputHash })
    if (!lock.acquired) {
      return NextResponse.json({ error: REQUEST_IN_PROGRESS_ERROR }, { status: 409 })
    }

    try {
    const paid = await getPaidResultByHash({ userId, toolType: 'script_extract', inputHash })
    if (paid) {
      const opened = await openPaidResult(paid)
      return NextResponse.json({
        ...(polishHungarianOutput(opened.result_json) as object),
        ...paidResultResponseMeta(opened),
      })
    }

    const access = await checkPaidFeatureAccess(userId, 'script_extract', request.headers.get('x-daily-soft-limit-override') === 'true')
    if (access.reason === 'daily_soft_limit' && access.dailyLimit) return NextResponse.json(dailySoftLimitError(access.dailyLimit), { status: 429 })
    if (!access.allowed) {
      return NextResponse.json({ error: `Nincs elég kredited. Ehhez ${CREDIT_COSTS.script_extract} kredit szükséges.` }, { status: 402 })
    }

    // 1. YouTube metaadatok lekerese
    const YOUTUBE_API_KEY = getActiveApiKey()
    const videoUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${videoId}&key=${YOUTUBE_API_KEY}`
    const videoRes = await fetchExternal('YouTube', videoUrl)
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

    const aiCall = await callAIProvider({
      model: MODELS.primary,
      maxTokens: 2500,
      messages: [{ role: 'user', content: prompt }],
      promptTemplateId: transcriptResult.available ? 'script_extract_transcript' : 'script_extract_metadata_only',
      promptVersion: 'v1',
    })

    const analysis = extractJson<{
      hook: string
      structure: Array<{ timestamp: string; label: string; content: string; type: string }>
      key_points: string[]
      success_factors: string
    }>(aiCall.text)

    await logUsage(userId, 'script_extract', MODELS.primary, aiCall.usage.inputTokens, aiCall.usage.outputTokens, { videoId, transcript_available: transcriptResult.available })
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
      provider: aiCall.provider,
      model: aiCall.model,
      promptTemplateId: aiCall.promptTemplateId,
      promptVersion: aiCall.promptVersion,
      estimatedCost: aiCall.estimatedCost,
    })
    if (!paidSave.success) {
      console.error('[ScriptExtract] KRITIKUS: paid_results mentés sikertelen, a user már fizetett érte:', paidSave.error)
      const refund = await refundCreditsAfterPersistenceFailure(userId, 'script_extract', CREDIT_COSTS.script_extract, { reason: 'paid_result_save_failed' })
      if (!refund.success) console.error('[ScriptExtract] KRITIKUS: automatikus kredit-visszatérítés sikertelen')
      return NextResponse.json({ error: refund.success ? 'Az eredmény mentése sikertelen volt, a kreditet visszaadtuk.' : 'Az eredmény mentése és a kredit-visszatérítés sikertelen. Az esetet naplóztuk.' }, { status: 500 })
    }

    return NextResponse.json({ ...responsePayload, paid_result_id: paidSave.record?.id || null })
    } finally {
      await releaseRequestLock(lock.lockId)
    }
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
    return NextResponse.json({
      ...(polishHungarianOutput(opened.result_json) as object),
      ...paidResultResponseMeta(opened),
    })
  } catch (error) {
    console.error('Script extract GET error:', error)
    return NextResponse.json({ error: 'Szerverhiba' }, { status: 500 })
  }
}
