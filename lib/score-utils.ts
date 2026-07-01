// ============================================================
// WILLVIRAL — Közös score értékelő segédfüggvények
// Minden oldalon importálható: import { scoreColor, scoreLabel, scoreLabelColor } from '@/lib/score-utils'
// ============================================================

export function scoreColor(s: number): string {
  if (s >= 70) return '#22C55E'
  if (s >= 45) return '#F59E0B'
  return '#EF4444'
}

export function scoreLabel(s: number): string {
  if (s >= 85) return 'Kiváló'
  if (s >= 70) return 'Jó'
  if (s >= 55) return 'Közepes'
  if (s >= 40) return 'Gyenge'
  return 'Kritikus'
}

export function scoreLabelColor(s: number): string {
  if (s >= 85) return '#22C55E'
  if (s >= 70) return '#4ADE80'
  if (s >= 55) return '#F59E0B'
  if (s >= 40) return '#FB923C'
  return '#EF4444'
}

// ScoreBar — újrahasználható React komponens
// Használat: <ScoreBar label="Hook erősség" value={75} />
export function ScoreBarData(value: number) {
  return {
    color: scoreColor(value),
    label: scoreLabel(value),
    labelColor: scoreLabelColor(value),
  }
}

// ─── Region label ─────────────────────────────────────────────
export function regionLabel(region: string): string {
  if (region === 'HU') return '🇭🇺 Magyar'
  if (region === 'US') return '🌍 Globális'
  if (region === 'BOTH') return '🌐 Magyar + Globális'
  return region
}

// ─── Platform label ───────────────────────────────────────────
export function platformLabel(platform: string): string {
  const map: Record<string, string> = {
    youtube: 'YouTube',
    youtube_shorts: 'YouTube Shorts',
    youtube_long: 'YouTube Long',
    tiktok: 'TikTok',
    instagram: 'Instagram',
    facebook: 'Facebook',
  }
  return map[platform] || platform
}
