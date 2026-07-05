'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Sparkline from '@/components/dashboard/Sparkline'
import CreditConfirmModal from '@/components/CreditConfirmModal'
import type { UsageCheckResult } from '@/lib/usage-protection'

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
  youtube_video_count: number
  web_source_count: number
  evidence_total: number
  snapshot_count: number
  total_views: number | null
  views_delta: number | null
  trend_velocity: number | null
  trend_status: 'rising' | 'stable' | 'declining' | null
  engagement_rate: number | null
  engagement_delta: number | null
  view_history: number[]
}

interface TrackedVideo {
  video_id: string
  title: string
  channel_title: string | null
  url: string
  thumbnail_url: string
  view_count: number | null
  like_count: number | null
  last_checked_at: string | null
}

interface TrackedWebSource {
  title: string
  url: string
  snippet?: string
  source?: string
  date?: string
}

interface TrackedEvidence {
  videos: TrackedVideo[]
  web_sources: TrackedWebSource[]
}

const PANEL_STYLE: React.CSSProperties = {
  background: 'rgba(255,255,255,0.045)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: '16px',
  boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
  backdropFilter: 'blur(12px)',
}

const EVIDENCE_SOURCE_LABELS: Record<string, string> = {
  serper_youtube: 'Erős trendjel',
  serper_only: 'Korai webes jel',
  youtube_multi_creator: 'YouTube validált',
  weak_signal: 'Gyenge jel',
}

function evidenceSourceLabel(sourceType: string): string {
  return EVIDENCE_SOURCE_LABELS[sourceType] || sourceType
}

function isOverdue(t: TrackedTrend): boolean {
  return t.status === 'active' && new Date(t.next_check_at).getTime() <= Date.now()
}

function statusBadge(t: TrackedTrend): { label: string; color: string; bg: string } {
  if (isOverdue(t)) return { label: 'Frissítés esedékes', color: '#F59E0B', bg: 'rgba(245,158,11,0.12)' }
  if (t.snapshot_count < 2 || !t.trend_status) return { label: 'Kevés adat', color: '#94A3B8', bg: 'rgba(148,163,184,0.12)' }
  if (t.trend_status === 'rising') return { label: 'Erősödik', color: '#4ADE80', bg: 'rgba(34,197,94,0.12)' }
  if (t.trend_status === 'declining') return { label: 'Lassul', color: '#F87171', bg: 'rgba(239,68,68,0.12)' }
  return { label: 'Stabil', color: '#FBBF24', bg: 'rgba(245,158,11,0.12)' }
}

function insightText(t: TrackedTrend): string {
  if (isOverdue(t)) return 'A következő mérés már esedékes. A mély frissítés új webes és videós jeleket keres, az automatikus frissítés pedig a meglévő videók statisztikáit méri újra.'
  if (t.snapshot_count < 2 || !t.trend_status) return 'Még kevés történelmi adat áll rendelkezésre. A rendszer az első mért trendjeleket mutatja.'
  if (t.trend_status === 'rising') return 'Ez a téma az utolsó frissítés óta erősödik.'
  if (t.trend_status === 'declining') return 'Ez a téma az utolsó frissítés óta lassul.'
  return 'Ez a téma stabilan tartja a pozícióját.'
}

function formatDate(iso: string | null): string {
  if (!iso) return '-'
  const d = new Date(iso)
  const today = new Date()
  const isToday = d.toDateString() === today.toDateString()
  const time = d.toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' })
  if (isToday) return `ma ${time}`
  return `${d.toLocaleDateString('hu-HU', { month: 'short', day: 'numeric' })} ${time}`
}

function formatNumber(n: number | null): string {
  if (n == null) return '-'
  return new Intl.NumberFormat('hu-HU').format(n)
}

export default function TrackedTrendsPanel() {
  const [tracked, setTracked] = useState<TrackedTrend[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [openEvidenceFor, setOpenEvidenceFor] = useState<string | null>(null)
  const [evidenceByCandidate, setEvidenceByCandidate] = useState<Record<string, TrackedEvidence>>({})
  const [evidenceLoading, setEvidenceLoading] = useState<string | null>(null)
  const [deepRefreshing, setDeepRefreshing] = useState<string | null>(null)
  const [creditCheck, setCreditCheck] = useState<UsageCheckResult | null>(null)
  const [pendingDeepRefreshId, setPendingDeepRefreshId] = useState<string | null>(null)
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)

  async function loadTracked() {
    const res = await fetch('/api/dashboard/tracked-trends')
    const data = await res.json()
    setTracked(data.tracked || [])
  }

  async function loadEvidence(candidateId: string, force = false) {
    if (!force && evidenceByCandidate[candidateId]) return
    setEvidenceLoading(candidateId)
    try {
      const res = await fetch(`/api/dashboard/tracked-trends/videos?id=${candidateId}`)
      const data = await res.json()
      setEvidenceByCandidate(prev => ({
        ...prev,
        [candidateId]: { videos: data.videos || [], web_sources: data.web_sources || [] },
      }))
    } catch {
      setEvidenceByCandidate(prev => ({ ...prev, [candidateId]: { videos: [], web_sources: [] } }))
    } finally {
      setEvidenceLoading(null)
    }
  }

  async function toggleEvidence(candidateId: string) {
    if (openEvidenceFor === candidateId) {
      setOpenEvidenceFor(null)
      return
    }
    setOpenEvidenceFor(candidateId)
    await loadEvidence(candidateId)
  }

  async function requestDeepRefresh(candidateId: string) {
    setRefreshMessage(null)
    setRefreshError(null)
    try {
      const res = await fetch('/api/credits')
      const credits = await res.json()
      const balance = Number(credits.balance ?? 0)
      const cost = 1

      setPendingDeepRefreshId(candidateId)
      setCreditCheck({
        feature: 'Trend mély frissítés',
        cost,
        currency: 'credit',
        currentCredits: Math.round(balance),
        remainingCreditsAfterRun: Math.round(Math.max(0, balance - cost)),
        requiresConfirmation: true,
        canRun: balance >= cost,
        reason: balance >= cost ? undefined : 'insufficient_credits',
        message: balance >= cost
          ? 'A rendszer új YouTube-jeleket és webes forrásokat keres ehhez a követett trendtémához.'
          : `Nincs elég kredited. ${cost} kredit szükséges, neked ${Math.round(balance)} van.`,
      })
    } catch {
      setRefreshError('Nem sikerült lekérni a kreditegyenleget.')
    }
  }

  async function runDeepRefresh(candidateId: string) {
    setRefreshMessage(null)
    setRefreshError(null)
    setCreditCheck(null)
    setPendingDeepRefreshId(null)
    setDeepRefreshing(candidateId)
    try {
      const res = await fetch('/api/dashboard/tracked-trends/deep-refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: candidateId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'A mély frissítés nem sikerült.')
      setRefreshMessage(`Frissítve: ${data.added_videos || 0} új videójel, ${data.added_web_sources || 0} új webes forrás.`)
      await loadTracked()
      if (openEvidenceFor === candidateId) await loadEvidence(candidateId, true)
    } catch (e) {
      setRefreshError(e instanceof Error ? e.message : 'A mély frissítés nem sikerült.')
    } finally {
      setDeepRefreshing(null)
    }
  }

  useEffect(() => {
    loadTracked()
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
    <>
      {creditCheck && (
        <CreditConfirmModal
          check={creditCheck}
          loading={pendingDeepRefreshId != null && deepRefreshing === pendingDeepRefreshId}
          onCancel={() => { setCreditCheck(null); setPendingDeepRefreshId(null) }}
          onConfirm={() => { if (pendingDeepRefreshId) runDeepRefresh(pendingDeepRefreshId) }}
        />
      )}
      <div className="mt-4 p-5" style={PANEL_STYLE}>
      <h3 className="text-sm font-semibold mb-1 flex items-center gap-2" style={{ color: '#F8FAFC' }}>
        <i className="ti ti-radar-2" style={{ color: '#8B5CF6' }} />
        Követett trendtémák
      </h3>
      <p className="text-xs mb-3" style={{ color: '#64748B' }}>
        Mentett, videócsomaggá vált vagy erős jelű témák. A rendszer ezeknél időben méri a változást és bizonyítékokat gyűjt.
      </p>
      {(refreshMessage || refreshError) && (
        <div className="mb-3 rounded-lg px-3 py-2 text-xs" style={{
          color: refreshError ? '#FCA5A5' : '#86EFAC',
          background: refreshError ? 'rgba(239,68,68,0.1)' : 'rgba(34,197,94,0.1)',
          border: refreshError ? '1px solid rgba(239,68,68,0.18)' : '1px solid rgba(34,197,94,0.18)',
        }}>
          {refreshError || refreshMessage}
        </div>
      )}

      <div className="space-y-2 overflow-y-auto pr-1" style={{ maxHeight: '820px' }}>
        {tracked.map(t => {
          const badge = statusBadge(t)
          const overdue = isOverdue(t)
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
              <p className="text-xs mb-2" style={{ color: '#94A3B8' }}>{insightText(t)}</p>
              <div className="flex items-center gap-2 flex-wrap mb-3 text-xs">
                <span className="px-2 py-1 rounded-full" style={{ background: 'rgba(59,130,246,0.08)', color: '#93C5FD', border: '1px solid rgba(59,130,246,0.16)' }}>
                  Bizonyíték: {t.web_source_count || 0} web + {t.youtube_video_count || 0} videójel
                </span>
                <span className="px-2 py-1 rounded-full" style={{ background: 'rgba(255,255,255,0.04)', color: '#94A3B8', border: '1px solid rgba(255,255,255,0.06)' }}>
                  {t.snapshot_count} mérés
                </span>
                {overdue && (
                  <span className="px-2 py-1 rounded-full" style={{ background: 'rgba(245,158,11,0.1)', color: '#FBBF24', border: '1px solid rgba(245,158,11,0.2)' }}>
                    Frissítés esedékes
                  </span>
                )}
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                <div>
                  <span style={{ color: '#64748B' }}>Views változás</span>
                  <div className="font-semibold" style={{ color: (t.views_delta ?? 0) >= 0 ? '#4ADE80' : '#F87171' }}>
                    {t.views_delta != null ? `${t.views_delta >= 0 ? '+' : ''}${formatNumber(t.views_delta)}` : '-'}
                  </div>
                </div>
                <div>
                  <span style={{ color: '#64748B' }}>Engagement változás</span>
                  <div className="font-semibold" style={{ color: (t.engagement_delta ?? 0) >= 0 ? '#4ADE80' : '#F87171' }}>
                    {t.engagement_delta != null ? `${t.engagement_delta >= 0 ? '+' : ''}${t.engagement_delta}%` : '-'}
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
                    <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(255,255,255,0.05)', color: '#94A3B8' }}>{evidenceSourceLabel(t.trend_source_type)}</span>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <button onClick={() => requestDeepRefresh(t.id)} disabled={deepRefreshing === t.id}
                    className="text-xs px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60"
                    style={{ background: 'rgba(139,92,246,0.14)', color: '#DDD6FE' }}>
                    {deepRefreshing === t.id ? 'Frissítés...' : overdue ? 'Esedékes frissítés (1 kredit)' : 'Mély frissítés (1 kredit)'}
                  </button>
                  <button onClick={() => toggleEvidence(t.id)}
                    className="text-xs px-3 py-1.5 rounded-lg transition-colors"
                    style={{ background: 'rgba(255,255,255,0.05)', color: '#CBD5E1' }}>
                    {openEvidenceFor === t.id ? 'Bizonyítékok elrejtése' : 'Bizonyítékok megnyitása'}
                  </button>
                  <Link href={`/dashboard/video-package?topic=${encodeURIComponent(t.candidate_topic)}`}
                    className="text-xs px-3 py-1.5 rounded-lg font-semibold"
                    style={{ background: 'linear-gradient(135deg, #3B82F6, #8B5CF6)', color: '#fff' }}>
                    Videócsomag
                  </Link>
                </div>
              </div>

              {openEvidenceFor === t.id && (
                <div className="mt-3 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  {evidenceLoading === t.id ? (
                    <p className="text-xs" style={{ color: '#64748B' }}>Betöltés...</p>
                  ) : (() => {
                    const evidence = evidenceByCandidate[t.id] || { videos: [], web_sources: [] }
                    const hasWeb = evidence.web_sources.length > 0
                    const hasVideos = evidence.videos.length > 0
                    if (!hasWeb && !hasVideos) {
                      return (
                        <p className="text-xs" style={{ color: '#64748B' }}>
                          Ehhez a témához még nincs mentett webes vagy videós bizonyíték. A mély frissítés új bizonyítékokat keres hozzá.
                        </p>
                      )
                    }
                    return (
                      <div className="space-y-3">
                        {hasWeb && (
                          <div>
                            <p className="text-[11px] font-semibold uppercase tracking-widest mb-1.5" style={{ color: '#64748B' }}>
                              Webes források ({evidence.web_sources.length})
                            </p>
                            <div className="space-y-1.5">
                              {evidence.web_sources.map((s, i) => (
                                <a key={s.url + i} href={s.url} target="_blank" rel="noopener noreferrer"
                                  className="block py-2 px-2 rounded-lg transition-colors hover:bg-white/[0.03]"
                                  style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.045)' }}>
                                  <div className="flex items-start gap-2">
                                    <i className="ti ti-world mt-0.5 flex-shrink-0" style={{ color: '#3B82F6' }} />
                                    <div className="min-w-0 flex-1">
                                      <p className="text-xs font-medium line-clamp-1" style={{ color: '#CBD5E1' }}>{s.title}</p>
                                      {s.snippet && <p className="text-xs line-clamp-2 mt-0.5" style={{ color: '#64748B' }}>{s.snippet}</p>}
                                      <p className="text-[11px] mt-0.5" style={{ color: '#475569' }}>{[s.source, s.date].filter(Boolean).join(' · ')}</p>
                                    </div>
                                  </div>
                                </a>
                              ))}
                            </div>
                          </div>
                        )}
                        {hasVideos && (
                          <div>
                            <p className="text-[11px] font-semibold uppercase tracking-widest mb-1.5" style={{ color: '#64748B' }}>
                              Videójelek ({evidence.videos.length})
                            </p>
                            <div className="space-y-1.5">
                              {evidence.videos.map(v => (
                                <a key={v.video_id} href={v.url} target="_blank" rel="noopener noreferrer"
                                  className="flex items-center gap-2.5 py-1.5 px-1 rounded-lg transition-colors hover:bg-white/[0.03]">
                                  <div className="w-16 h-9 rounded-md overflow-hidden flex-shrink-0" style={{ background: '#121826' }}>
                                    <img src={v.thumbnail_url} alt="" className="w-full h-full object-cover"
                                      onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
                                  </div>
                                  <span className="text-xs flex-1 min-w-0 truncate" style={{ color: '#CBD5E1' }}>{v.title}</span>
                                  <span className="text-xs flex-shrink-0" style={{ color: '#64748B' }}>{formatNumber(v.view_count)} megtekintés</span>
                                </a>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })()}
                </div>
              )}
            </div>
          )
        })}
      </div>
      </div>
    </>
  )
}