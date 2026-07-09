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
  snapshot_count: number
  last_checked_at: string | null
}

export type AlertType = 'rising' | 'declining'

export interface TrendAlert {
  candidate_id: string
  candidate_topic: string
  alert_type: AlertType
  alert_signature: string
  views_delta: number
  total_views: number | null
  message: string
}

// Csak akkor riasztunk, ha van min. 2 snapshot (van mihez viszonyitani) ES a
// valtozas erdemi (nem zajszintu).
const MIN_VIEWS_DELTA_FOR_ALERT = 500

export function buildAlertSignature(candidateId: string, alertType: AlertType, lastCheckedAt: string | null): string {
  const dayBucket = (lastCheckedAt || '').slice(0, 10)
  return crypto.createHash('sha256').update(`${candidateId}:${alertType}:${dayBucket}`).digest('hex').slice(0, 16)
}

export function classifyAlerts(tracked: TrackedTrendForAlert[]): TrendAlert[] {
  const alerts: TrendAlert[] = []

  for (const t of tracked) {
    if (t.snapshot_count < 2 || t.views_delta == null) continue
    if (Math.abs(t.views_delta) < MIN_VIEWS_DELTA_FOR_ALERT) continue

    if (t.trend_status === 'rising') {
      alerts.push({
        candidate_id: t.id,
        candidate_topic: t.candidate_topic,
        alert_type: 'rising',
        alert_signature: buildAlertSignature(t.id, 'rising', t.last_checked_at),
        views_delta: t.views_delta,
        total_views: t.total_views,
        message: `Erősödik: +${t.views_delta.toLocaleString('hu-HU')} megtekintés a legutóbbi ellenőrzés óta.`,
      })
    } else if (t.trend_status === 'declining') {
      alerts.push({
        candidate_id: t.id,
        candidate_topic: t.candidate_topic,
        alert_type: 'declining',
        alert_signature: buildAlertSignature(t.id, 'declining', t.last_checked_at),
        views_delta: t.views_delta,
        total_views: t.total_views,
        message: `Gyengül: ${t.views_delta.toLocaleString('hu-HU')} megtekintés a legutóbbi ellenőrzés óta.`,
      })
    }
  }

  return alerts
}
