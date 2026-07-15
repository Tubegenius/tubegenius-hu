'use client'

import { useState, useEffect } from 'react'
import CreditConfirmModal from '@/components/CreditConfirmModal'
import type { UsageCheckResult } from '@/lib/usage-protection'
import LoadingScreen, { LOADING_STEPS } from '@/components/ui/LoadingScreen'

interface CompetitorVideo {
  id?: string
  video_id?: string
  videoId?: string
  title: string
  thumbnail_url?: string
  thumbnailUrl?: string
  view_count?: number
  viewCount?: number
  published_at?: string
  publishedAt?: string
  outlier_ratio?: number
  outlierRatio?: number
  is_outlier?: boolean
  isOutlier?: boolean
  views_per_hour?: number | null
}

interface GrowthWindow { subscriber_delta: number | null; view_delta: number | null }

interface Competitor {
  id: string
  channel_title: string
  channel_thumbnail: string | null
  channel_url: string
  baseline_subscriber_count: number
  baseline_avg_views: number
  last_checked_at: string
  videos: CompetitorVideo[]
  growth_7d: GrowthWindow
  growth_14d: GrowthWindow
  growth_28d: GrowthWindow
}

function formatNumber(n: number): string {
  if (!n) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return n.toString()
}

const ADD_COST = 1
const REFRESH_COST = 1

export default function CompetitorsPage() {
  const [competitors, setCompetitors] = useState<Competitor[]>([])
  const [loading, setLoading] = useState(true)
  const [channelInput, setChannelInput] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [creditCheck, setCreditCheck] = useState<UsageCheckResult | null>(null)
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null)
  const [refreshingId, setRefreshingId] = useState<string | null>(null)
  const [savedVideos, setSavedVideos] = useState<Set<string>>(new Set())

  useEffect(() => { loadCompetitors() }, [])

  async function loadCompetitors() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/competitors')
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'A versenytársak betöltése sikertelen. Próbáld újra később.')
        return
      }
      setCompetitors(data.competitors || [])
    } catch {
      setError('Kapcsolati hiba. Próbáld újra később.')
    } finally {
      setLoading(false)
    }
  }

  async function withCreditConfirm(feature: string, cost: number, action: () => void) {
    setError(null)
    try {
      const res = await fetch('/api/credits')
      const credits = await res.json()
      const balance = Number(credits.balance ?? 0)
      setCreditCheck({
        feature,
        cost,
        currency: 'credit',
        currentCredits: balance,
        remainingCreditsAfterRun: balance - cost,
        requiresConfirmation: true,
        canRun: balance >= cost,
        reason: balance >= cost ? undefined : 'insufficient_credits',
        message: balance >= cost ? 'Valós YouTube-adatokból (feliratkozók, legutóbbi videók, kiugró teljesítmény).' : 'Ehhez a művelethez nincs elég kredited.',
      })
      setPendingAction(() => action)
    } catch {
      setError('Kapcsolati hiba.')
    }
  }

  async function addCompetitor() {
    if (!channelInput.trim()) return
    await withCreditConfirm('Versenytárs hozzáadása', ADD_COST, async () => {
      setAdding(true)
      setError(null)
      try {
        const res = await fetch('/api/competitors', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel_input: channelInput }),
        })
        const data = await res.json()
        if (!res.ok) {
          setError(data.error || 'Hozzáadás sikertelen.')
          return
        }
        setChannelInput('')
        await loadCompetitors()
      } catch {
        setError('Kapcsolati hiba.')
      } finally {
        setAdding(false)
      }
    })
  }

  async function refreshCompetitor(id: string) {
    await withCreditConfirm('Versenytárs frissítése', REFRESH_COST, async () => {
      setRefreshingId(id)
      try {
        const res = await fetch(`/api/competitors/${id}/refresh`, { method: 'POST' })
        const data = await res.json()
        if (!res.ok) {
          setError(data.error || 'Frissítés sikertelen.')
          return
        }
        await loadCompetitors()
      } finally {
        setRefreshingId(null)
      }
    })
  }

  async function removeCompetitor(id: string) {
    setError(null)
    try {
      const res = await fetch('/api/competitors', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'A versenytárs törlése sikertelen. Próbáld újra később.')
        return
      }
      setCompetitors(prev => prev.filter(c => c.id !== id))
    } catch {
      setError('Kapcsolati hiba. Próbáld újra később.')
    }
  }

  async function saveOutlierSignal(video: CompetitorVideo, channelTitle: string) {
    const videoId = video.video_id || video.videoId || ''
    setSavedVideos(prev => new Set(prev).add(videoId))
    await fetch('/api/competitors/save-signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: video.title,
        platform: 'youtube',
        channel_title: channelTitle,
        video: {
          videoId,
          title: video.title,
          viewCount: video.view_count ?? video.viewCount ?? 0,
          publishedAt: video.published_at ?? video.publishedAt,
          outlierRatio: video.outlier_ratio ?? video.outlierRatio ?? 0,
        },
      }),
    })
  }

  return (
    <div className="max-w-3xl mx-auto">
      {creditCheck && (
        <CreditConfirmModal
          check={creditCheck}
          onConfirm={() => { const action = pendingAction; setCreditCheck(null); setPendingAction(null); action?.() }}
          onCancel={() => { setCreditCheck(null); setPendingAction(null) }}
          loading={adding || !!refreshingId}
        />
      )}

      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-1" style={{ color: '#F8FAFC' }}>🎯 Versenytársfigyelő</h1>
        <p className="text-sm" style={{ color: '#CBD5E1' }}>Figyelt csatornák legutóbbi videói, kiugró (outlier) teljesítménnyel jelölve.</p>
      </div>

      <div className="card mb-6">
        <div className="flex gap-2">
          <input
            value={channelInput}
            onChange={e => setChannelInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addCompetitor()}
            placeholder="YouTube csatorna URL, @handle vagy név..."
            className="flex-1 px-4 py-2.5 rounded-lg text-sm"
            style={{ background: '#121826', border: '1px solid rgba(255,255,255,0.08)', color: '#F8FAFC' }}
          />
          <button onClick={addCompetitor} disabled={adding || !channelInput.trim()} className="btn-primary px-5">
            {adding ? 'Hozzáadás...' : 'Figyelés indítása'}
          </button>
        </div>
      </div>

      {error && (
        <div className="card mb-6" style={{ background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.2)' }}>
          <p className="text-sm" style={{ color: '#EF4444' }}>{error}</p>
        </div>
      )}

      {adding && (
        <div className="card mb-6">
          <LoadingScreen steps={LOADING_STEPS.competitors} />
        </div>
      )}

      {loading && (
        <div className="card text-center py-12">
          <div className="inline-block w-8 h-8 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#3B82F6', borderTopColor: 'transparent' }} />
        </div>
      )}

      {!loading && competitors.length === 0 && (
        <div className="card text-center py-12">
          <p className="text-3xl mb-3">🎯</p>
          <p style={{ color: '#CBD5E1' }}>Még nincs figyelt versenytársad. Add hozzá az első csatornát felül.</p>
        </div>
      )}

      <div className="space-y-4">
        {competitors.map(c => (
          <div key={c.id} className="card">
            <div className="flex items-start justify-between gap-3 mb-4">
              <div className="flex items-center gap-3 min-w-0">
                {c.channel_thumbnail && (
                  <img src={c.channel_thumbnail} alt="" className="w-12 h-12 rounded-full flex-shrink-0" />
                )}
                <div className="min-w-0">
                  <a href={c.channel_url} target="_blank" rel="noopener noreferrer" className="font-medium text-sm hover:underline" style={{ color: '#F8FAFC' }}>
                    {c.channel_title}
                  </a>
                  <p className="text-xs" style={{ color: '#94A3B8' }}>
                    {formatNumber(c.baseline_subscriber_count)} feliratkozó · átlag {formatNumber(c.baseline_avg_views)} megtekintés
                  </p>
                  <p className="text-xs mt-1" style={{ color: '#94A3B8' }}>
                    Növekedés: 7 nap {c.growth_7d?.view_delta == null ? '—' : `+${formatNumber(c.growth_7d.view_delta)} megtekintés`} · 14 nap {c.growth_14d?.view_delta == null ? '—' : `+${formatNumber(c.growth_14d.view_delta)}`} · 28 nap {c.growth_28d?.view_delta == null ? '—' : `+${formatNumber(c.growth_28d.view_delta)}`}
                  </p>
                </div>
              </div>
              <div className="flex gap-2 flex-shrink-0">
                <button onClick={() => refreshCompetitor(c.id)} disabled={refreshingId === c.id} className="text-xs px-3 py-1.5 rounded-lg" style={{ background: '#121826', border: '1px solid rgba(255,255,255,0.08)', color: '#CBD5E1' }}>
                  {refreshingId === c.id ? '...' : '↻ Frissítés'}
                </button>
                <button onClick={() => removeCompetitor(c.id)} className="text-xs px-3 py-1.5 rounded-lg" style={{ background: 'rgba(239,68,68,0.05)', color: '#EF4444', border: '1px solid rgba(239,68,68,0.15)' }}>
                  🗑
                </button>
              </div>
            </div>

            <div className="space-y-2">
              {(c.videos || []).map(v => {
                const videoId = v.video_id || v.videoId || ''
                const isOutlier = v.is_outlier ?? v.isOutlier
                const ratio = v.outlier_ratio ?? v.outlierRatio ?? 0
                return (
                  <div key={videoId} className="flex items-center gap-3 py-2" style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                    {(v.thumbnail_url || v.thumbnailUrl) && (
                      <img src={v.thumbnail_url || v.thumbnailUrl} alt="" className="w-16 h-9 rounded object-cover flex-shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm truncate" style={{ color: '#F8FAFC' }}>{v.title}</p>
                      <p className="text-xs" style={{ color: '#94A3B8' }}>
                        {formatNumber(v.view_count ?? v.viewCount ?? 0)} megtekintés
                        <span className="ml-2">VPH: {v.views_per_hour == null ? 'nincs elég előzmény' : formatNumber(v.views_per_hour)}</span>
                        {isOutlier && (
                          <span className="ml-2 font-semibold" style={{ color: '#F59E0B' }}>🔥 {ratio}x a csatorna átlagánál</span>
                        )}
                      </p>
                    </div>
                    {isOutlier && (
                      <button
                        onClick={() => saveOutlierSignal(v, c.channel_title)}
                        disabled={savedVideos.has(videoId)}
                        className="text-xs px-3 py-1.5 rounded-lg whitespace-nowrap flex-shrink-0"
                        style={{ background: savedVideos.has(videoId) ? 'rgba(34,197,94,0.1)' : 'rgba(245,158,11,0.1)', border: `1px solid ${savedVideos.has(videoId) ? 'rgba(34,197,94,0.3)' : 'rgba(245,158,11,0.3)'}`, color: savedVideos.has(videoId) ? '#22C55E' : '#F59E0B' }}
                      >
                        {savedVideos.has(videoId) ? '✓ Mentve' : '📌 Bizonyítékként mentés'}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
