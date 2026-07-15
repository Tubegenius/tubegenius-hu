// ============================================================
// WILLVIRAL — Trend Alerts (Phase 2 #9)
// ============================================================
// Nincs uj AI-hivas, nincs kredit — a mar meglevo tracked_trend_candidates +
// trend_candidate_snapshots adatra epulo figyelmezteto reteg. A trend_status
// ('rising'/'stable'/'declining') mar a lib/trend-tracking.ts-ben kiszamolt,
// ezt csak "riasztas-e vagy sem" dontesre hasznaljuk.

import crypto from 'crypto'

export interface TrackedTrendForAlert {
  id: string
  candidate_topic: string
  trend_status: 'rising' | 'stable' | 'declining' | null
  views_delta: number | null
  total_views: number | null
  trend_velocity: number | null
  snapshot_count: number
  last_checked_at: string | null
  alert_frequency?: AlertFrequency
}

export type AlertFrequency = 'daily' | 'weekly' | 'off'

export type AlertType = 'rising' | 'declining'

export interface TrendAlert {
  candidate_id: string
  candidate_topic: string
  alert_type: AlertType
  alert_signature: string
  views_delta: number
  total_views: number | null
  trend_velocity: number | null
  message: string
}

// Csak akkor riasztunk, ha van min. 2 snapshot (van mihez viszonyitani) ES a
// valtozas erdemi (nem zajszintu).
const MIN_VIEWS_DELTA_FOR_ALERT = 500
const VELOCITY_CHANGE_RATIO = 0.25

export function classifyTrendVelocity(currentVph: number | null, previousVph: number | null): 'rising' | 'stable' | 'declining' {
  if (currentVph == null || previousVph == null || !Number.isFinite(currentVph) || !Number.isFinite(previousVph) || currentVph < 0 || previousVph < 0) return 'stable'
  if (previousVph === 0) return currentVph > 0 ? 'rising' : 'stable'
  const change = (currentVph - previousVph) / previousVph
  if (change >= VELOCITY_CHANGE_RATIO) return 'rising'
  if (change <= -VELOCITY_CHANGE_RATIO) return 'declining'
  return 'stable'
}

export function alertTimeBucket(lastCheckedAt: string | null, frequency: AlertFrequency): string {
  const date = new Date(lastCheckedAt || '')
  if (!Number.isFinite(date.getTime())) return 'unknown'
  if (frequency === 'daily') return date.toISOString().slice(0, 10)
  const utcDay = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - utcDay)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7)
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

export function buildAlertSignature(candidateId: string, alertType: AlertType, lastCheckedAt: string | null, frequency: AlertFrequency = 'daily'): string {
  return crypto.createHash('sha256').update(`${candidateId}:${alertType}:${frequency}:${alertTimeBucket(lastCheckedAt, frequency)}`).digest('hex').slice(0, 16)
}

export function classifyAlerts(tracked: TrackedTrendForAlert[]): TrendAlert[] {
  const alerts: TrendAlert[] = []

  for (const t of tracked) {
    const frequency = t.alert_frequency || 'daily'
    if (frequency === 'off') continue
    if (t.snapshot_count < 2 || t.views_delta == null) continue
    if (Math.abs(t.views_delta) < MIN_VIEWS_DELTA_FOR_ALERT) continue

    if (t.trend_status === 'rising') {
      alerts.push({
        candidate_id: t.id,
        candidate_topic: t.candidate_topic,
        alert_type: 'rising',
        alert_signature: buildAlertSignature(t.id, 'rising', t.last_checked_at, frequency),
        views_delta: t.views_delta,
        total_views: t.total_views,
        trend_velocity: t.trend_velocity,
        message: `Erősödik: ${Math.round(t.trend_velocity || 0).toLocaleString('hu-HU')} megtekintés/óra, +${t.views_delta.toLocaleString('hu-HU')} az előző mérés óta.`,
      })
    } else if (t.trend_status === 'declining') {
      alerts.push({
        candidate_id: t.id,
        candidate_topic: t.candidate_topic,
        alert_type: 'declining',
        alert_signature: buildAlertSignature(t.id, 'declining', t.last_checked_at, frequency),
        views_delta: t.views_delta,
        total_views: t.total_views,
        trend_velocity: t.trend_velocity,
        message: `Lassul: ${Math.round(t.trend_velocity || 0).toLocaleString('hu-HU')} megtekintés/óra, +${t.views_delta.toLocaleString('hu-HU')} az előző mérés óta.`,
      })
    }
  }

  return alerts
}
