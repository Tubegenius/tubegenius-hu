'use client'

import type { UsageCheckResult } from '@/lib/usage-protection'

interface Props {
  check: UsageCheckResult
  onConfirm: () => void
  onCancel: () => void
  loading?: boolean
}

export default function CreditConfirmModal({ check, onConfirm, onCancel, loading }: Props) {
  const featureLabels: Record<string, string> = {
    similar_videos: 'Similar Videos',
    opportunity_engine: 'Opportunity Engine',
    'Video Package (Shorts)': 'Video Package (Shorts)',
    'Video Package (Long)': 'Video Package (Long)',
    'Video Audit': 'Video Audit',
    'Script Extractor': 'Script Extractor',
    'Auto Transcript': 'Auto Transcript',
    'Viral Score': 'Viral Score',
    'Trend mély frissítés': 'Trend mély frissítés',
    trend_deep_refresh: 'Trend mély frissítés',
  }
  const featureName = featureLabels[check.feature] || check.feature

  if (!check.canRun) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(8,11,18,0.7)' }} onClick={onCancel}>
        <div className="rounded-2xl p-6 max-w-sm w-full" style={{ background: '#0F1420', border: '1px solid rgba(255,255,255,0.08)' }} onClick={e => e.stopPropagation()}>
          <h3 className="font-semibold text-lg mb-2" style={{ color: '#F8FAFC' }}>
            {check.reason === 'hard_limit' ? 'Napi limit elérve' : 'Nincs elég kredited'}
          </h3>
          <p className="text-sm mb-4" style={{ color: '#CBD5E1' }}>{check.message}</p>
          {check.reason === 'insufficient_credits' && (
            <div className="rounded-lg px-4 py-3 mb-4" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>
              <div className="flex justify-between text-sm mb-1">
                <span style={{ color: '#CBD5E1' }}>Szükséges</span>
                <span style={{ color: '#EF4444' }} className="font-semibold">{check.cost} kredit</span>
              </div>
              <div className="flex justify-between text-sm">
                <span style={{ color: '#CBD5E1' }}>Jelenlegi kredited</span>
                <span style={{ color: '#EF4444' }} className="font-semibold">{check.currentCredits}</span>
              </div>
            </div>
          )}
          <div className="flex gap-3">
            <button onClick={onCancel} className="flex-1 py-2 rounded-lg text-sm font-medium" style={{ background: '#121826', border: '1px solid rgba(255,255,255,0.08)', color: '#CBD5E1' }}>
              Mégse
            </button>
            {check.reason === 'insufficient_credits' && (
              <a href="/dashboard/credits" className="flex-1 py-2 rounded-lg text-sm font-medium text-center" style={{ background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.3)', color: '#3B82F6' }}>
                Kredit feltöltése
              </a>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(8,11,18,0.7)' }} onClick={onCancel}>
      <div className="rounded-2xl p-6 max-w-sm w-full" style={{ background: '#0F1420', border: '1px solid rgba(255,255,255,0.08)' }} onClick={e => e.stopPropagation()}>
        <h3 className="font-semibold text-lg mb-2" style={{ color: '#F8FAFC' }}>
          {featureName} futtatása
        </h3>
        <p className="text-sm mb-4" style={{ color: '#CBD5E1' }}>{check.message}</p>
        <div className="rounded-lg px-4 py-3 mb-4" style={{ background: 'rgba(59,130,246,0.05)', border: '1px solid rgba(59,130,246,0.15)' }}>
          <div className="flex justify-between text-sm mb-1">
            <span style={{ color: '#CBD5E1' }}>Művelet költsége</span>
            <span style={{ color: '#3B82F6' }} className="font-semibold">{check.cost} kredit</span>
          </div>
          <div className="flex justify-between text-sm mb-1">
            <span style={{ color: '#CBD5E1' }}>Jelenlegi kredited</span>
            <span style={{ color: '#F8FAFC' }} className="font-semibold">{check.currentCredits}</span>
          </div>
          <div className="flex justify-between text-sm pt-2" style={{ borderTop: '1px solid rgba(59,130,246,0.1)' }}>
            <span style={{ color: '#CBD5E1' }}>Futtatás után marad</span>
            <span style={{ color: '#22C55E' }} className="font-semibold">{check.remainingCreditsAfterRun}</span>
          </div>
        </div>
        <div className="flex gap-3">
          <button onClick={onCancel} disabled={loading} className="flex-1 py-2 rounded-lg text-sm font-medium" style={{ background: '#121826', border: '1px solid rgba(255,255,255,0.08)', color: '#CBD5E1' }}>
            Mégse
          </button>
          <button onClick={onConfirm} disabled={loading} className="flex-1 py-2 rounded-lg text-sm font-medium" style={{ background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.3)', color: '#3B82F6' }}>
            {loading ? 'Feldolgozás...' : `Futtatás ${check.cost} kreditért`}
          </button>
        </div>
      </div>
    </div>
  )
}
