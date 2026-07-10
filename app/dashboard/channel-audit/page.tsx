'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import CreditConfirmModal from '@/components/CreditConfirmModal'
import type { UsageCheckResult } from '@/lib/usage-protection'

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
  const [data, setData] = useState<ChannelAuditData | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [suggestionsResult, setSuggestionsResult] = useState<SuggestionsResult | null>(null)
  const [generating, setGenerating] = useState(false)
  const [creditCheck, setCreditCheck] = useState<UsageCheckResult | null>(null)
  const [pendingForceRefresh, setPendingForceRefresh] = useState(false)

  useEffect(() => {
    load()
    try {
      const saved = sessionStorage.getItem(SUGGESTIONS_STATE_KEY)
      if (saved) setSuggestionsResult(JSON.parse(saved))
    } catch {}
  }, [])

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
