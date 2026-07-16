export interface PerformancePoint { checked_at: string; view_count: number; subscriber_count?: number | null; channel_total_views?: number | null }

export function calculateViewsPerHour(points: PerformancePoint[]): number | null {
  const valid = points.filter(p => Number.isFinite(p.view_count) && Number.isFinite(new Date(p.checked_at).getTime())).sort((a, b) => new Date(a.checked_at).getTime() - new Date(b.checked_at).getTime())
  if (valid.length < 2) return null
  const first = valid[0]
  const last = valid[valid.length - 1]
  const hours = (new Date(last.checked_at).getTime() - new Date(first.checked_at).getTime()) / 3_600_000
  if (hours <= 0) return null
  return Math.max(0, Math.round(((last.view_count - first.view_count) / hours) * 100) / 100)
}

export function calculateLatestViewsPerHour(points: PerformancePoint[]): number | null {
  const valid = points.filter(p => Number.isFinite(p.view_count) && Number.isFinite(new Date(p.checked_at).getTime())).sort((a, b) => new Date(a.checked_at).getTime() - new Date(b.checked_at).getTime())
  return calculateViewsPerHour(valid.slice(-2))
}

export function calculateWindowGrowth(points: PerformancePoint[], days: number, now = Date.now()) {
  const valid = points.filter(p => Number.isFinite(new Date(p.checked_at).getTime())).sort((a, b) => new Date(a.checked_at).getTime() - new Date(b.checked_at).getTime())
  const inWindow = valid.filter(p => new Date(p.checked_at).getTime() >= now - days * 86_400_000)
  if (inWindow.length < 2) return { subscriber_delta: null, view_delta: null }
  const first = inWindow[0], last = inWindow[inWindow.length - 1]
  return {
    subscriber_delta: first.subscriber_count != null && last.subscriber_count != null ? Math.max(0, last.subscriber_count - first.subscriber_count) : null,
    view_delta: first.channel_total_views != null && last.channel_total_views != null ? Math.max(0, last.channel_total_views - first.channel_total_views) : null,
  }
}
