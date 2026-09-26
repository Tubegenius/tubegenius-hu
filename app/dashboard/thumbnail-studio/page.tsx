'use client'

import { useState, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import CreditConfirmModal from '@/components/CreditConfirmModal'
import type { UsageCheckResult } from '@/lib/usage-protection'
import LoadingScreen, { LOADING_STEPS } from '@/components/ui/LoadingScreen'
import PublishKitFrame from '@/components/publish-kit/PublishKitFrame'
import { AlertTriangle, Bookmark, Check, Eye, Image, Info, Layers3, Sparkles, WandSparkles } from 'lucide-react'
import { publishCreditMutationCompleted } from '@/lib/credit-balance-events'
import { useCreditBalance } from '@/components/credits/CreditBalanceContext'

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
  const { refreshCredits } = useCreditBalance()
  const searchParams = useSearchParams()
  const inheritedTitle = searchParams.get('existingTitle') || ''
  const [topic, setTopic] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [concepts, setConcepts] = useState<ThumbnailConcept[] | null>(null)
  const [creditCheck, setCreditCheck] = useState<UsageCheckResult | null>(null)
  const [savedConcepts, setSavedConcepts] = useState<Set<number>>(new Set())
  const [fromPaidResult, setFromPaidResult] = useState(false)
  const [paidResultId, setPaidResultId] = useState<string | null>(null)

  // Mentett eredmény visszaállítása: explicit paidResultId a linkből (pl. a
  // Command Center "Legutóbbi történeted" paneljéről), vagy a sessionStorage-ból.
  useEffect(() => {
    const paidResultId = searchParams.get('paidResultId')
    if (paidResultId) {
      loadPaidResult(paidResultId)
      return
    }
    const incomingTopic = searchParams.get('topic')
    if (incomingTopic) {
      setTopic(incomingTopic)
      return
    }
    const saved = sessionStorage.getItem('willviral_thumbnail_studio_state')
    if (saved) {
      try {
        const state = JSON.parse(saved)
        if (state.topic) setTopic(state.topic)
        if (state.concepts) setConcepts(state.concepts)
        if (state.paidResultId) setPaidResultId(state.paidResultId)
      } catch {}
    }
  }, [])

  async function loadPaidResult(id: string) {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/thumbnail-studio?paidResultId=${id}`)
      const data = await res.json()
      if (!res.ok || data.error) {
        setError(data.error || 'A mentett eredmény nem található.')
        return
      }
      setTopic(data.topic || '')
      setConcepts(data.concepts || null)
      setPaidResultId(data.paid_result_id || id)
      setFromPaidResult(true)
    } catch {
      setError('Hiba a mentett eredmény betöltésekor.')
    } finally {
      setLoading(false)
    }
  }

  async function runGenerate() {
    if (!topic.trim()) return
    setError(null)
    try {
      const credits = await refreshCredits()
      if (!credits) throw new Error('credit_balance_unavailable')
      const balance = credits.balance
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
    setFromPaidResult(false)
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
      publishCreditMutationCompleted('/api/thumbnail-studio', data)
      setTopic(data.topic || topic.trim())
      setPaidResultId(data.paid_result_id || null)
      sessionStorage.setItem('willviral_thumbnail_studio_state', JSON.stringify({ topic: data.topic || topic.trim(), concepts: data.concepts, paidResultId: data.paid_result_id || null }))
    } catch {
      setError('Kapcsolati hiba.')
    } finally {
      setLoading(false)
    }
  }

  async function saveConcept(concept: ThumbnailConcept, index: number) {
    try {
      if (!paidResultId) throw new Error('A mentéshez hiányzik a fizetett eredmény azonosítója.')
      const response = await fetch('/api/thumbnail-studio', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, concept, platform: 'youtube', paid_result_id: paidResultId }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'A koncepció mentése sikertelen.')
      setSavedConcepts(prev => new Set(prev).add(index))
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'A koncepció mentése sikertelen.')
    }
  }

  return (
    <PublishKitFrame
      active="thumbnail"
      title="A vizuális ígéret, még a gyártás előtt."
      description="Három valóban eltérő thumbnail-koncepció, hogy a kép ne díszítse, hanem azonnal érthetővé tegye a videó konfliktusát."
      topic={topic}
      existingTitle={inheritedTitle}
    >
      {creditCheck && <CreditConfirmModal check={creditCheck} onConfirm={confirmGenerate} onCancel={() => setCreditCheck(null)} loading={loading} />}

      <section className="wv-publish-composer" aria-labelledby="wv-thumbnail-brief-title">
        <header>
          <div><span>02</span><div><small>Vizuális brief</small><h2 id="wv-thumbnail-brief-title">Adj egyetlen tiszta fókuszt.</h2></div></div>
          <aside><Image aria-hidden="true" /><span><small>Generálás ára</small><strong>1 kredit</strong></span></aside>
        </header>
        <div className="wv-publish-fields is-single">
          <label className="is-primary"><span>Videó témája</span><input value={topic} onChange={event => setTopic(event.target.value)} onKeyDown={event => event.key === 'Enter' && runGenerate()} placeholder="Miről szól a videó?" maxLength={300} /><small>A koncepciók ugyanazt az ígéretet három eltérő vizuális nyelven bontják ki.</small></label>
        </div>
        <footer>
          <div><Info aria-hidden="true" /><span><strong>Koncepció, nem generált kép</strong><small>Kompozíciót, szöveget és érzelmi irányt kapsz.</small></span></div>
          <button type="button" onClick={runGenerate} disabled={loading || !topic.trim()}>{loading ? <><i />Épülnek a koncepciók</> : <><WandSparkles aria-hidden="true" />3 vizuális irány készítése<span>1 kredit</span></>}</button>
        </footer>
      </section>

      {error && <div className="wv-publish-alert is-error" role="alert"><AlertTriangle aria-hidden="true" /><span><strong>A vizuális csomag most nem készíthető el.</strong>{error}</span></div>}
      {loading && <div className="wv-publish-loading"><LoadingScreen steps={LOADING_STEPS.thumbnailStudio} /></div>}
      {fromPaidResult && concepts && <div className="wv-publish-alert is-saved"><Check aria-hidden="true" /><span><strong>Mentett koncepciócsomag betöltve.</strong>Nem vontunk le új kreditet.</span></div>}

      {concepts && (
        <section className="wv-publish-results" aria-labelledby="wv-thumbnail-results-title">
          <header className="wv-publish-results-head"><div><span>03</span><div><small>Vizuális irányok</small><h2 id="wv-thumbnail-results-title">Három különböző figyelemkapu</h2></div></div><span><Eye aria-hidden="true" />Kis méretre ellenőrizve</span></header>
          <div className="wv-thumbnail-grid">
            {concepts.map((concept, index) => {
              const saved = savedConcepts.has(index)
              return (
                <article key={`${concept.concept_label}-${index}`}>
                  <div className="wv-thumbnail-canvas" data-variant={String(index + 1)}>
                    <span aria-hidden="true"><i /><i /><i /></span>
                    <b>{concept.thumbnail_text}</b>
                    <small>{String.fromCharCode(65 + index)}</small>
                  </div>
                  <header><div><small>Koncepció {String.fromCharCode(65 + index)}</small><h3>{concept.concept_label}</h3></div><button type="button" onClick={() => saveConcept(concept, index)} disabled={saved}>{saved ? <Check aria-hidden="true" /> : <Bookmark aria-hidden="true" />}<span>{saved ? 'Mentve' : 'Mentés'}</span></button></header>
                  <p>{concept.visual_description}</p>
                  <dl><div><dt><Layers3 aria-hidden="true" />Kompozíció</dt><dd>{concept.composition_note}</dd></div><div><dt><Sparkles aria-hidden="true" />Érzelem vagy konfliktus</dt><dd>{concept.emotion_or_conflict}</dd></div></dl>
                  <footer>
                    <span><strong>{concept.contrast_attention_score}</strong><small>AI kontraszt / figyelem</small></span>
                    <span data-risk={concept.clutter_risk}><strong>{CLUTTER_LABELS[concept.clutter_risk]?.label}</strong><small>Zsúfoltsági kockázat</small></span>
                    <span><strong>{concept.text_check.word_count} szó</strong><small>{concept.text_check.readable_at_small_size ? 'Kis méretben olvasható' : 'Rövidítés javasolt'}</small></span>
                  </footer>
                </article>
              )
            })}
          </div>
        </section>
      )}

      {!concepts && !loading && <section className="wv-publish-empty"><span><Image aria-hidden="true" /></span><small>A brief után</small><h2>Nem három színváltozat. Három vizuális gondolat.</h2><p>Mindegyik irány külön képi fókuszt, rövid feliratot, kompozíciós tervet és érzelmi konfliktust kap.</p></section>}
    </PublishKitFrame>
  )
}
