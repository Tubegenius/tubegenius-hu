export interface PerformancePoint { checked_at: string; view_count: number; subscriber_count?: number | null; channel_total_views?: number | null }

export function calculateViewsPerHour(points: PerformancePoint[]): number | null {
  const valid = points.filter(p => Number.isFinite(p.view_count) && Number.isFinite(new Date(p.checked_at).getTime())).sort((a, b) => new Date(a.checked_at).getTime() - new Date(b.checked_at).getTime())
  if (valid.length < 2) return null
  const first = valid[0]
  const last = valid[valid.length - 1]
  const hours = (new Date(last.checked_at).getTime() - new Date(first.checked_at).getTime()) / 3_600_000
  if (hours <= 0) return null
  const delta = last.view_count - first.view_count
  if (delta < 0) return null
  return Math.round((delta / hours) * 100) / 100
}

export function calculateLatestViewsPerHour(points: PerformancePoint[]): number | null {
  const valid = points.filter(p => Number.isFinite(p.view_count) && Number.isFinite(new Date(p.checked_at).getTime())).sort((a, b) => new Date(a.checked_at).getTime() - new Date(b.checked_at).getTime())
  return calculateViewsPerHour(valid.slice(-2))
}

export function calculateWindowGrowth(points: PerformancePoint[], days: number, now = Date.now()) {
  const valid = points.filter(p => Number.isFinite(new Date(p.checked_at).getTime())).sort((a, b) => new Date(a.checked_at).getTime() - new Date(b.checked_at).getTime())
  const inWindow = valid.filter(p => {
    const checkedAt = new Date(p.checked_at).getTime()
    return checkedAt >= now - days * 86_400_000 && checkedAt <= now
  })
  if (inWindow.length < 2) return { subscriber_delta: null, view_delta: null, measured_days: null }
  const first = inWindow[0], last = inWindow[inWindow.length - 1]
  const measuredDays = Math.round(((new Date(last.checked_at).getTime() - new Date(first.checked_at).getTime()) / 86_400_000) * 10) / 10
  return {
    subscriber_delta: Number.isFinite(first.subscriber_count) && Number.isFinite(last.subscriber_count) ? Number(last.subscriber_count) - Number(first.subscriber_count) : null,
    view_delta: Number.isFinite(first.channel_total_views) && Number.isFinite(last.channel_total_views) ? Number(last.channel_total_views) - Number(first.channel_total_views) : null,
    measured_days: measuredDays,
  }
}

export function calculateViewSampleOutliers(viewCounts: number[], threshold = 2) {
  const valid = viewCounts.map(Number).filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b)
  if (valid.length < 3) return { baseline_median_views: null, ratios: viewCounts.map(() => 0), outliers: viewCounts.map(() => false) }
  const middle = Math.floor(valid.length / 2)
  const median = valid.length % 2 ? valid[middle] : (valid[middle - 1] + valid[middle]) / 2
  if (median <= 0) return { baseline_median_views: median, ratios: viewCounts.map(() => 0), outliers: viewCounts.map(() => false) }
  const ratios = viewCounts.map(value => Number.isFinite(value) && value >= 0 ? Math.round((value / median) * 100) / 100 : 0)
  return { baseline_median_views: median, ratios, outliers: ratios.map(ratio => ratio >= threshold) }
}
