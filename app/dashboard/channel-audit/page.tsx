'use client'

import { useState, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import CreditConfirmModal from '@/components/CreditConfirmModal'
import type { UsageCheckResult } from '@/lib/usage-protection'
import LoadingScreen, { LOADING_STEPS } from '@/components/ui/LoadingScreen'
import ChannelHeaderCard, { type ChannelProfile } from '@/components/channel-audit/ChannelHeaderCard'

interface ChannelVideoPerformance {
  videoId: string
  title: string | null
  views: number
  estimatedMinutesWatched: number
  averageViewDuration: number
}

interface ChannelAnalyticsSummary {
  channelId: string
  channelTitle: string | null
  rangeStart: string
  rangeEnd: string
  totals: { views: number; estimatedMinutesWatched: number; subscribersGained: number; subscribersLost: number }
  topVideos: ChannelVideoPerformance[]
  weakestVideos: ChannelVideoPerformance[]
}

interface DimensionAverages {
  hook_strength: number
  retention_potential: number
  engagement_quality: number
  platform_fit: number
  packaging_quality: number
}

interface AuditSummary {
  id: string
  video_title: string
  overall_score: number
  overall_label: string
  created_at: string
}

interface ChannelAuditData {
  has_enough_data: boolean
  audit_count: number
  min_required?: number
  dimension_averages?: DimensionAverages
  weakest_dimension?: { key: string; label: string; value: number }
  top_strong?: AuditSummary[]
  top_weak?: AuditSummary[]
  publish_rhythm?: Array<{ month: string; count: number }>
}

const DIMENSION_LABELS: Record<keyof DimensionAverages, string> = {
  hook_strength: 'Hook erősség',
  retention_potential: 'Retenciós potenciál',
  engagement_quality: 'Engagement minőség',
  platform_fit: 'Platform illeszkedés',
  packaging_quality: 'Csomagolás minőség',
}

const CHANNEL_AUDIT_COST = 2
const SUGGESTIONS_STATE_KEY = 'willviral_channel_audit_suggestions'

interface SuggestionsResult {
  suggestions: Array<{ topic: string; reasoning: string }>
  from_paid_result?: boolean
  cache_status?: 'fresh' | 'stale_saved'
  last_analyzed_at?: string
  paid_result_id?: string | null
}

export default function ChannelAuditPage() {
  const searchParams = useSearchParams()
  const [data, setData] = useState<ChannelAuditData | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [suggestionsResult, setSuggestionsResult] = useState<SuggestionsResult | null>(null)
  const [generating, setGenerating] = useState(false)
  const [creditCheck, setCreditCheck] = useState<UsageCheckResult | null>(null)
  const [pendingForceRefresh, setPendingForceRefresh] = useState(false)

  const [channelAnalytics, setChannelAnalytics] = useState<ChannelAnalyticsSummary | null>(null)
  const [channelConnected, setChannelConnected] = useState<boolean | null>(null)
  const [channelProfile, setChannelProfile] = useState<ChannelProfile | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)

  useEffect(() => {
    loadChannelAnalytics()
    load()
    const oauthStatus = searchParams.get('youtube_oauth')
    if (oauthStatus === 'error') {
      const msg = searchParams.get('youtube_oauth_message')
      setError(`A csatorna-összekapcsolás sikertelen (${msg || 'ismeretlen hiba'}). Próbáld újra.`)
    }
    const paidResultId = searchParams.get('paidResultId')
    if (paidResultId) {
      loadPaidResult(paidResultId)
      return
    }
    try {
      const saved = sessionStorage.getItem(SUGGESTIONS_STATE_KEY)
      if (saved) setSuggestionsResult(JSON.parse(saved))
    } catch {}
  }, [])

  // Mentett "következő 10 videó" javaslat visszaállítása explicit paidResultId
  // alapján (pl. a Command Center "Legutóbbi történeted" paneljéről) — kredit nélkül.
  async function loadPaidResult(id: string) {
    setGenerating(true)
    setError(null)
    try {
      const res = await fetch(`/api/channel-audit?paidResultId=${id}`)
      const body = await res.json()
      if (!res.ok || body.error) {
        setError(body.error || 'A mentett javaslat nem található.')
        return
      }
      setSuggestionsResult(body)
      try { sessionStorage.setItem(SUGGESTIONS_STATE_KEY, JSON.stringify(body)) } catch {}
    } catch {
      setError('Hiba a mentett javaslat betöltésekor.')
    } finally {
      setGenerating(false)
    }
  }

  async function loadChannelAnalytics() {
    try {
      const res = await fetch('/api/youtube/analytics')
      if (res.status === 404) {
        setChannelConnected(false)
        setChannelProfile(null)
        return
      }
      const body = await res.json()
      if (!res.ok) {
        setChannelConnected(false)
        setChannelProfile(null)
        return
      }
      setChannelProfile(body.channel_profile || null)
      // A "channelConnected" tovabbra is a PRIVAT OAuth-analitika (nezettseg,
      // watch time) meglletet jelzi — a Header Card ettol fuggetlenul, a
      // channelProfile alapjan jelenik meg, publikus (nem-OAuth) usereknel is.
      if (body.analytics_available) {
        setChannelAnalytics(body)
        setChannelConnected(true)
      } else {
        setChannelAnalytics(null)
        setChannelConnected(false)
      }
    } catch {
      setChannelConnected(false)
      setChannelProfile(null)
    }
  }

  function connectChannel() {
    setConnecting(true)
    // Onallo, Supabase Authtol fuggetlen Google OAuth2 kor — ld.
    // app/api/youtube/connect. Egyszeru navigacio, nincs kliens oldali
    // Supabase-identity-kezeles.
    window.location.href = '/api/youtube/connect'
  }

  async function disconnectChannel() {
    setDisconnecting(true)
    try {
      const res = await fetch('/api/youtube/disconnect', { method: 'POST' })
      if (res.ok) {
        setChannelConnected(false)
        setChannelAnalytics(null)
      } else {
        setError('A kapcsolat bontása sikertelen.')
      }
    } catch {
      setError('Kapcsolati hiba.')
    } finally {
      setDisconnecting(false)
    }
  }

  async function load() {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await fetch('/api/channel-audit')
      const body = await res.json()
      if (!res.ok) {
        setLoadError(body.error || 'A Channel Audit adatok betöltése sikertelen. Próbáld újra később.')
        return
      }
      setData(body)
    } catch {
      setLoadError('Kapcsolati hiba. Próbáld újra később.')
    } finally {
      setLoading(false)
    }
  }

  async function requestSuggestions(forceRefresh = false) {
    setError(null)
    try {
      const creditsRes = await fetch('/api/credits')
      const credits = await creditsRes.json()
      const balance = Number(credits.balance ?? 0)
      setPendingForceRefresh(forceRefresh)
      setCreditCheck({
        feature: 'Channel Audit — következő videók',
        cost: CHANNEL_AUDIT_COST,
        currency: 'credit',
        currentCredits: balance,
        remainingCreditsAfterRun: balance - CHANNEL_AUDIT_COST,
        requiresConfirmation: true,
        canRun: balance >= CHANNEL_AUDIT_COST,
        reason: balance >= CHANNEL_AUDIT_COST ? undefined : 'insufficient_credits',
        message: balance >= CHANNEL_AUDIT_COST
          ? (forceRefresh ? 'Új, friss javaslatot kérünk — ez új kreditet használ.' : '10 videótéma-javaslat a valós audit-előzményed mintázatai alapján. Ha a mintázat nem változott, nem vonunk le új kreditet.')
          : 'Ehhez nincs elég kredited.',
      })
    } catch {
      setError('Kapcsolati hiba.')
    }
  }

  async function confirmSuggestions() {
    setCreditCheck(null)
    setGenerating(true)
    try {
      const res = await fetch('/api/channel-audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force_refresh: pendingForceRefresh }),
      })
      const body = await res.json()
      if (!res.ok) {
        setError(body.error || 'Generálás sikertelen.')
        return
      }
      setSuggestionsResult(body)
      try { sessionStorage.setItem(SUGGESTIONS_STATE_KEY, JSON.stringify(body)) } catch {}
    } catch {
      setError('Kapcsolati hiba.')
    } finally {
      setGenerating(false)
      setPendingForceRefresh(false)
    }
  }

  return (
    <div className="max-w-3xl mx-auto">
      {creditCheck && (
        <CreditConfirmModal check={creditCheck} onConfirm={confirmSuggestions} onCancel={() => setCreditCheck(null)} loading={generating} />
      )}

      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-1" style={{ color: '#F8FAFC' }}>📊 Channel Audit</h1>
        <p className="text-sm" style={{ color: '#CBD5E1' }}>Az eddigi Videódiagnózisaid mintázata — mi erős, mi gyenge, mit gyárts legközelebb.</p>
      </div>

      {channelProfile && (
        <div className="mb-6">
          <ChannelHeaderCard channel={channelProfile} />
        </div>
      )}

      {channelConnected === false && (
        <div className="card mb-6 flex items-center justify-between gap-4 flex-wrap" style={{ background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.2)' }}>
          <div>
            <p className="text-sm font-medium" style={{ color: '#93C5FD' }}>
              {channelProfile ? '🔗 YouTube-fiók összekötése mélyebb elemzéshez' : '🔗 Kösd össze a YouTube csatornád'}
            </p>
            <p className="text-xs mt-1" style={{ color: '#94A3B8' }}>Valós nézettség, watch time és feliratkozó-adatok jelennek meg a kézi audit-mintázat mellett.</p>
          </div>
          <button onClick={connectChannel} disabled={connecting} className="btn-primary text-sm px-4 py-1.5 flex-shrink-0">
            {connecting ? 'Átirányítás...' : 'Csatorna összekapcsolása'}
          </button>
        </div>
      )}

      {channelConnected && channelAnalytics && (
        <div className="card mb-6">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <p className="text-xs" style={{ color: '#94A3B8' }}>
              📡 VALÓS CSATORNA-ANALITIKA {channelAnalytics.channelTitle ? `— ${channelAnalytics.channelTitle}` : ''} ({channelAnalytics.rangeStart} – {channelAnalytics.rangeEnd})
            </p>
            <button onClick={disconnectChannel} disabled={disconnecting}
              className="text-xs px-3 py-1.5 rounded-lg font-semibold"
              style={{ background: 'rgba(255,255,255,0.06)', color: '#94A3B8' }}>
              {disconnecting ? 'Bontás...' : 'Kapcsolat bontása'}
            </button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="rounded-lg px-3 py-2" style={{ background: '#0A0E18', border: '1px solid rgba(255,255,255,0.06)' }}>
              <p className="text-xs mb-0.5" style={{ color: '#94A3B8' }}>Megtekintés</p>
              <p className="text-sm font-bold" style={{ color: '#F8FAFC' }}>{channelAnalytics.totals.views.toLocaleString('hu-HU')}</p>
            </div>
            <div className="rounded-lg px-3 py-2" style={{ background: '#0A0E18', border: '1px solid rgba(255,255,255,0.06)' }}>
              <p className="text-xs mb-0.5" style={{ color: '#94A3B8' }}>Watch time (perc)</p>
              <p className="text-sm font-bold" style={{ color: '#F8FAFC' }}>{Math.round(channelAnalytics.totals.estimatedMinutesWatched).toLocaleString('hu-HU')}</p>
            </div>
            <div className="rounded-lg px-3 py-2" style={{ background: '#0A0E18', border: '1px solid rgba(255,255,255,0.06)' }}>
              <p className="text-xs mb-0.5" style={{ color: '#94A3B8' }}>Új feliratkozó</p>
              <p className="text-sm font-bold" style={{ color: '#22C55E' }}>+{channelAnalytics.totals.subscribersGained.toLocaleString('hu-HU')}</p>
            </div>
            <div className="rounded-lg px-3 py-2" style={{ background: '#0A0E18', border: '1px solid rgba(255,255,255,0.06)' }}>
              <p className="text-xs mb-0.5" style={{ color: '#94A3B8' }}>Elvesztett feliratkozó</p>
              <p className="text-sm font-bold" style={{ color: '#EF4444' }}>-{channelAnalytics.totals.subscribersLost.toLocaleString('hu-HU')}</p>
            </div>
          </div>

          {(channelAnalytics.topVideos.length > 0 || channelAnalytics.weakestVideos.length > 0) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
              <div>
                <p className="text-xs mb-2" style={{ color: '#22C55E' }}>🏆 LEGJOBBAN TELJESÍTŐ VIDEÓID (valós nézettség)</p>
                <div className="space-y-1.5">
                  {channelAnalytics.topVideos.map(v => (
                    <a key={v.videoId} href={`https://www.youtube.com/watch?v=${v.videoId}`} target="_blank" rel="noopener noreferrer"
                      className="block rounded-lg px-3 py-2 hover:opacity-80" style={{ background: '#0A0E18', border: '1px solid rgba(255,255,255,0.06)' }}>
                      <p className="text-xs truncate" style={{ color: '#F8FAFC' }}>{v.title || v.videoId}</p>
                      <p className="text-xs" style={{ color: '#22C55E' }}>{v.views.toLocaleString('hu-HU')} megtekintés</p>
                    </a>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-xs mb-2" style={{ color: '#EF4444' }}>📉 LEGGYENGÉBBEN TELJESÍTŐ VIDEÓID (valós nézettség)</p>
                <div className="space-y-1.5">
                  {channelAnalytics.weakestVideos.map(v => (
                    <a key={v.videoId} href={`https://www.youtube.com/watch?v=${v.videoId}`} target="_blank" rel="noopener noreferrer"
                      className="block rounded-lg px-3 py-2 hover:opacity-80" style={{ background: '#0A0E18', border: '1px solid rgba(255,255,255,0.06)' }}>
                      <p className="text-xs truncate" style={{ color: '#F8FAFC' }}>{v.title || v.videoId}</p>
                      <p className="text-xs" style={{ color: '#EF4444' }}>{v.views.toLocaleString('hu-HU')} megtekintés</p>
                    </a>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {loading && (
        <div className="card text-center py-12">
          <div className="inline-block w-8 h-8 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#3B82F6', borderTopColor: 'transparent' }} />
        </div>
      )}

      {loadError && (
        <div className="card text-center py-12" style={{ background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.2)' }}>
          <p className="text-sm mb-3" style={{ color: '#EF4444' }}>{loadError}</p>
          <button onClick={load} className="btn-secondary text-sm px-4 py-1.5">Újrapróbálás</button>
        </div>
      )}

      {!loading && !loadError && data && !data.has_enough_data && (
        <div className="card text-center py-12">
          <p className="text-3xl mb-3">📊</p>
          <p style={{ color: '#CBD5E1' }} className="mb-2">
            Még csak {data.audit_count} Videódiagnózisod van — legalább {data.min_required} szükséges a mintázat-elemzéshez.
          </p>
          <Link href="/dashboard/video-audit" className="btn-primary inline-block mt-3">Videódiagnózis készítése →</Link>
        </div>
      )}

      {error && (
        <div className="card mb-6" style={{ background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.2)' }}>
          <p className="text-sm" style={{ color: '#EF4444' }}>{error}</p>
        </div>
      )}

      {!loading && !loadError && data && data.has_enough_data && (
        <div className="space-y-6">
          <p className="text-xs" style={{ color: '#94A3B8' }}>
            ⬇️ Az alábbi szekciók a kézzel beküldött <Link href="/dashboard/video-audit" className="underline">Videódiagnózisaid</Link> AI-értékelésén alapulnak (nem a fenti valós YouTube-adaton).
          </p>
          <div className="card">
            <p className="text-xs mb-3" style={{ color: '#94A3B8' }}>DIMENZIÓ-ÁTLAGOK ({data.audit_count} audit alapján)</p>
            <div className="space-y-2">
              {data.dimension_averages && (Object.keys(data.dimension_averages) as (keyof DimensionAverages)[]).map(key => {
                const value = data.dimension_averages![key]
                const isWeakest = data.weakest_dimension?.key === key
                return (
                  <div key={key} className="flex items-center gap-2 text-xs">
                    <span className="w-40 flex-shrink-0" style={{ color: isWeakest ? '#F59E0B' : '#94A3B8' }}>
                      {DIMENSION_LABELS[key]} {isWeakest && '⚠️'}
                    </span>
                    <div className="flex-1 h-1.5 rounded-full" style={{ background: '#121826' }}>
                      <div className="h-full rounded-full" style={{ width: `${value}%`, background: value >= 70 ? '#22C55E' : value >= 40 ? '#F59E0B' : '#EF4444' }} />
                    </div>
                    <span className="w-8 text-right font-medium" style={{ color: '#F8FAFC' }}>{value}</span>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="card">
              <p className="text-xs mb-3" style={{ color: '#22C55E' }}>LEGERŐSEBB TÉMÁK</p>
              <div className="space-y-2">
                {(data.top_strong || []).map(a => (
                  <Link key={a.id} href={`/dashboard/video-audit?id=${a.id}`} className="block text-xs hover:underline" style={{ color: '#F8FAFC' }}>
                    {a.video_title} <span style={{ color: '#22C55E' }}>({a.overall_score})</span>
                  </Link>
                ))}
              </div>
            </div>
            <div className="card">
              <p className="text-xs mb-3" style={{ color: '#EF4444' }}>LEGGYENGÉBB TÉMÁK</p>
              <div className="space-y-2">
                {(data.top_weak || []).map(a => (
                  <Link key={a.id} href={`/dashboard/video-audit?id=${a.id}`} className="block text-xs hover:underline" style={{ color: '#F8FAFC' }}>
                    {a.video_title} <span style={{ color: '#EF4444' }}>({a.overall_score})</span>
                  </Link>
                ))}
              </div>
            </div>
          </div>

          {(data.publish_rhythm?.length || 0) > 0 && (
            <div className="card">
              <p className="text-xs mb-3" style={{ color: '#94A3B8' }}>PUBLIKÁLÁSI RITMUS</p>
              <div className="flex items-end gap-2" style={{ height: 80 }}>
                {data.publish_rhythm!.map(r => (
                  <div key={r.month} className="flex-1 flex flex-col items-center justify-end gap-1">
                    <div className="w-full rounded-t" style={{ height: `${Math.min(100, r.count * 20)}%`, background: '#3B82F6', minHeight: 4 }} />
                    <span className="text-xs" style={{ color: '#94A3B8' }}>{r.month.slice(5)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="card">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs" style={{ color: '#94A3B8' }}>KÖVETKEZŐ 10 VIDEÓ JAVASLAT</p>
              {!suggestionsResult && (
                <button onClick={() => requestSuggestions()} disabled={generating} className="btn-primary text-sm px-4 py-1.5">
                  {generating ? 'Generálás...' : 'Javaslatok generálása'}
                </button>
              )}
            </div>
            {generating && !suggestionsResult && (
              <LoadingScreen steps={LOADING_STEPS.channelAudit} />
            )}
            {suggestionsResult?.from_paid_result && (
              <div className="rounded-xl px-4 py-3 flex items-center justify-between gap-3 flex-wrap mb-3"
                style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)' }}>
                <div>
                  <p className="text-sm font-medium" style={{ color: '#93C5FD' }}>
                    {suggestionsResult.cache_status === 'fresh' ? 'Friss mentett javaslat betöltve' : 'Korábbi mentett javaslat betöltve'}
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: '#94A3B8' }}>
                    Nem vontunk le új kreditet.
                    {suggestionsResult.last_analyzed_at && ` Utolsó generálás: ${new Date(suggestionsResult.last_analyzed_at).toLocaleDateString('hu-HU')}.`}
                  </p>
                </div>
                <button onClick={() => requestSuggestions(true)} disabled={generating}
                  className="text-xs px-3 py-2 rounded-lg font-semibold flex-shrink-0"
                  style={{ background: 'rgba(255,255,255,0.06)', color: '#F8FAFC' }}
                  title="A frissítés új generálást indít, ezért kreditet használ.">
                  Javaslat frissítése
                </button>
              </div>
            )}
            {suggestionsResult && (
              <div className="space-y-3">
                {suggestionsResult.suggestions.map((s, i) => (
                  <div key={i} className="py-2" style={{ borderTop: i > 0 ? '1px solid rgba(255,255,255,0.05)' : 'none' }}>
                    <p className="text-sm font-medium" style={{ color: '#F8FAFC' }}>{s.topic}</p>
                    <p className="text-xs" style={{ color: '#CBD5E1' }}>{s.reasoning}</p>
                    <Link href={`/dashboard/opportunities?niche=${encodeURIComponent(s.topic)}`} className="text-xs" style={{ color: '#3B82F6' }}>🧭 Validálás →</Link>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
