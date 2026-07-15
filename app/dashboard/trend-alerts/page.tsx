'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'

interface TrendAlert {
  candidate_id: string
  candidate_topic: string
  alert_type: 'rising' | 'declining'
  alert_signature: string
  views_delta: number
  total_views: number | null
  trend_velocity: number | null
  message: string
}

type AlertFrequency = 'daily' | 'weekly' | 'off'
interface TrendMonitor { candidate_id: string; candidate_topic: string; alert_frequency: AlertFrequency }

export default function TrendAlertsPage() {
  const [alerts, setAlerts] = useState<TrendAlert[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dismissing, setDismissing] = useState<Set<string>>(new Set())
  const [monitors, setMonitors] = useState<TrendMonitor[]>([])
  const [savingMonitor, setSavingMonitor] = useState<string | null>(null)

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/trend-alerts')
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'A trend riasztások betöltése sikertelen. Próbáld újra később.')
        return
      }
      setAlerts(data.alerts || [])
      setMonitors(data.monitors || [])
    } catch {
      setError('Kapcsolati hiba. Próbáld újra később.')
    } finally {
      setLoading(false)
    }
  }

  async function updateFrequency(candidateId: string, alertFrequency: AlertFrequency) {
    setSavingMonitor(candidateId)
    setError(null)
    try {
      const res = await fetch('/api/trend-alerts', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ candidate_id: candidateId, alert_frequency: alertFrequency }) })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'A riasztási beállítás mentése sikertelen.'); return }
      setMonitors(prev => prev.map(m => m.candidate_id === candidateId ? { ...m, alert_frequency: alertFrequency } : m))
      if (alertFrequency === 'off') setAlerts(prev => prev.filter(a => a.candidate_id !== candidateId))
    } catch {
      setError('Kapcsolati hiba. Próbáld újra később.')
    } finally {
      setSavingMonitor(null)
    }
  }

  async function dismiss(alert: TrendAlert) {
    const key = `${alert.candidate_id}:${alert.alert_signature}`
    setDismissing(prev => new Set(prev).add(key))
    setError(null)
    try {
      const res = await fetch('/api/trend-alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidate_id: alert.candidate_id, alert_signature: alert.alert_signature }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'A riasztás elutasítása sikertelen. Próbáld újra később.')
        return
      }
      setAlerts(prev => prev.filter(a => `${a.candidate_id}:${a.alert_signature}` !== key))
    } catch {
      setError('Kapcsolati hiba. Próbáld újra később.')
    } finally {
      setDismissing(prev => { const next = new Set(prev); next.delete(key); return next })
    }
  }

  const rising = alerts.filter(a => a.alert_type === 'rising')
  const declining = alerts.filter(a => a.alert_type === 'declining')

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-1" style={{ color: '#F8FAFC' }}>🔔 Trend riasztások</h1>
        <p className="text-sm" style={{ color: '#CBD5E1' }}>Erdemi elmozdulás a figyelt trendjeidben — automatikusan, kredit nélkül.</p>
      </div>

      {error && (
        <div className="card mb-6" style={{ background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.2)' }}>
          <p className="text-sm" style={{ color: '#EF4444' }}>{error}</p>
        </div>
      )}

      {loading && (
        <div className="card text-center py-12">
          <div className="inline-block w-8 h-8 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#3B82F6', borderTopColor: 'transparent' }} />
        </div>
      )}

      {!loading && !error && monitors.length > 0 && (
        <div className="card mb-6">
          <h2 className="text-sm font-semibold mb-3" style={{ color: '#F8FAFC' }}>Riasztási gyakoriság</h2>
          <div className="space-y-2">
            {monitors.map(m => (
              <div key={m.candidate_id} className="flex items-center justify-between gap-3">
                <span className="text-sm truncate" style={{ color: '#CBD5E1' }}>{m.candidate_topic}</span>
                <select value={m.alert_frequency} disabled={savingMonitor === m.candidate_id} onChange={e => updateFrequency(m.candidate_id, e.target.value as AlertFrequency)} className="px-3 py-1.5 rounded-lg text-xs" style={{ background: '#121826', border: '1px solid rgba(255,255,255,0.08)', color: '#F8FAFC' }}>
                  <option value="daily">Naponta</option>
                  <option value="weekly">Hetente</option>
                  <option value="off">Kikapcsolva</option>
                </select>
              </div>
            ))}
          </div>
        </div>
      )}

      {!loading && !error && alerts.length === 0 && (
        <div className="card text-center py-12">
          <p className="text-3xl mb-3">🔔</p>
          <p style={{ color: '#CBD5E1' }} className="mb-2">Nincs erdemi elmozdulás a figyelt trendjeidben most.</p>
          <Link href="/dashboard" className="btn-primary inline-block mt-3">Trend Feed megnyitása →</Link>
        </div>
      )}

      {!loading && !error && alerts.length > 0 && (
        <div className="space-y-6">
          {rising.length > 0 && (
            <div>
              <p className="text-xs mb-3" style={{ color: '#22C55E' }}>🔥 ERŐSÖDŐ TRENDEK ({rising.length})</p>
              <div className="space-y-3">
                {rising.map(a => {
                  const key = `${a.candidate_id}:${a.alert_signature}`
                  return (
                    <div key={key} className="card-hover" style={{ borderLeft: '3px solid #22C55E' }}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <h3 className="font-medium text-sm mb-1" style={{ color: '#F8FAFC' }}>{a.candidate_topic}</h3>
                          <p className="text-xs" style={{ color: '#22C55E' }}>{a.message}</p>
                        </div>
                        <div className="flex gap-2 flex-shrink-0">
                          <Link href={`/dashboard/viral-score?topic=${encodeURIComponent(a.candidate_topic)}`} className="text-xs px-3 py-1.5 rounded-lg" style={{ background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.3)', color: '#3B82F6' }}>
                            📈 Validálás
                          </Link>
                          <button onClick={() => dismiss(a)} disabled={dismissing.has(key)} className="text-xs px-3 py-1.5 rounded-lg" style={{ background: '#121826', border: '1px solid rgba(255,255,255,0.08)', color: '#CBD5E1' }}>
                            Rendben
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {declining.length > 0 && (
            <div>
              <p className="text-xs mb-3" style={{ color: '#94A3B8' }}>📉 GYENGÜLŐ TRENDEK ({declining.length})</p>
              <div className="space-y-3">
                {declining.map(a => {
                  const key = `${a.candidate_id}:${a.alert_signature}`
                  return (
                    <div key={key} className="card-hover" style={{ borderLeft: '3px solid #94A3B8' }}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <h3 className="font-medium text-sm mb-1" style={{ color: '#F8FAFC' }}>{a.candidate_topic}</h3>
                          <p className="text-xs" style={{ color: '#94A3B8' }}>{a.message}</p>
                        </div>
                        <button onClick={() => dismiss(a)} disabled={dismissing.has(key)} className="text-xs px-3 py-1.5 rounded-lg flex-shrink-0" style={{ background: '#121826', border: '1px solid rgba(255,255,255,0.08)', color: '#CBD5E1' }}>
                          Rendben
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
