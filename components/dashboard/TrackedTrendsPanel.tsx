'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Sparkline from '@/components/dashboard/Sparkline'

interface TrackedTrend {
  id: string
  candidate_topic: string
  niche: string | null
  region: string | null
  confidence: string | null
  trend_source_type: string | null
  opportunity_score: number | null
  created_at: string
  last_checked_at: string | null
  next_check_at: string
  refresh_priority: string
  status: 'active' | 'stopped'
  snapshot_count: number
  total_views: number | null
  views_delta: number | null
  trend_velocity: number | null
  trend_status: 'rising' | 'stable' | 'declining' | null
  engagement_rate: number | null
  engagement_delta: number | null
  view_history: number[]
}

const PANEL_STYLE: React.CSSProperties = {
  background: 'rgba(255,255,255,0.045)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: '16px',
  boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
  backdropFilter: 'blur(12px)',
}

function statusBadge(t: TrackedTrend): { label: string; color: string; bg: string } {
  const overdue = t.status === 'active' && new Date(t.next_check_at).getTime() <= Date.now()
  if (t.snapshot_count < 2 || !t.trend_status) {
    return { label: 'Kevés adat', color: '#94A3B8', bg: 'rgba(148,163,184,0.12)' }
  }
  if (overdue) return { label: 'Frissítésre vár', color: '#94A3B8', bg: 'rgba(148,163,184,0.12)' }
  if (t.trend_status === 'rising') return { label: 'Erősödik', color: '#4ADE80', bg: 'rgba(34,197,94,0.12)' }
  if (t.trend_status === 'declining') return { label: 'Lassul', color: '#F87171', bg: 'rgba(239,68,68,0.12)' }
  return { label: 'Stabil', color: '#FBBF24', bg: 'rgba(245,158,11,0.12)' }
}

function insightText(t: TrackedTrend): string {
  if (t.snapshot_count < 2 || !t.trend_status) {
    return 'Még kevés történelmi adat áll rendelkezésre. A rendszer az első mért trendjeleket mutatja.'
  }
  if (t.trend_status === 'rising') return 'Ez a téma az utolsó frissítés óta erősödik.'
  if (t.trend_status === 'declining') return 'Ez a téma az utolsó frissítés óta lassul.'
  return 'Ez a téma stabilan tartja a pozícióját.'
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  const today = new Date()
  const isToday = d.toDateString() === today.toDateString()
  const time = d.toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' })
  if (isToday) return `ma ${time}`
  return `${d.toLocaleDateString('hu-HU', { month: 'short', day: 'numeric' })} ${time}`
}

function formatNumber(n: number | null): string {
  if (n == null) return '—'
  return new Intl.NumberFormat('hu-HU').format(n)
}

interface TrackedVideo {
  video_id: string
  title: string
  channel_title: string | null
  url: string
  view_count: number | null
  like_count: number | null
  last_checked_at: string | null
}

export default function TrackedTrendsPanel() {
  const [tracked, setTracked] = useState<TrackedTrend[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [openVideosFor, setOpenVideosFor] = useState<string | null>(null)
  const [videosByCandidate, setVideosByCandidate] = useState<Record<string, TrackedVideo[]>>({})
  const [videosLoading, setVideosLoading] = useState<string | null>(null)

  // Ingyenes — a már ismert (passzívan gyűjtött) youtube_video_ids adatot
  // olvassa ki, NEM indít új Similar Videos keresést, NEM von le kreditet.
  async function toggleVideos(candidateId: string) {
    if (openVideosFor === candidateId) {
      setOpenVideosFor(null)
      return
    }
    setOpenVideosFor(candidateId)
    if (!videosByCandidate[candidateId]) {
      setVideosLoading(candidateId)
      try {
        const res = await fetch(`/api/dashboard/tracked-trends/videos?id=${candidateId}`)
        const data = await res.json()
        setVideosByCandidate(prev => ({ ...prev, [candidateId]: data.videos || [] }))
      } catch {
        setVideosByCandidate(prev => ({ ...prev, [candidateId]: [] }))
      } finally {
        setVideosLoading(null)
      }
    }
  }

  useEffect(() => {
    fetch('/api/dashboard/tracked-trends')
      .then(r => r.json())
      .then(d => setTracked(d.tracked || []))
      .catch(() => setTracked([]))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return <div className="rounded-2xl h-40 mt-4 animate-pulse" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }} />
  }
  if (!tracked) return null

  if (tracked.length === 0) {
    return (
      <div className="mt-4 p-8 text-center" style={PANEL_STYLE}>
        <div className="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3" style={{ background: 'rgba(139,92,246,0.12)' }}>
          <i className="ti ti-radar-2 text-xl" style={{ color: '#8B5CF6' }} />
        </div>
        <p className="text-sm font-medium" style={{ color: '#F8FAFC' }}>Még nincs követett trendtéma.</p>
        <p className="text-xs mt-1" style={{ color: '#64748B' }}>
          Ments el egy trendet vagy generálj videócsomagot egy Opportunity Engine találatból.
        </p>
      </div>
    )
  }

  return (
    <div className="mt-4 p-5" style={PANEL_STYLE}>
      <h3 className="text-sm font-semibold mb-1 flex items-center gap-2" style={{ color: '#F8FAFC' }}>
        <i className="ti ti-radar-2" style={{ color: '#8B5CF6' }} />
        Követett trendtémák
      </h3>
      <p className="text-xs mb-4" style={{ color: '#64748B' }}>
        Limitáltan trackelt témák — mentett, videócsomaggá vált, vagy magas confidence/score/friss trend találatok.
      </p>

      <div className="space-y-2">
        {tracked.map(t => {
          const badge = statusBadge(t)
          return (
            <div key={t.id} className="rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}>
              <div className="flex items-start justify-between gap-3 mb-2">
                <p className="text-sm font-medium min-w-0 truncate" style={{ color: '#F8FAFC' }}>{t.candidate_topic}</p>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <Sparkline values={t.view_history} color={t.trend_status === 'declining' ? '#F87171' : t.trend_status === 'rising' ? '#4ADE80' : '#FBBF24'} />
                  <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ color: badge.color, background: badge.bg }}>
                    {badge.label}
                  </span>
                </div>
              </div>
              <p className="text-xs mb-3" style={{ color: '#94A3B8' }}>{insightText(t)}</p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                <div>
                  <span style={{ color: '#64748B' }}>Views változás</span>
                  <div className="font-semibold" style={{ color: (t.views_delta ?? 0) >= 0 ? '#4ADE80' : '#F87171' }}>
                    {t.views_delta != null ? `${t.views_delta >= 0 ? '+' : ''}${formatNumber(t.views_delta)}` : '—'}
                  </div>
                </div>
                <div>
                  <span style={{ color: '#64748B' }}>Engagement változás</span>
                  <div className="font-semibold" style={{ color: (t.engagement_delta ?? 0) >= 0 ? '#4ADE80' : '#F87171' }}>
                    {t.engagement_delta != null ? `${t.engagement_delta >= 0 ? '+' : ''}${t.engagement_delta}%` : '—'}
                  </div>
                </div>
                <div>
                  <span style={{ color: '#64748B' }}>Utolsó ellenőrzés</span>
                  <div className="font-semibold" style={{ color: '#CBD5E1' }}>{formatDate(t.last_checked_at)}</div>
                </div>
                <div>
                  <span style={{ color: '#64748B' }}>Következő ellenőrzés</span>
                  <div className="font-semibold" style={{ color: '#CBD5E1' }}>{formatDate(t.next_check_at)}</div>
                </div>
              </div>
              <div className="flex items-center justify-between gap-3 mt-3 flex-wrap">
                <div className="flex items-center gap-2 flex-wrap">
                  {t.confidence && (
                    <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(59,130,246,0.1)', color: '#93C5FD' }}>{t.confidence}</span>
                  )}
                  {t.trend_source_type && (
                    <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(255,255,255,0.05)', color: '#94A3B8' }}>{t.trend_source_type}</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => toggleVideos(t.id)}
                    className="text-xs px-3 py-1.5 rounded-lg transition-colors"
                    style={{ background: 'rgba(255,255,255,0.05)', color: '#CBD5E1' }}>
                    {openVideosFor === t.id ? 'Videók elrejtése' : 'Videók megnyitása'}
                  </button>
                  <Link href={`/dashboard/video-package?topic=${encodeURIComponent(t.candidate_topic)}`}
                    className="text-xs px-3 py-1.5 rounded-lg font-semibold"
                    style={{ background: 'linear-gradient(135deg, #3B82F6, #8B5CF6)', color: '#fff' }}>
                    Videócsomag
                  </Link>
                </div>
              </div>

              {openVideosFor === t.id && (
                <div className="mt-3 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  {videosLoading === t.id ? (
                    <p className="text-xs" style={{ color: '#64748B' }}>Betöltés...</p>
                  ) : (videosByCandidate[t.id] || []).length === 0 ? (
                    <p className="text-xs" style={{ color: '#64748B' }}>
                      Ehhez a témához még nincs mentett videójel. A követés során gyűjtött adat majd itt jelenik meg.
                    </p>
                  ) : (
                    <div className="space-y-1.5">
                      {(videosByCandidate[t.id] || []).map(v => (
                        <a key={v.video_id} href={v.url} target="_blank" rel="noopener noreferrer"
                          className="flex items-center gap-2.5 py-1.5 px-1 rounded-lg transition-colors hover:bg-white/[0.03]">
                          <i className="ti ti-brand-youtube flex-shrink-0" style={{ color: '#EF4444', fontSize: '14px' }} />
                          <span className="text-xs flex-1 min-w-0 truncate" style={{ color: '#CBD5E1' }}>{v.title}</span>
                          <span className="text-xs flex-shrink-0" style={{ color: '#64748B' }}>{formatNumber(v.view_count)} megtekintés</span>
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
