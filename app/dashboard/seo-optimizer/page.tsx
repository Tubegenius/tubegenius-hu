'use client'

import { useState, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import CreditConfirmModal from '@/components/CreditConfirmModal'
import type { UsageCheckResult } from '@/lib/usage-protection'
import LoadingScreen, { LOADING_STEPS } from '@/components/ui/LoadingScreen'
import PublishKitFrame from '@/components/publish-kit/PublishKitFrame'
import { AlertTriangle, Check, CheckCircle2, Clipboard, Copy, FileText, Hash, Info, ListVideo, MessageCircle, RefreshCw, Search, Send, WandSparkles } from 'lucide-react'
import { publishCreditMutationCompleted } from '@/lib/credit-balance-events'
import { useCreditBalance } from '@/components/credits/CreditBalanceContext'

interface SeoPackage {
  seo_title: string
  description: string
  tags: string[]
  hashtags: string[]
  chapters: Array<{ timestamp: string; label: string }>
  playlist_suggestion: string
  pinned_comment: string
  end_screen_cta: string
}

interface SeoResult {
  topic: string
  seo_package: SeoPackage
  seo_score: number
  score_disclaimer?: string
  checklist: Array<{ label: string; done: boolean }>
  from_paid_result?: boolean
  cache_status?: 'fresh' | 'stale_saved'
  last_analyzed_at?: string
  paid_result_id?: string | null
}

const SEO_OPTIMIZER_COST = 1

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="wv-seo-copy-field">
      <header><span>{label}</span><button type="button" className={copied ? 'is-copied' : ''} onClick={() => { navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{copied ? 'Másolva' : 'Másolás'}</button></header>
      <p>{value}</p>
    </div>
  )
}

const SEO_STATE_KEY = 'willviral_seo_optimizer_state'

export default function SeoOptimizerPage() {
  const { refreshCredits } = useCreditBalance()
  const searchParams = useSearchParams()
  const paidResultId = searchParams.get('paidResultId') || ''

  const [topic, setTopic] = useState('')
  const [existingTitle, setExistingTitle] = useState('')
  const [keywords, setKeywords] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<SeoResult | null>(null)
  const [creditCheck, setCreditCheck] = useState<UsageCheckResult | null>(null)
  const [pendingForceRefresh, setPendingForceRefresh] = useState(false)

  // Mentett eredmény visszaállítása: explicit paidResultId a linkből, vagy
  // — ennek hiányában — a legutóbbi keresés a sessionStorage-ból (böngésző
  // vissza gomb / refresh támogatás). Egyik sem von kreditet.
  useEffect(() => {
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
    try {
      const saved = sessionStorage.getItem(SEO_STATE_KEY)
      if (saved) {
        const state = JSON.parse(saved)
        if (state.topic) setTopic(state.topic)
        if (state.existingTitle) setExistingTitle(state.existingTitle)
        if (state.keywords) setKeywords(state.keywords)
        if (state.result) setResult(state.result)
      }
    } catch {}
  }, [])

  async function loadPaidResult(id: string) {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/seo-optimizer?paidResultId=${id}`)
      const data = await res.json()
      if (!res.ok || data.error) {
        setError(data.error || 'A mentett SEO-csomag nem található.')
        return
      }
      setTopic(data.topic || '')
      setResult(data)
      publishCreditMutationCompleted('/api/seo-optimizer', data)
      persistState(data.topic || '', existingTitle, keywords, data)
    } catch {
      setError('Hiba a mentett SEO-csomag betöltésekor.')
    } finally {
      setLoading(false)
    }
  }

  function persistState(t: string, et: string, kw: string, r: SeoResult) {
    try {
      sessionStorage.setItem(SEO_STATE_KEY, JSON.stringify({ topic: t, existingTitle: et, keywords: kw, result: r }))
    } catch {}
  }

  async function runGenerate(forceRefresh = false) {
    if (!topic.trim()) return
    setError(null)
    try {
      const credits = await refreshCredits()
      if (!credits) throw new Error('credit_balance_unavailable')
      const balance = credits.balance
      setPendingForceRefresh(forceRefresh)
      setCreditCheck({
        feature: 'SEO / Upload Optimizer',
        cost: SEO_OPTIMIZER_COST,
        currency: 'credit',
        currentCredits: balance,
        remainingCreditsAfterRun: balance - SEO_OPTIMIZER_COST,
        requiresConfirmation: true,
        canRun: balance >= SEO_OPTIMIZER_COST,
        reason: balance >= SEO_OPTIMIZER_COST ? undefined : 'insufficient_credits',
        message: balance >= SEO_OPTIMIZER_COST
          ? (forceRefresh ? 'Új, friss SEO-csomagot generálunk — ez új kreditet használ.' : 'Teljes feltöltési csomag: cím, leírás, tagek, hashtagek, fejezetek, pinned comment, CTA. Ha korábban már lekérted ugyanezt, nem vonunk le új kreditet.')
          : 'Ehhez nincs elég kredited.',
      })
    } catch {
      setError('Kapcsolati hiba.')
    }
  }

  async function confirmGenerate() {
    setCreditCheck(null)
    setLoading(true)
    try {
      const res = await fetch('/api/seo-optimizer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, existing_title: existingTitle || undefined, keywords, platform: 'youtube', region: 'HU', force_refresh: pendingForceRefresh }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Generálás sikertelen.')
        return
      }
      setResult(data)
      persistState(topic, existingTitle, keywords, data)
    } catch {
      setError('Kapcsolati hiba.')
    } finally {
      setLoading(false)
      setPendingForceRefresh(false)
    }
  }

  return (
    <PublishKitFrame
      active="seo"
      title="Minden, ami a publikálás pillanatához kell."
      description="A videó ígéretéből rendezett feltöltési rendszer: kereshető cím, leírás, tagek, fejezetvázlat és nézői továbbvezetés egy helyen."
      topic={topic}
      existingTitle={existingTitle}
    >
      {creditCheck && <CreditConfirmModal check={creditCheck} onConfirm={confirmGenerate} onCancel={() => { setCreditCheck(null); setPendingForceRefresh(false) }} loading={loading} />}

      <section className="wv-publish-composer" aria-labelledby="wv-seo-brief-title">
        <header>
          <div><span>03</span><div><small>Publikálási brief</small><h2 id="wv-seo-brief-title">Rendezd feltölthető csomaggá.</h2></div></div>
          <aside><Search aria-hidden="true" /><span><small>Generálás ára</small><strong>1 kredit</strong></span></aside>
        </header>
        <div className="wv-publish-fields is-seo">
          <label className="is-primary"><span>Videó témája</span><input value={topic} onChange={event => setTopic(event.target.value)} placeholder="Miről szól a videó?" /><small>Ez marad a teljes feltöltési csomag központi témája.</small></label>
          <label><span>Elfogadott cím <i>opcionális</i></span><input value={existingTitle} onChange={event => setExistingTitle(event.target.value)} placeholder="A kiválasztott cím" /><small>Ha megadod, finomítjuk, nem cseréljük le önkényesen.</small></label>
          <label><span>Kulcsszavak <i>opcionális</i></span><input value={keywords} onChange={event => setKeywords(event.target.value)} placeholder="Vesszővel elválasztva" /><small>A téma nélkülük is használható elsődleges kifejezésként.</small></label>
        </div>
        <footer>
          <div><Info aria-hidden="true" /><span><strong>Teljes feltöltési rendszer</strong><small>Cím, leírás, tagek, fejezetek, komment és CTA.</small></span></div>
          <button type="button" onClick={() => runGenerate()} disabled={loading || !topic.trim()}>{loading ? <><i />Épül a csomag</> : <><WandSparkles aria-hidden="true" />Publish Kit elkészítése<span>1 kredit</span></>}</button>
        </footer>
      </section>

      {error && <div className="wv-publish-alert is-error" role="alert"><AlertTriangle aria-hidden="true" /><span><strong>A feltöltési csomag most nem készíthető el.</strong>{error}</span></div>}
      {loading && <div className="wv-publish-loading"><LoadingScreen steps={LOADING_STEPS.seoOptimizer} /></div>}

      {result && (
        <section className="wv-publish-results" aria-labelledby="wv-seo-results-title">
          {result.from_paid_result && <div className="wv-publish-alert is-saved"><Check aria-hidden="true" /><span><strong>{result.cache_status === 'fresh' ? 'Friss mentett csomag betöltve.' : 'Korábbi mentett csomag betöltve.'}</strong>Nem vontunk le új kreditet.{result.last_analyzed_at && ` Utolsó generálás: ${new Date(result.last_analyzed_at).toLocaleDateString('hu-HU')}.`}</span></div>}
          <header className="wv-publish-results-head"><div><span>04</span><div><small>Publikálásra rendezve</small><h2 id="wv-seo-results-title">A teljes feltöltési dosszié</h2></div></div><span><Send aria-hidden="true" />YouTube csomag</span></header>

          <div className="wv-seo-readiness" data-score={result.seo_score >= 70 ? 'high' : result.seo_score >= 40 ? 'medium' : 'low'}>
            <div className="wv-seo-score-orbit"><span><strong>{result.seo_score}</strong><small>/ 100</small></span></div>
            <div><span className="wv-eyebrow">Feltöltési metaadat-score</span><h3>{result.seo_score >= 70 ? 'A csomag szerkezetileg készen áll.' : result.seo_score >= 40 ? 'A csomag még finomítható.' : 'Néhány alapjel még hiányzik.'}</h3><p>{result.score_disclaimer || 'Heurisztikus ellenőrzőpont, nem keresési helyezés- vagy nézettség-előrejelzés.'}</p></div>
            <div className="wv-seo-checklist">{result.checklist.map((item, index) => <div key={`${item.label}-${index}`} className={item.done ? 'is-done' : ''}>{item.done ? <CheckCircle2 aria-hidden="true" /> : <i aria-hidden="true" />}<span>{item.label}</span></div>)}</div>
            {result.from_paid_result && <button type="button" onClick={() => runGenerate(true)} disabled={loading} title="A frissítés új generálást indít, ezért kreditet használ."><RefreshCw aria-hidden="true" />Eredmény frissítése<small>1 kredit</small></button>}
          </div>

          <div className="wv-seo-grid">
            <article className="is-wide"><header><FileText aria-hidden="true" /><div><small>Alap metaadat</small><h3>Cím és leírás</h3></div></header><CopyField label="SEO cím" value={result.seo_package.seo_title} /><CopyField label="Leírás" value={result.seo_package.description} /></article>
            <article><header><Hash aria-hidden="true" /><div><small>Felfedezhetőség</small><h3>Tagek és hashtagek</h3></div></header><CopyField label="Tagek" value={(result.seo_package.tags || []).join(', ')} /><CopyField label="Hashtagek" value={(result.seo_package.hashtags || []).join(' ')} /></article>
            <article><header><ListVideo aria-hidden="true" /><div><small>Nézői tájékozódás</small><h3>Fejezetvázlat</h3></div></header><p className="wv-seo-note">Az időbélyegeket a készre vágott videó alapján kell hozzáadni.</p><ol className="wv-seo-chapters">{(result.seo_package.chapters || []).map((chapter, index) => <li key={`${chapter.label}-${index}`}><span>{String(index + 1).padStart(2, '0')}</span>{chapter.label}</li>)}</ol></article>
            <article className="is-wide"><header><MessageCircle aria-hidden="true" /><div><small>Nézői továbbvezetés</small><h3>Kapcsolódás és következő lépés</h3></div></header><div className="wv-seo-distribution"><CopyField label="Playlist javaslat" value={result.seo_package.playlist_suggestion} /><CopyField label="Kitűzhető komment" value={result.seo_package.pinned_comment} /><CopyField label="Végképernyő CTA" value={result.seo_package.end_screen_cta} /></div></article>
          </div>
        </section>
      )}

      {!result && !loading && <section className="wv-publish-empty"><span><Clipboard aria-hidden="true" /></span><small>A brief után</small><h2>Egy rendezett csomag, nem szétszórt szövegmezők.</h2><p>A cím, a leírás, a keresési jelek és a nézői továbbvezetés ugyanabban a publikálási dossziéban jelenik meg.</p></section>}
    </PublishKitFrame>
  )
}
