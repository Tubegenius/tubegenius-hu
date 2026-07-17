import crypto from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { fetchExternal } from '@/lib/external-fetch'
import { getUserId, checkPaidFeatureAccess, chargeFeature, CREDIT_COSTS, refundCreditsAfterPersistenceFailure } from '@/lib/credits'
import { dailySoftLimitError } from '@/lib/daily-soft-limit'
import {
  buildPaidResultHash,
  getPaidResultByHash,
  getPaidResultById,
  normalizePaidResultInput,
  openPaidResult,
  paidResultResponseMeta,
  savePaidResult,
} from '@/lib/paid-results/paid-results-service'
import { acquireRequestLock, releaseRequestLock, REQUEST_IN_PROGRESS_ERROR } from '@/lib/request-lock'
import { buildSrt, buildVtt, normalizeTranscriptSegments } from '@/lib/transcript-format'

export const runtime = 'nodejs'
export const maxDuration = 60

const MAX_FILE_SIZE = 25 * 1024 * 1024
const TRANSCRIPTION_MODEL = process.env.OPENAI_TRANSCRIPTION_MODEL || 'whisper-1'

type OpenAITranscriptionResponse = {
  text?: string
  duration?: number
  language?: string
  segments?: Array<{
    start?: number
    end?: number
    text?: string
  }>
}

function asString(value: FormDataEntryValue | null): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^\p{L}\p{N}._ -]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'feltoltott-hang'
}

const ALLOWED_LANGUAGES = new Set(['auto', 'hu', 'en'])
const ALLOWED_EXTENSIONS = new Set(['mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'wav', 'webm', 'mov', 'aac', 'ogg', 'oga', 'flac'])

function isSupportedMediaFile(file: File) {
  const extension = file.name.split('.').pop()?.toLowerCase() || ''
  return file.type.startsWith('audio/') || file.type.startsWith('video/') || ALLOWED_EXTENSIONS.has(extension)
}

export async function POST(request: NextRequest) {
  try {
    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: 'Az Auto Transcript nincs bekötve: hiányzik az OpenAI API kulcs.' }, { status: 500 })
    }

    const formData = await request.formData()
    const fileEntry = formData.get('file')
    const language = asString(formData.get('language')) || 'hu'
    const title = asString(formData.get('title'))

    if (!ALLOWED_LANGUAGES.has(language)) return NextResponse.json({ error: 'Nem támogatott transcript nyelv.' }, { status: 400 })
    if (title && title.length > 200) return NextResponse.json({ error: 'A cím legfeljebb 200 karakter lehet.' }, { status: 400 })

    if (!(fileEntry instanceof File)) {
      return NextResponse.json({ error: 'Tölts fel egy hang- vagy videófájlt.' }, { status: 400 })
    }
    if (fileEntry.size <= 0) {
      return NextResponse.json({ error: 'A feltöltött fájl üres.' }, { status: 400 })
    }
    if (fileEntry.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: 'A fájl túl nagy. Az első verzió legfeljebb 25 MB-os hanganyagot fogad.' }, { status: 413 })
    }
    if (!isSupportedMediaFile(fileEntry)) return NextResponse.json({ error: 'Nem támogatott fájltípus. Tölts fel hang- vagy videófájlt.' }, { status: 415 })

    const fileBuffer = Buffer.from(await fileEntry.arrayBuffer())
    const fileDigest = crypto.createHash('sha256').update(fileBuffer).digest('hex')
    const safeFileName = sanitizeFileName(fileEntry.name || 'feltoltott-hang')
    const originalInput = title || safeFileName
    const normalizedInput = normalizePaidResultInput({
      fileDigest,
      language,
      model: TRANSCRIPTION_MODEL,
    })
    const inputHash = buildPaidResultHash({
      userId,
      toolType: 'transcript_extract',
      normalizedInput,
      language,
      platform: 'upload',
    })

    const lock = await acquireRequestLock({ userId, toolType: 'transcript_extract', inputHash })
    if (!lock.acquired) {
      return NextResponse.json({ error: REQUEST_IN_PROGRESS_ERROR }, { status: 409 })
    }

    try {
    const paid = await getPaidResultByHash({ userId, toolType: 'transcript_extract', inputHash })
    if (paid) {
      const opened = await openPaidResult(paid)
      return NextResponse.json({
        ...(opened.result_json as object),
        ...paidResultResponseMeta(opened),
      })
    }

    const access = await checkPaidFeatureAccess(userId, 'transcript_extract', request.headers.get('x-daily-soft-limit-override') === 'true')
    if (access.reason === 'daily_soft_limit' && access.dailyLimit) return NextResponse.json(dailySoftLimitError(access.dailyLimit), { status: 429 })
    if (!access.allowed) {
      return NextResponse.json({ error: `Nincs elég kredited. Ehhez ${CREDIT_COSTS.transcript_extract} kredit szükséges.` }, { status: 402 })
    }

    const openAiForm = new FormData()
    openAiForm.append('file', new Blob([fileBuffer], { type: fileEntry.type || 'application/octet-stream' }), safeFileName)
    openAiForm.append('model', TRANSCRIPTION_MODEL)
    openAiForm.append('response_format', 'verbose_json')
    if (language && language !== 'auto') openAiForm.append('language', language)

    const transcriptionRes = await fetchExternal('OpenAI transcription', 'https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: openAiForm,
    }, 60_000)

    if (!transcriptionRes.ok) {
      const details = await transcriptionRes.text().catch(() => '')
      console.error('[Transcript] OpenAI transcription failed:', details.slice(0, 1000))
      return NextResponse.json({ error: 'A leiratkészítés nem sikerült. Próbáld rövidebb vagy tisztább hanganyaggal.' }, { status: 502 })
    }

    const transcription = await transcriptionRes.json() as OpenAITranscriptionResponse
    const text = String(transcription.text || '').trim()
    const segments = normalizeTranscriptSegments(transcription.segments, text, transcription.duration)
    if (!text && segments.length === 0) {
      return NextResponse.json({ error: 'Nem sikerült értelmezhető szöveget kinyerni a hangból.' }, { status: 422 })
    }

    const charge = await chargeFeature(userId, 'transcript_extract', {
      file_name: safeFileName,
      file_size: fileEntry.size,
      language,
      model: TRANSCRIPTION_MODEL,
    })
    if (!charge.success) {
      return NextResponse.json({ error: charge.error || 'Nincs elég kredited ehhez a művelethez.' }, { status: 402 })
    }

    const finalText = text || segments.map(segment => segment.text).join(' ')
    const responsePayload = {
      title: originalInput,
      file_name: safeFileName,
      file_size: fileEntry.size,
      language: transcription.language || language,
      model: TRANSCRIPTION_MODEL,
      duration_seconds: transcription.duration ?? (segments.length ? segments[segments.length - 1].end : null),
      text: finalText,
      segments,
      timed_exports_available: segments.length > 0,
      word_count: finalText.split(/\s+/).filter(Boolean).length,
      exports: {
        txt: finalText,
        srt: buildSrt(segments),
        vtt: buildVtt(segments),
      },
      _credits_remaining: charge.new_balance,
    }

    const paidSave = await savePaidResult({
      userId,
      toolType: 'transcript_extract',
      inputHash,
      normalizedInput,
      originalInput,
      language,
      platform: 'upload',
      resultJson: responsePayload,
      summaryJson: {
        title: originalInput,
        file_name: safeFileName,
        duration_seconds: responsePayload.duration_seconds,
        word_count: responsePayload.word_count,
      },
      creditCost: CREDIT_COSTS.transcript_extract,
      freshForHours: 24 * 30,
      provider: 'openai',
      model: TRANSCRIPTION_MODEL,
    })
    if (!paidSave.success) {
      console.error('[Transcript] KRITIKUS: paid_results mentés sikertelen, a user már fizetett érte:', paidSave.error)
      const refund = await refundCreditsAfterPersistenceFailure(userId, 'transcript_extract', CREDIT_COSTS.transcript_extract, { reason: 'paid_result_save_failed' }, charge.credit_transaction_id)
      if (!refund.success) console.error('[Transcript] KRITIKUS: automatikus kredit-visszatérítés sikertelen')
      return NextResponse.json({ error: refund.success ? 'Az eredmény mentése sikertelen volt, a kreditet visszaadtuk.' : 'Az eredmény mentése és a kredit-visszatérítés sikertelen. Az esetet naplóztuk.' }, { status: 500 })
    }

    return NextResponse.json({ ...responsePayload, paid_result_id: paidSave.record?.id || null })
    } finally {
      await releaseRequestLock(lock.lockId)
    }
  } catch (error) {
    console.error('Transcript error:', error)
    return NextResponse.json({ error: 'A transcript készítés sikertelen. Próbáld újra.' }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  try {
    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const paidResultId = request.nextUrl.searchParams.get('paidResultId')
    if (!paidResultId) return NextResponse.json({ error: 'paidResultId kötelező' }, { status: 400 })

    const paid = await getPaidResultById(userId, paidResultId)
    if (!paid || paid.tool_type !== 'transcript_extract') {
      return NextResponse.json({ error: 'A mentett transcript nem található' }, { status: 404 })
    }

    const opened = await openPaidResult(paid)
    return NextResponse.json({
      ...(opened.result_json as object),
      ...paidResultResponseMeta(opened),
    })
  } catch (error) {
    console.error('Transcript GET error:', error)
    return NextResponse.json({ error: 'Szerverhiba' }, { status: 500 })
  }
}
