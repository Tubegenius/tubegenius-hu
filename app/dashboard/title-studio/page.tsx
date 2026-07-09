'use client'

import { useState } from 'react'
import CreditConfirmModal from '@/components/CreditConfirmModal'
import type { UsageCheckResult } from '@/lib/usage-protection'

interface TitleVariation {
  title: string
  curiosity_score: number
  clarity_score: number
  clickability_score: number
  risk_score: number
  reasoning: string
  heuristics: {
    length: number
    length_flag: 'ok' | 'too_long' | 'too_short'
    has_number: boolean
    has_question: boolean
    excessive_caps: boolean
    clickbait_symbol_overuse: boolean
  }
}

const TITLE_STUDIO_COST = 1

function ScoreBar({ label, value }: { label: string; value: number }) {
  const color = value >= 70 ? '#22C55E' : value >= 40 ? '#F59E0B' : '#EF4444'
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-24 flex-shrink-0" style={{ color: '#94A3B8' }}>{label}</span>
      <div className="flex-1 h-1.5 rounded-full" style={{ background: '#121826' }}>
        <div className="h-full rounded-full" style={{ width: `${value}%`, background: color }} />
      </div>
      <span className="w-8 text-right font-medium" style={{ color: '#F8FAFC' }}>{value}</span>
    </div>
  )
}

export default function TitleStudioPage() {
  const [topic, setTopic] = useState('')
  const [existingTitle, setExistingTitle] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [variations, setVariations] = useState<TitleVariation[] | null>(null)
  const [creditCheck, setCreditCheck] = useState<UsageCheckResult | null>(null)
  const [savedTitles, setSavedTitles] = useState<Set<string>>(new Set())

  async function runGenerate() {
    if (!topic.trim()) return
    setError(null)
    try {
      const creditsRes = await fetch('/api/credits')
      const credits = await creditsRes.json()
      const balance = Number(credits.balance ?? 0)
      setCreditCheck({
        feature: 'Title Studio',
        cost: TITLE_STUDIO_COST,
        currency: 'credit',
        currentCredits: balance,
        remainingCreditsAfterRun: balance - TITLE_STUDIO_COST,
        requiresConfirmation: true,
        canRun: balance >= TITLE_STUDIO_COST,
        reason: balance >= TITLE_STUDIO_COST ? undefined : 'insufficient_credits',
        message: balance >= TITLE_STUDIO_COST ? '5 különböző címvariáció, mindegyik AI-értékeléssel (nem mért adat).' : 'Ehhez nincs elég kredited.',
      })
    } catch {
      setError('Kapcsolati hiba.')
    }
  }

  async function confirmGenerate() {
    setCreditCheck(null)
    setLoading(true)
    try {
      const res = await fetch('/api/title-studio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, existing_title: existingTitle || undefined, platform: 'youtube', region: 'HU' }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Cím-generálás sikertelen.')
        return
      }
      setVariations(data.variations)
    } catch {
      setError('Kapcsolati hiba.')
    } finally {
      setLoading(false)
    }
  }

  async function saveTitle(title: string) {
    setSavedTitles(prev => new Set(prev).add(title))
    await fetch('/api/title-studio', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, title, platform: 'youtube' }),
    })
  }

  return (
    <div className="max-w-3xl mx-auto">
      {creditCheck && (
        <CreditConfirmModal check={creditCheck} onConfirm={confirmGenerate} onCancel={() => setCreditCheck(null)} loading={loading} />
      )}

      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-1" style={{ color: '#F8FAFC' }}>✏️ Title Studio</h1>
        <p className="text-sm" style={{ color: '#CBD5E1' }}>5 címvariáció, AI-értékeléssel — kíváncsiság, világosság, kattinthatóság, clickbait-kockázat.</p>
      </div>

      <div className="card mb-6 space-y-3">
        <input
          value={topic}
          onChange={e => setTopic(e.target.value)}
          placeholder="Miről szól a videó?"
          className="w-full px-4 py-2.5 rounded-lg text-sm"
          style={{ background: '#121826', border: '1px solid rgba(255,255,255,0.08)', color: '#F8FAFC' }}
        />
        <input
          value={existingTitle}
          onChange={e => setExistingTitle(e.target.value)}
          placeholder="Van már egy cím-ötleted? (opcionális)"
          className="w-full px-4 py-2.5 rounded-lg text-sm"
          style={{ background: '#121826', border: '1px solid rgba(255,255,255,0.08)', color: '#F8FAFC' }}
        />
        <button onClick={runGenerate} disabled={loading || !topic.trim()} className="btn-primary w-full">
          {loading ? 'Generálás...' : 'Címvariációk generálása'}
        </button>
      </div>

      {error && (
        <div className="card mb-6" style={{ background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.2)' }}>
          <p className="text-sm" style={{ color: '#EF4444' }}>{error}</p>
        </div>
      )}

      {variations && (
        <div className="space-y-3">
          {variations.map((v, i) => (
            <div key={i} className="card-hover">
              <div className="flex items-start justify-between gap-3 mb-3">
                <h3 className="font-medium text-sm flex-1" style={{ color: '#F8FAFC' }}>{v.title}</h3>
                <button
                  onClick={() => saveTitle(v.title)}
                  disabled={savedTitles.has(v.title)}
                  className="text-xs px-3 py-1.5 rounded-lg whitespace-nowrap flex-shrink-0"
                  style={{ background: savedTitles.has(v.title) ? 'rgba(34,197,94,0.1)' : 'rgba(59,130,246,0.1)', border: `1px solid ${savedTitles.has(v.title) ? 'rgba(34,197,94,0.3)' : 'rgba(59,130,246,0.3)'}`, color: savedTitles.has(v.title) ? '#22C55E' : '#3B82F6' }}
                >
                  {savedTitles.has(v.title) ? '✓ Mentve' : '📌 Mentés'}
                </button>
              </div>

              <div className="space-y-1.5 mb-3">
                <ScoreBar label="Kíváncsiság" value={v.curiosity_score} />
                <ScoreBar label="Világosság" value={v.clarity_score} />
                <ScoreBar label="Kattinthatóság" value={v.clickability_score} />
                <ScoreBar label="Clickbait-kockázat" value={v.risk_score} />
              </div>

              <p className="text-xs mb-2" style={{ color: '#CBD5E1' }}>{v.reasoning}</p>

              <div className="flex gap-1.5 flex-wrap">
                <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: '#121826', color: '#94A3B8' }}>{v.heuristics.length} karakter</span>
                {v.heuristics.length_flag === 'too_long' && (
                  <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(239,68,68,0.1)', color: '#EF4444' }}>⚠️ Túl hosszú</span>
                )}
                {v.heuristics.length_flag === 'too_short' && (
                  <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(245,158,11,0.1)', color: '#F59E0B' }}>Túl rövid</span>
                )}
                {v.heuristics.excessive_caps && (
                  <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(239,68,68,0.1)', color: '#EF4444' }}>⚠️ Túl sok nagybetű</span>
                )}
                {v.heuristics.clickbait_symbol_overuse && (
                  <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(239,68,68,0.1)', color: '#EF4444' }}>⚠️ Túlzsúfolt írásjelek</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {!variations && !loading && (
        <div className="card text-center py-12">
          <p className="text-3xl mb-3">✏️</p>
          <p style={{ color: '#CBD5E1' }}>Írd be a témát, és 5 különböző megközelítésű címet kapsz értékeléssel.</p>
        </div>
      )}
    </div>
  )
}
