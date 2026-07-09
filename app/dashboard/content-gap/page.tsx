'use client'

import { useState } from 'react'
import Link from 'next/link'
import CreditConfirmModal from '@/components/CreditConfirmModal'
import type { UsageCheckResult } from '@/lib/usage-protection'

interface ContentGapSuggestion {
  gap_topic: string
  evidence: string
  angle: string
}

const CONTENT_GAP_COST = 2

export default function ContentGapPage() {
  const [niche, setNiche] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [gaps, setGaps] = useState<ContentGapSuggestion[] | null>(null)
  const [existingCount, setExistingCount] = useState<number>(0)
  const [creditCheck, setCreditCheck] = useState<UsageCheckResult | null>(null)
  const [savedTopics, setSavedTopics] = useState<Set<string>>(new Set())

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

      {gaps && (
        <div>
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
