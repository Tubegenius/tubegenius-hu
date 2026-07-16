import crypto from 'crypto'
import { alertTimeBucket, type AlertFrequency } from '@/lib/trend-alerts'

export interface CompetitorVphCandidate {
  competitor_id: string
  channel_title: string
  video_id: string
  video_title: string
  views_per_hour: number | null
  threshold: number
  alert_frequency: AlertFrequency
  checked_at: string | null
}

export interface CompetitorVphAlert extends CompetitorVphCandidate {
  alert_type: 'competitor_vph'
  alert_signature: string
  message: string
}

export function classifyCompetitorVphAlerts(candidates: CompetitorVphCandidate[]): CompetitorVphAlert[] {
  return candidates.flatMap(candidate => {
    if (candidate.alert_frequency === 'off' || candidate.views_per_hour == null || !Number.isFinite(candidate.views_per_hour) || candidate.views_per_hour < candidate.threshold) return []
    const bucket = alertTimeBucket(candidate.checked_at, candidate.alert_frequency)
    const alertSignature = crypto.createHash('sha256').update(`${candidate.competitor_id}:${candidate.video_id}:competitor_vph:${candidate.alert_frequency}:${bucket}`).digest('hex').slice(0, 16)
    return [{ ...candidate, alert_type: 'competitor_vph' as const, alert_signature: alertSignature, message: `${Math.round(candidate.views_per_hour).toLocaleString('hu-HU')} megtekintés/óra — a beállított ${candidate.threshold.toLocaleString('hu-HU')} VPH küszöb felett.` }]
  })
}
