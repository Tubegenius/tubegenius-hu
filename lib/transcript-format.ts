export type TranscriptSegment = { start: number; end: number; text: string }
export type RawTranscriptSegment = { start?: number; end?: number; text?: string }

export function secondsToTimestamp(seconds: number, separator: ',' | '.') {
  const totalMillis = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 1000))
  const hours = Math.floor(totalMillis / 3_600_000)
  const minutes = Math.floor((totalMillis % 3_600_000) / 60_000)
  const secs = Math.floor((totalMillis % 60_000) / 1000)
  const millis = totalMillis % 1000
  return [String(hours).padStart(2, '0'), String(minutes).padStart(2, '0'), String(secs).padStart(2, '0')].join(':')
    + separator + String(millis).padStart(3, '0')
}

export function normalizeTranscriptSegments(segments: RawTranscriptSegment[] | undefined, fallbackText?: string, fallbackDuration?: number): TranscriptSegment[] {
  const normalized = (segments || []).slice(0, 10_000).map(segment => ({
    start: Number(segment.start),
    end: Number(segment.end),
    text: String(segment.text || '').trim().slice(0, 10_000),
  })).filter(segment => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.start >= 0 && segment.end > segment.start && !!segment.text)
    .sort((a, b) => a.start - b.start || a.end - b.end)
  if (normalized.length) return normalized
  const text = String(fallbackText || '').trim()
  const duration = Number(fallbackDuration)
  return text && Number.isFinite(duration) && duration > 0 ? [{ start: 0, end: duration, text: text.slice(0, 10_000) }] : []
}

export function buildSrt(segments: TranscriptSegment[]) {
  return segments.map((segment, index) => `${index + 1}\n${secondsToTimestamp(segment.start, ',')} --> ${secondsToTimestamp(segment.end, ',')}\n${segment.text}`).join('\n\n')
}

export function buildVtt(segments: TranscriptSegment[]) {
  const cues = segments.map(segment => `${secondsToTimestamp(segment.start, '.')} --> ${secondsToTimestamp(segment.end, '.')}\n${segment.text}`).join('\n\n')
  return cues ? `WEBVTT\n\n${cues}` : ''
}
