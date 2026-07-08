import crypto from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { getUserId, hasEnoughCredits, chargeFeature, CREDIT_COSTS } from '@/lib/credits'
import {
  buildPaidResultHash,
  getPaidResultByHash,
  getPaidResultById,
  normalizePaidResultInput,
  openPaidResult,
  paidResultResponseMeta,
  savePaidResult,
} from '@/lib/paid-results/paid-results-service'

export const runtime = 'nodejs'
export const maxDuration = 60

const MAX_FILE_SIZE = 25 * 1024 * 1024
const TRANSCRIPTION_MODEL = process.env.OPENAI_TRANSCRIPTION_MODEL || 'whisper-1'

type TranscriptSegment = {
  start: number
  end: number
  text: string
}

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

function secondsToTimestamp(seconds: number, separator: ',' | '.') {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const secs = Math.floor(safe % 60)
  const millis = Math.round((safe - Math.floor(safe)) * 1000)
  return [
    String(hours).padStart(2, '0'),
    String(minutes).padStart(2, '0'),
    String(secs).padStart(2, '0'),
  ].join(':') + separator + String(millis).padStart(3, '0')
}

function buildSrt(segments: TranscriptSegment[]) {
  return segments.map((segment, index) => [
    String(index + 1),
    `${secondsToTimestamp(segment.start, ',')} --> ${secondsToTimestamp(segment.end, ',')}`,
    segment.text.trim(),
  ].join('\n')).join('\n\n')
}

function buildVtt(segments: TranscriptSegment[]) {
  return 'WEBVTT\n\n' + segments.map(segment => [
    `${secondsToTimestamp(segment.start, '.')} --> ${secondsToTimestamp(segment.end, '.')}`,
    segment.text.trim(),
  ].join('\n')).join('\n\n')
}

function normalizeSegments(data: OpenAITranscriptionResponse): TranscriptSegment[] {
  const segments = (data.segments || [])
    .map(segment => ({
      start: Number(segment.start ?? 0),
      end: Number(segment.end ?? segment.start ?? 0),
      text: String(segment.text || '').trim(),
    }))
    .filter(segment => segment.text)

  if (segments.length > 0) return segments

  const text = String(data.text || '').trim()
  if (!text) return []
  return [{ start: 0, end: Number(data.duration || 0), text }]
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

    if (!(fileEntry instanceof File)) {
      return NextResponse.json({ error: 'Tölts fel egy hang- vagy videófájlt.' }, { status: 400 })
    }
    if (fileEntry.size <= 0) {
      return NextResponse.json({ error: 'A feltöltött fájl üres.' }, { status: 400 })
    }
    if (fileEntry.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: 'A fájl túl nagy. Az első verzió legfeljebb 25 MB-os hanganyagot fogad.' }, { status: 413 })
    }

    const fileBuffer = Buffer.from(await fileEntry.arrayBuffer())
    const fileDigest = crypto.createHash('sha256').update(fileBuffer).digest('hex')
    const safeFileName = sanitizeFileName(fileEntry.name || 'feltoltott-hang')
    const originalInput = title || safeFileName
    const normalizedInput = normalizePaidResultInput({
      fileDigest,
      fileName: safeFileName,
      fileSize: fileEntry.size,
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

    const paid = await getPaidResultByHash({ userId, toolType: 'transcript_extract', inputHash })
    if (paid) {
      const opened = await openPaidResult(paid)
      return NextResponse.json({
        ...(opened.result_json as object),
        ...paidResultResponseMeta(opened),
      })
    }

    const enoughCredits = await hasEnoughCredits(userId, 'transcript_extract')
    if (!enoughCredits) {
      return NextResponse.json({ error: `Nincs elég kredited. Ehhez ${CREDIT_COSTS.transcript_extract} kredit szükséges.` }, { status: 402 })
    }

    const openAiForm = new FormData()
    openAiForm.append('file', new Blob([fileBuffer], { type: fileEntry.type || 'application/octet-stream' }), safeFileName)
    openAiForm.append('model', TRANSCRIPTION_MODEL)
    openAiForm.append('response_format', 'verbose_json')
    if (language && language !== 'auto') openAiForm.append('language', language)

    const transcriptionRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: openAiForm,
    })

    if (!transcriptionRes.ok) {
      const details = await transcriptionRes.text().catch(() => '')
      console.error('[Transcript] OpenAI transcription failed:', details.slice(0, 1000))
      return NextResponse.json({ error: 'A leiratkészítés nem sikerült. Próbáld rövidebb vagy tisztább hanganyaggal.' }, { status: 502 })
    }

    const transcription = await transcriptionRes.json() as OpenAITranscriptionResponse
    const text = String(transcription.text || '').trim()
    const segments = normalizeSegments(transcription)
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
    })
    if (!paidSave.success) {
      console.error('[Transcript] KRITIKUS: paid_results mentés sikertelen, a user már fizetett érte:', paidSave.error)
    }

    return NextResponse.json({ ...responsePayload, paid_result_id: paidSave.record?.id || null })
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
