'use client'

import { useState, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import CreditConfirmModal from '@/components/CreditConfirmModal'
import type { UsageCheckResult } from '@/lib/usage-protection'
import LoadingScreen, { LOADING_STEPS } from '@/components/ui/LoadingScreen'
import PublishKitFrame from '@/components/publish-kit/PublishKitFrame'
import { AlertTriangle, Bookmark, Check, Gauge, Info, PenLine, Sparkles, WandSparkles } from 'lucide-react'
import { publishCreditMutationCompleted } from '@/lib/credit-balance-events'
import { useCreditBalance } from '@/components/credits/CreditBalanceContext'

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
  return (
    <div className="wv-publish-score">
      <span>{label}</span>
      <div><i style={{ width: `${value}%` }} /></div>
      <strong>{value}</strong>
    </div>
  )
}

export default function TitleStudioPage() {
  const { refreshCredits } = useCreditBalance()
  const searchParams = useSearchParams()
  const [topic, setTopic] = useState('')
  const [existingTitle, setExistingTitle] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [variations, setVariations] = useState<TitleVariation[] | null>(null)
  const [creditCheck, setCreditCheck] = useState<UsageCheckResult | null>(null)
  const [savedTitles, setSavedTitles] = useState<Set<string>>(new Set())
  const [acceptedTitle, setAcceptedTitle] = useState('')
  const [fromPaidResult, setFromPaidResult] = useState(false)
  const [paidResultId, setPaidResultId] = useState<string | null>(null)

  // Mentett eredmény visszaállítása: explicit paidResultId a linkből (pl. a
  // Command Center "Legutóbbi történeted" paneljéről), vagy — ennek hiányában —
  // a legutóbbi generálás a sessionStorage-ból. Egyik sem von kreditet.
  useEffect(() => {
    const paidResultId = searchParams.get('paidResultId')
    if (paidResultId) {
      loadPaidResult(paidResultId)
      return
    }
    const incomingTopic = searchParams.get('topic')
    const incomingTitle = searchParams.get('existingTitle')
    if (incomingTopic || incomingTitle) {
      if (incomingTopic) setTopic(incomingTopic)
      if (incomingTitle) setExistingTitle(incomingTitle)
      return
    }
    const saved = sessionStorage.getItem('willviral_title_studio_state')
    if (saved) {
      try {
        const state = JSON.parse(saved)
        if (state.topic) setTopic(state.topic)
        if (state.existingTitle) setExistingTitle(state.existingTitle)
        if (state.variations) setVariations(state.variations)
        if (state.paidResultId) setPaidResultId(state.paidResultId)
        if (state.acceptedTitle) setAcceptedTitle(state.acceptedTitle)
      } catch {}
    }
  }, [])

  async function loadPaidResult(id: string) {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/title-studio?paidResultId=${id}`)
      const data = await res.json()
      if (!res.ok || data.error) {
        setError(data.error || 'A mentett eredmény nem található.')
        return
      }
      setTopic(data.topic || '')
      setVariations(data.variations || null)
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
    setFromPaidResult(false)
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
      publishCreditMutationCompleted('/api/title-studio', data)
      setAcceptedTitle('')
      setTopic(data.topic || topic.trim())
      setPaidResultId(data.paid_result_id || null)
      sessionStorage.setItem('willviral_title_studio_state', JSON.stringify({
        topic: data.topic || topic.trim(), existingTitle, variations: data.variations, paidResultId: data.paid_result_id || null,
      }))
    } catch {
      setError('Kapcsolati hiba.')
    } finally {
      setLoading(false)
    }
  }

  async function saveTitle(title: string) {
    try {
      if (!paidResultId) throw new Error('A mentéshez hiányzik a fizetett eredmény azonosítója.')
      const response = await fetch('/api/title-studio', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, title, platform: 'youtube', paid_result_id: paidResultId }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'A cím mentése sikertelen.')
      setSavedTitles(prev => new Set(prev).add(title))
      setAcceptedTitle(title)
      try {
        const current = JSON.parse(sessionStorage.getItem('willviral_title_studio_state') || '{}')
        sessionStorage.setItem('willviral_title_studio_state', JSON.stringify({ ...current, acceptedTitle: title }))
      } catch {}
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'A cím mentése sikertelen.')
    }
  }

  return (
    <PublishKitFrame
      active="title"
      title="A kattintás előtti első ígéret."
      description="Öt eltérő címirány egyetlen témára. Nem automatikus győztest választunk: megmutatjuk, melyik megközelítés mit erősít és mit kockáztat."
      topic={topic}
      existingTitle={acceptedTitle || existingTitle}
    >
      {creditCheck && <CreditConfirmModal check={creditCheck} onConfirm={confirmGenerate} onCancel={() => setCreditCheck(null)} loading={loading} />}

      <section className="wv-publish-composer" aria-labelledby="wv-title-brief-title">
        <header>
          <div><span>01</span><div><small>Címbrief</small><h2 id="wv-title-brief-title">Rögzítsd a nézői ígéretet.</h2></div></div>
          <aside><PenLine aria-hidden="true" /><span><small>Generálás ára</small><strong>1 kredit</strong></span></aside>
        </header>
        <div className="wv-publish-fields">
          <label className="is-primary"><span>Videó témája</span><input value={topic} onChange={event => setTopic(event.target.value)} placeholder="Miről szól a videó?" maxLength={300} /><small>Ez tartja egy irányban mind az öt változatot.</small></label>
          <label><span>Meglévő címötlet <i>opcionális</i></span><input value={existingTitle} onChange={event => setExistingTitle(event.target.value)} placeholder="Ha van kiinduló címed, innen finomítjuk" maxLength={100} /><small>Nem kötelező; valódi alternatívákat kapsz mellé.</small></label>
        </div>
        <footer>
          <div><Info aria-hidden="true" /><span><strong>Csomagolási értékelés</strong><small>Nem mért CTR és nem kattintás-előrejelzés.</small></span></div>
          <button type="button" onClick={runGenerate} disabled={loading || !topic.trim()}>{loading ? <><i />Dolgozunk a címeken</> : <><WandSparkles aria-hidden="true" />5 címirány készítése<span>1 kredit</span></>}</button>
        </footer>
      </section>

      {error && <div className="wv-publish-alert is-error" role="alert"><AlertTriangle aria-hidden="true" /><span><strong>A címcsomag most nem készíthető el.</strong>{error}</span></div>}
      {loading && <div className="wv-publish-loading"><LoadingScreen steps={LOADING_STEPS.titleStudio} /></div>}
      {fromPaidResult && variations && <div className="wv-publish-alert is-saved"><Check aria-hidden="true" /><span><strong>Mentett címcsomag betöltve.</strong>Nem vontunk le új kreditet.</span></div>}

      {variations && (
        <section className="wv-publish-results" aria-labelledby="wv-title-results-title">
          <header className="wv-publish-results-head"><div><span>02</span><div><small>Öt különböző döntés</small><h2 id="wv-title-results-title">Címirányok összehasonlítása</h2></div></div><span><Gauge aria-hidden="true" />AI-értékelés + objektív jelek</span></header>
          <div className="wv-title-grid">
            {variations.map((variation, index) => {
              const saved = savedTitles.has(variation.title)
              return (
                <article key={variation.title} className={`${index === 0 ? 'is-lead ' : ''}${acceptedTitle === variation.title ? 'is-accepted' : ''}`.trim()}>
                  <header><span>{String(index + 1).padStart(2, '0')}</span><div><small>{index === 0 ? 'Nyitó irány' : 'Alternatív irány'}</small><h3>{variation.title}</h3></div><button type="button" onClick={() => saveTitle(variation.title)} disabled={saved}>{saved ? <Check aria-hidden="true" /> : <Bookmark aria-hidden="true" />}<span>{saved ? 'Kiválasztva' : 'Kiválasztás'}</span></button></header>
                  <div className="wv-title-score-grid">
                    <ScoreBar label="Kíváncsiság" value={variation.curiosity_score} />
                    <ScoreBar label="Világosság" value={variation.clarity_score} />
                    <ScoreBar label="AI-vonzerő" value={variation.clickability_score} />
                    <ScoreBar label="Túlígérés kockázata" value={variation.risk_score} />
                  </div>
                  <p>{variation.reasoning}</p>
                  <footer>
                    <span>{variation.heuristics.length} karakter</span>
                    {variation.heuristics.length_flag === 'too_long' && <span className="is-risk">Túl hosszú</span>}
                    {variation.heuristics.length_flag === 'too_short' && <span className="is-warn">Túl rövid</span>}
                    {variation.heuristics.has_number && <span>Számot használ</span>}
                    {variation.heuristics.has_question && <span>Kérdésforma</span>}
                    {variation.heuristics.excessive_caps && <span className="is-risk">Túl sok nagybetű</span>}
                    {variation.heuristics.clickbait_symbol_overuse && <span className="is-risk">Túl sok írásjel</span>}
                  </footer>
                </article>
              )
            })}
          </div>
        </section>
      )}

      {!variations && !loading && <section className="wv-publish-empty"><span><Sparkles aria-hidden="true" /></span><small>A brief után</small><h2>Öt cím. Öt eltérő belépési pont.</h2><p>A rendszer külön mutatja a kíváncsiságot, a világosságot, a csomagolási vonzerőt és a túlígérés kockázatát.</p></section>}
    </PublishKitFrame>
  )
}
