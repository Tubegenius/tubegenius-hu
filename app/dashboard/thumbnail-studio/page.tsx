'use client'

import { useState } from 'react'
import CreditConfirmModal from '@/components/CreditConfirmModal'
import type { UsageCheckResult } from '@/lib/usage-protection'

interface ThumbnailConcept {
  concept_label: string
  visual_description: string
  thumbnail_text: string
  composition_note: string
  emotion_or_conflict: string
  contrast_attention_score: number
  clutter_risk: 'low' | 'medium' | 'high'
  text_check: { length: number; word_count: number; readable_at_small_size: boolean }
}

const THUMBNAIL_STUDIO_COST = 1

const CLUTTER_LABELS: Record<string, { label: string; color: string }> = {
  low: { label: 'Alacsony zsúfoltság', color: '#22C55E' },
  medium: { label: 'Közepes zsúfoltság', color: '#F59E0B' },
  high: { label: 'Magas zsúfoltság ⚠️', color: '#EF4444' },
}

export default function ThumbnailStudioPage() {
  const [topic, setTopic] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [concepts, setConcepts] = useState<ThumbnailConcept[] | null>(null)
  const [creditCheck, setCreditCheck] = useState<UsageCheckResult | null>(null)
  const [savedConcepts, setSavedConcepts] = useState<Set<number>>(new Set())

  async function runGenerate() {
    if (!topic.trim()) return
    setError(null)
    try {
      const creditsRes = await fetch('/api/credits')
      const credits = await creditsRes.json()
      const balance = Number(credits.balance ?? 0)
      setCreditCheck({
        feature: 'Thumbnail Studio',
        cost: THUMBNAIL_STUDIO_COST,
        currency: 'credit',
        currentCredits: balance,
        remainingCreditsAfterRun: balance - THUMBNAIL_STUDIO_COST,
        requiresConfirmation: true,
        canRun: balance >= THUMBNAIL_STUDIO_COST,
        reason: balance >= THUMBNAIL_STUDIO_COST ? undefined : 'insufficient_credits',
        message: balance >= THUMBNAIL_STUDIO_COST ? '3 különböző thumbnail-koncepció vizuális leírással és szöveg-javaslattal (nem képgenerálás).' : 'Ehhez nincs elég kredited.',
      })
    } catch {
      setError('Kapcsolati hiba.')
    }
  }

  async function confirmGenerate() {
    setCreditCheck(null)
    setLoading(true)
    try {
      const res = await fetch('/api/thumbnail-studio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, platform: 'youtube', region: 'HU' }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Koncepció-generálás sikertelen.')
        return
      }
      setConcepts(data.concepts)
    } catch {
      setError('Kapcsolati hiba.')
    } finally {
      setLoading(false)
    }
  }

  async function saveConcept(concept: ThumbnailConcept, index: number) {
    setSavedConcepts(prev => new Set(prev).add(index))
    await fetch('/api/thumbnail-studio', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, concept, platform: 'youtube' }),
    })
  }

  return (
    <div className="max-w-3xl mx-auto">
      {creditCheck && (
        <CreditConfirmModal check={creditCheck} onConfirm={confirmGenerate} onCancel={() => setCreditCheck(null)} loading={loading} />
      )}

      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-1" style={{ color: '#F8FAFC' }}>🖼️ Thumbnail Studio</h1>
        <p className="text-sm" style={{ color: '#CBD5E1' }}>3 vizuális koncepció A/B teszthez — kompozíció, szöveg, érzelem/konfliktus javaslattal.</p>
      </div>

      <div className="card mb-6 space-y-3">
        <input
          value={topic}
          onChange={e => setTopic(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && runGenerate()}
          placeholder="Miről szól a videó?"
          className="w-full px-4 py-2.5 rounded-lg text-sm"
          style={{ background: '#121826', border: '1px solid rgba(255,255,255,0.08)', color: '#F8FAFC' }}
        />
        <button onClick={runGenerate} disabled={loading || !topic.trim()} className="btn-primary w-full">
          {loading ? 'Generálás...' : 'Koncepciók generálása'}
        </button>
      </div>

      {error && (
        <div className="card mb-6" style={{ background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.2)' }}>
          <p className="text-sm" style={{ color: '#EF4444' }}>{error}</p>
        </div>
      )}

      {concepts && (
        <div className="space-y-3">
          {concepts.map((c, i) => (
            <div key={i} className="card-hover">
              <div className="flex items-start justify-between gap-3 mb-3">
                <h3 className="font-medium text-sm flex-1" style={{ color: '#F8FAFC' }}>{c.concept_label}</h3>
                <button
                  onClick={() => saveConcept(c, i)}
                  disabled={savedConcepts.has(i)}
                  className="text-xs px-3 py-1.5 rounded-lg whitespace-nowrap flex-shrink-0"
                  style={{ background: savedConcepts.has(i) ? 'rgba(34,197,94,0.1)' : 'rgba(59,130,246,0.1)', border: `1px solid ${savedConcepts.has(i) ? 'rgba(34,197,94,0.3)' : 'rgba(59,130,246,0.3)'}`, color: savedConcepts.has(i) ? '#22C55E' : '#3B82F6' }}
                >
                  {savedConcepts.has(i) ? '✓ Mentve' : '📌 Mentés'}
                </button>
              </div>

              <p className="text-xs mb-2" style={{ color: '#CBD5E1' }}>{c.visual_description}</p>

              <div className="rounded-lg px-3 py-2 mb-2" style={{ background: '#121826' }}>
                <p className="text-xs mb-1" style={{ color: '#94A3B8' }}>Thumbnail szöveg</p>
                <p className="text-sm font-bold" style={{ color: '#F8FAFC' }}>{c.thumbnail_text}</p>
                {!c.text_check.readable_at_small_size && (
                  <p className="text-xs mt-1" style={{ color: '#F59E0B' }}>⚠️ Lehet, hogy túl hosszú kis méretben ({c.text_check.word_count} szó)</p>
                )}
              </div>

              <p className="text-xs mb-1" style={{ color: '#94A3B8' }}><b>Kompozíció:</b> {c.composition_note}</p>
              <p className="text-xs mb-3" style={{ color: '#94A3B8' }}><b>Érzelem/konfliktus:</b> {c.emotion_or_conflict}</p>

              <div className="flex gap-2 items-center">
                <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: '#121826', color: '#CBD5E1' }}>
                  Figyelemfelkeltés: {c.contrast_attention_score}/100
                </span>
                <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: '#121826', color: CLUTTER_LABELS[c.clutter_risk]?.color }}>
                  {CLUTTER_LABELS[c.clutter_risk]?.label}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {!concepts && !loading && (
        <div className="card text-center py-12">
          <p className="text-3xl mb-3">🖼️</p>
          <p style={{ color: '#CBD5E1' }}>Írd be a témát, és 3 különböző thumbnail-koncepciót kapsz.</p>
        </div>
      )}
    </div>
  )
}
