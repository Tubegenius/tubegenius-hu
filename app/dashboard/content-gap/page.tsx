'use client'

import { useState, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import CreditConfirmModal from '@/components/CreditConfirmModal'
import type { UsageCheckResult } from '@/lib/usage-protection'
import LoadingScreen, { LOADING_STEPS } from '@/components/ui/LoadingScreen'

interface ContentGapSuggestion {
  gap_topic: string
  evidence: string
  angle: string
}

const CONTENT_GAP_COST = 2

export default function ContentGapPage() {
  const searchParams = useSearchParams()
  const [niche, setNiche] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [gaps, setGaps] = useState<ContentGapSuggestion[] | null>(null)
  const [existingCount, setExistingCount] = useState<number>(0)
  const [creditCheck, setCreditCheck] = useState<UsageCheckResult | null>(null)
  const [savedTopics, setSavedTopics] = useState<Set<string>>(new Set())
  const [fromPaidResult, setFromPaidResult] = useState(false)

  // Mentett eredmény visszaállítása: explicit paidResultId a linkből (pl. a
  // Command Center "Legutóbbi történeted" paneljéről), vagy a sessionStorage-ból.
  useEffect(() => {
    const paidResultId = searchParams.get('paidResultId')
    if (paidResultId) {
      loadPaidResult(paidResultId)
      return
    }
    const saved = sessionStorage.getItem('willviral_content_gap_state')
    if (saved) {
      try {
        const state = JSON.parse(saved)
        if (state.niche) setNiche(state.niche)
        if (state.gaps) setGaps(state.gaps)
        if (state.existingCount) setExistingCount(state.existingCount)
      } catch {}
    }
  }, [])

  async function loadPaidResult(id: string) {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/content-gap?paidResultId=${id}`)
      const data = await res.json()
      if (!res.ok || data.error) {
        setError(data.error || 'A mentett eredmény nem található.')
        return
      }
      setNiche(data.niche || '')
      setGaps(data.gaps || null)
      setExistingCount(data.existing_video_count || 0)
      setFromPaidResult(true)
    } catch {
      setError('Hiba a mentett eredmény betöltésekor.')
    } finally {
      setLoading(false)
    }
  }

  async function runSearch() {
    if (!niche.trim()) return
    setError(null)
    try {
      const creditsRes = await fetch('/api/credits')
      const credits = await creditsRes.json()
      const balance = Number(credits.balance ?? 0)
      setCreditCheck({
        feature: 'Content Gap Finder',
        cost: CONTENT_GAP_COST,
        currency: 'credit',
        currentCredits: balance,
        remainingCreditsAfterRun: balance - CONTENT_GAP_COST,
        requiresConfirmation: true,
        canRun: balance >= CONTENT_GAP_COST,
        reason: balance >= CONTENT_GAP_COST ? undefined : 'insufficient_credits',
        message: balance >= CONTENT_GAP_COST ? 'Valós YouTube-lefedettség és Google-keresési igény összevetése — mit nem gyárt még senki jól.' : 'Ehhez nincs elég kredited.',
      })
    } catch {
      setError('Kapcsolati hiba.')
    }
  }

  async function confirmSearch() {
    setCreditCheck(null)
    setLoading(true)
    setFromPaidResult(false)
    try {
      const res = await fetch('/api/content-gap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ niche, platform: 'youtube', region: 'HU' }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Elemzés sikertelen.')
        return
      }
      setGaps(data.gaps)
      setExistingCount(data.existing_video_count)
      sessionStorage.setItem('willviral_content_gap_state', JSON.stringify({ niche, gaps: data.gaps, existingCount: data.existing_video_count }))
    } catch {
      setError('Kapcsolati hiba.')
    } finally {
      setLoading(false)
    }
  }

  async function saveGap(gap: ContentGapSuggestion) {
    setSavedTopics(prev => new Set(prev).add(gap.gap_topic))
    await fetch('/api/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: gap.gap_topic, search_keyword: niche, state: 'saved', platform: 'youtube', source_context: 'content_gap' }),
    })
  }

  return (
    <div className="max-w-3xl mx-auto">
      {creditCheck && (
        <CreditConfirmModal check={creditCheck} onConfirm={confirmSearch} onCancel={() => setCreditCheck(null)} loading={loading} />
      )}

      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-1" style={{ color: '#F8FAFC' }}>🕳️ Content Gap Finder</h1>
        <p className="text-sm" style={{ color: '#CBD5E1' }}>Amit sokan keresnek, de a meglévő videók nem fedik le jól.</p>
      </div>

      <div className="card mb-6">
        <div className="flex gap-2">
          <input
            value={niche}
            onChange={e => setNiche(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && runSearch()}
            placeholder="Niche vagy tágabb téma (pl. otthoni edzés, AI eszközök...)"
            className="flex-1 px-4 py-2.5 rounded-lg text-sm"
            style={{ background: '#121826', border: '1px solid rgba(255,255,255,0.08)', color: '#F8FAFC' }}
          />
          <button onClick={runSearch} disabled={loading || !niche.trim()} className="btn-primary px-5">
            {loading ? 'Elemzés...' : 'Rések keresése'}
          </button>
        </div>
      </div>

      {error && (
        <div className="card mb-6" style={{ background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.2)' }}>
          <p className="text-sm" style={{ color: '#EF4444' }}>{error}</p>
        </div>
      )}

      {loading && (
        <div className="card">
          <LoadingScreen steps={LOADING_STEPS.contentGap} />
        </div>
      )}

      {gaps && (
        <div>
          {fromPaidResult && (
            <div className="rounded-xl px-4 py-3 mb-3" style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)' }}>
              <p className="text-sm font-medium" style={{ color: '#93C5FD' }}>Mentett eredmény betöltve</p>
              <p className="text-xs mt-0.5" style={{ color: '#94A3B8' }}>Nem vontunk le új kreditet.</p>
            </div>
          )}
          <p className="text-xs mb-3" style={{ color: '#94A3B8' }}>
            {existingCount} létező videó elemezve · {gaps.length} rés-jelölt találva
          </p>
          <div className="space-y-3">
            {gaps.map((g, i) => (
              <div key={i} className="card-hover">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <h3 className="font-medium text-sm flex-1" style={{ color: '#F8FAFC' }}>{g.gap_topic}</h3>
                  <button
                    onClick={() => saveGap(g)}
                    disabled={savedTopics.has(g.gap_topic)}
                    className="text-xs px-3 py-1.5 rounded-lg whitespace-nowrap flex-shrink-0"
                    style={{ background: savedTopics.has(g.gap_topic) ? 'rgba(34,197,94,0.1)' : 'rgba(59,130,246,0.1)', border: `1px solid ${savedTopics.has(g.gap_topic) ? 'rgba(34,197,94,0.3)' : 'rgba(59,130,246,0.3)'}`, color: savedTopics.has(g.gap_topic) ? '#22C55E' : '#3B82F6' }}
                  >
                    {savedTopics.has(g.gap_topic) ? '✓ Mentve' : '📌 Mentés'}
                  </button>
                </div>
                <p className="text-xs mb-2" style={{ color: '#F59E0B' }}>💡 {g.evidence}</p>
                <p className="text-xs mb-3" style={{ color: '#CBD5E1' }}>{g.angle}</p>
                <Link href={`/dashboard/opportunities?niche=${encodeURIComponent(g.gap_topic)}`} className="text-xs" style={{ color: '#3B82F6' }}>🧭 Validálás →</Link>
              </div>
            ))}
          </div>
        </div>
      )}

      {!gaps && !loading && (
        <div className="card text-center py-12">
          <p className="text-3xl mb-3">🕳️</p>
          <p style={{ color: '#CBD5E1' }}>Írj be egy niche-t, és megmutatjuk, mit keresnek sokan, de senki nem gyárt még jól.</p>
        </div>
      )}
    </div>
  )
}
