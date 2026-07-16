'use client'

import { useState, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import CreditConfirmModal from '@/components/CreditConfirmModal'
import type { UsageCheckResult } from '@/lib/usage-protection'
import LoadingScreen, { LOADING_STEPS } from '@/components/ui/LoadingScreen'

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
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1">
        <p className="text-xs" style={{ color: '#94A3B8' }}>{label}</p>
        <button
          onClick={() => { navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
          className="text-xs px-2 py-0.5 rounded"
          style={{ background: '#121826', color: copied ? '#22C55E' : '#94A3B8' }}
        >
          {copied ? '✓ Másolva' : '📋 Másolás'}
        </button>
      </div>
      <p className="text-sm whitespace-pre-wrap" style={{ color: '#F8FAFC' }}>{value}</p>
    </div>
  )
}

const SEO_STATE_KEY = 'willviral_seo_optimizer_state'

export default function SeoOptimizerPage() {
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
      const creditsRes = await fetch('/api/credits')
      const credits = await creditsRes.json()
      const balance = Number(credits.balance ?? 0)
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
    <div className="max-w-3xl mx-auto">
      {creditCheck && (
        <CreditConfirmModal check={creditCheck} onConfirm={confirmGenerate} onCancel={() => { setCreditCheck(null); setPendingForceRefresh(false) }} loading={loading} />
      )}

      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-1" style={{ color: '#F8FAFC' }}>📋 SEO / Feltöltés-optimalizáló</h1>
        <p className="text-sm" style={{ color: '#CBD5E1' }}>Teljes feltöltési csomag egy menetben: cím, leírás, tagek, hashtagek, fejezetek, komment, CTA.</p>
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
          placeholder="Meglévő cím (opcionális)"
          className="w-full px-4 py-2.5 rounded-lg text-sm"
          style={{ background: '#121826', border: '1px solid rgba(255,255,255,0.08)', color: '#F8FAFC' }}
        />
        <input
          value={keywords}
          onChange={e => setKeywords(e.target.value)}
          placeholder="Kulcsszavak vesszővel elválasztva (opcionális)"
          className="w-full px-4 py-2.5 rounded-lg text-sm"
          style={{ background: '#121826', border: '1px solid rgba(255,255,255,0.08)', color: '#F8FAFC' }}
        />
        <button onClick={() => runGenerate()} disabled={loading || !topic.trim()} className="btn-primary w-full">
          {loading ? 'Generálás...' : 'SEO csomag generálása'}
        </button>
      </div>

      {error && (
        <div className="card mb-6" style={{ background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.2)' }}>
          <p className="text-sm" style={{ color: '#EF4444' }}>{error}</p>
        </div>
      )}

      {loading && (
        <div className="card">
          <LoadingScreen steps={LOADING_STEPS.seoOptimizer} />
        </div>
      )}

      {result && (
        <div className="space-y-4">
          {result.from_paid_result && (
            <div className="rounded-xl px-4 py-3 flex items-center justify-between gap-3 flex-wrap"
              style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)' }}>
              <div>
                <p className="text-sm font-medium" style={{ color: '#93C5FD' }}>
                  {result.cache_status === 'fresh' ? 'Friss mentett eredmény betöltve' : 'Korábbi mentett eredmény betöltve'}
                </p>
                <p className="text-xs mt-0.5" style={{ color: '#94A3B8' }}>
                  Nem vontunk le új kreditet.
                  {result.last_analyzed_at && ` Utolsó generálás: ${new Date(result.last_analyzed_at).toLocaleDateString('hu-HU')}.`}
                </p>
              </div>
              <button onClick={() => runGenerate(true)} disabled={loading}
                className="text-xs px-3 py-2 rounded-lg font-semibold flex-shrink-0"
                style={{ background: 'rgba(255,255,255,0.06)', color: '#F8FAFC' }}
                title="A frissítés új generálást indít, ezért kreditet használ.">
                Eredmény frissítése
              </button>
            </div>
          )}
          <div className="card">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs" style={{ color: '#94A3B8' }}>FELTÖLTÉSI METAADAT-SCORE</p>
              <span className="text-2xl font-bold" style={{ color: result.seo_score >= 70 ? '#22C55E' : result.seo_score >= 40 ? '#F59E0B' : '#EF4444' }}>{result.seo_score}/100</span>
            </div>
            <p className="text-xs mb-3" style={{ color: '#64748B' }}>{result.score_disclaimer || 'Heurisztikus ellenőrzőpont, nem keresési helyezés- vagy nézettség-előrejelzés.'}</p>
            <div className="space-y-1.5">
              {result.checklist.map((item, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <span style={{ color: item.done ? '#22C55E' : '#94A3B8' }}>{item.done ? '✓' : '○'}</span>
                  <span style={{ color: item.done ? '#F8FAFC' : '#94A3B8' }}>{item.label}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <CopyField label="SEO cím" value={result.seo_package.seo_title} />
            <CopyField label="Leírás" value={result.seo_package.description} />
            <CopyField label="Tagek" value={(result.seo_package.tags || []).join(', ')} />
            <CopyField label="Hashtagek" value={(result.seo_package.hashtags || []).join(' ')} />
          </div>

          <div className="card">
            <p className="text-xs mb-1" style={{ color: '#94A3B8' }}>FEJEZETVÁZLAT</p>
            <p className="text-xs mb-2" style={{ color: '#64748B' }}>Az időbélyegeket a készre vágott videó alapján kell hozzáadni.</p>
            {(result.seo_package.chapters || []).map((c, i) => (
              <p key={i} className="text-sm mb-1" style={{ color: '#F8FAFC' }}>{c.label}</p>
            ))}
          </div>

          <div className="card">
            <CopyField label="Playlist javaslat" value={result.seo_package.playlist_suggestion} />
            <CopyField label="Kitűzhető komment" value={result.seo_package.pinned_comment} />
            <CopyField label="Végképernyő CTA" value={result.seo_package.end_screen_cta} />
          </div>
        </div>
      )}

      {!result && !loading && (
        <div className="card text-center py-12">
          <p className="text-3xl mb-3">📋</p>
          <p style={{ color: '#CBD5E1' }}>Írd be a témát, és teljes feltöltési csomagot kapsz.</p>
        </div>
      )}
    </div>
  )
}
