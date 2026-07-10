'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import CreditConfirmModal from '@/components/CreditConfirmModal'
import type { UsageCheckResult } from '@/lib/usage-protection'
import { scoreLabel, scoreLabelColor } from '@/lib/score-utils'

interface RelatedKeyword {
  keyword: string
  angle: string
  content_format_hint: string
}

interface KeywordResearchResult {
  seed_keyword: string
  seed_score: {
    total: number
    competition: number
    content_gap: number
    trend_momentum: number
    freshness: number
    confidence: string
    video_count: number
  } | null
  related_keywords: RelatedKeyword[]
  people_also_ask: string[]
  paid_result_id: string | null
}

const KEYWORD_RESEARCH_COST = 1

export default function KeywordResearchPage() {
  const [seed, setSeed] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<KeywordResearchResult | null>(null)
  const [creditCheck, setCreditCheck] = useState<UsageCheckResult | null>(null)
  const [savedKeywords, setSavedKeywords] = useState<Set<string>>(new Set())

  useEffect(() => {
    const saved = sessionStorage.getItem('willviral_keyword_research_state')
    if (saved) {
      try {
        const state = JSON.parse(saved)
        if (state.seed) setSeed(state.seed)
        if (state.result) setResult(state.result)
      } catch {}
    }
  }, [])

  async function runSearch(confirmed = false) {
    if (!seed.trim()) return
    setError(null)

    if (!confirmed) {
      try {
        const creditsRes = await fetch('/api/credits')
        const credits = await creditsRes.json()
        const balance = Number(credits.balance ?? 0)
        setCreditCheck({
          feature: 'Kulcsszókutató',
          cost: KEYWORD_RESEARCH_COST,
          currency: 'credit',
          currentCredits: balance,
          remainingCreditsAfterRun: balance - KEYWORD_RESEARCH_COST,
          requiresConfirmation: true,
          canRun: balance >= KEYWORD_RESEARCH_COST,
          reason: balance >= KEYWORD_RESEARCH_COST ? undefined : 'insufficient_credits',
          message: balance >= KEYWORD_RESEARCH_COST
            ? 'Valós YouTube- és webjelek alapján kulcsszó-javaslatokat és feldolgozási szögeket kapsz.'
            : 'Ehhez a kereséshez nincs elég kredited.',
        })
      } catch {
        setError('Kapcsolati hiba.')
      }
      return
    }

    setLoading(true)
    try {
      const res = await fetch('/api/keyword-research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seed_keyword: seed, platform: 'youtube', region: 'HU' }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Kulcsszókutatás sikertelen.')
        return
      }
      setResult(data)
      sessionStorage.setItem('willviral_keyword_research_state', JSON.stringify({ seed, result: data }))
    } catch {
      setError('Kapcsolati hiba.')
    } finally {
      setLoading(false)
    }
  }

  async function saveKeywordAsIdea(kw: RelatedKeyword) {
    setSavedKeywords(prev => new Set(prev).add(kw.keyword))
    await fetch('/api/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: kw.keyword,
        search_keyword: result?.seed_keyword,
        state: 'saved',
        platform: 'youtube',
        source_context: 'keyword_research',
      }),
    })
  }

  return (
    <div className="max-w-3xl mx-auto">
      {creditCheck && (
        <CreditConfirmModal
          check={creditCheck}
          onConfirm={() => { setCreditCheck(null); runSearch(true) }}
          onCancel={() => setCreditCheck(null)}
          loading={loading}
        />
      )}

      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-1" style={{ color: '#F8FAFC' }}>🔎 Kulcsszókutató</h1>
        <p className="text-sm" style={{ color: '#CBD5E1' }}>Valós YouTube- és Google-jelekből, nem találgatásból — konkrét, hosszabb kulcsszavak és feldolgozási szögek.</p>
      </div>

      <div className="card mb-6">
        <div className="flex gap-2">
          <input
            value={seed}
            onChange={e => setSeed(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && runSearch()}
            placeholder="pl. otthoni edzés, AI eszközök, egészséges reggeli..."
            className="flex-1 px-4 py-2.5 rounded-lg text-sm"
            style={{ background: '#121826', border: '1px solid rgba(255,255,255,0.08)', color: '#F8FAFC' }}
          />
          <button onClick={() => runSearch()} disabled={loading || !seed.trim()} className="btn-primary px-5">
            {loading ? 'Keresés...' : 'Kutatás indítása'}
          </button>
        </div>
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

      {!loading && result && (
        <div className="space-y-6">
          {result.seed_score && (
            <div className="card">
              <p className="text-xs mb-3" style={{ color: '#94A3B8' }}>ALAP KULCSSZÓ VALÓS ADATA</p>
              <h3 className="font-medium text-lg mb-3" style={{ color: '#F8FAFC' }}>"{result.seed_keyword}"</h3>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <span style={{ color: '#94A3B8' }}>Opportunity: </span>
                  <b style={{ color: scoreLabelColor(result.seed_score.total) }}>{result.seed_score.total} ({scoreLabel(result.seed_score.total)})</b>
                </div>
                <div>
                  <span style={{ color: '#94A3B8' }}>Verseny: </span>
                  <b style={{ color: '#F8FAFC' }}>{result.seed_score.competition}/100</b>
                </div>
                <div>
                  <span style={{ color: '#94A3B8' }}>Tartalmi rés: </span>
                  <b style={{ color: '#F8FAFC' }}>{result.seed_score.content_gap}/100</b>
                </div>
                <div>
                  <span style={{ color: '#94A3B8' }}>YouTube találat: </span>
                  <b style={{ color: '#F8FAFC' }}>{result.seed_score.video_count} ({result.seed_score.confidence})</b>
                </div>
              </div>
              <div className="flex gap-2 mt-4">
                <Link href={`/dashboard/viral-score?topic=${encodeURIComponent(result.seed_keyword)}`} className="text-xs px-3 py-1.5 rounded-lg" style={{ background: '#121826', border: '1px solid rgba(255,255,255,0.08)', color: '#CBD5E1' }}>
                  📈 Mélyebb validálás (Virális esély)
                </Link>
              </div>
            </div>
          )}

          {result.people_also_ask.length > 0 && (
            <div className="card">
              <p className="text-xs mb-3" style={{ color: '#94A3B8' }}>EMBEREK EZT IS KÉRDEZIK (valós Google-jel)</p>
              <ul className="space-y-1.5">
                {result.people_also_ask.map((q, i) => (
                  <li key={i} className="text-sm" style={{ color: '#CBD5E1' }}>• {q}</li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <p className="text-xs mb-3" style={{ color: '#94A3B8' }}>KAPCSOLÓDÓ TÉMA-JAVASLATOK ({result.related_keywords.length})</p>
            <div className="space-y-3">
              {result.related_keywords.map((kw, i) => (
                <div key={i} className="card-hover">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <h4 className="font-medium text-sm mb-1" style={{ color: '#F8FAFC' }}>{kw.keyword}</h4>
                      <p className="text-xs mb-2" style={{ color: '#CBD5E1' }}>{kw.angle}</p>
                      {kw.content_format_hint && (
                        <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(139,92,246,0.1)', color: '#A78BFA' }}>
                          {kw.content_format_hint}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-col gap-1.5 flex-shrink-0">
                      <button
                        onClick={() => saveKeywordAsIdea(kw)}
                        disabled={savedKeywords.has(kw.keyword)}
                        className="text-xs px-3 py-1.5 rounded-lg whitespace-nowrap"
                        style={{ background: savedKeywords.has(kw.keyword) ? 'rgba(34,197,94,0.1)' : 'rgba(59,130,246,0.1)', border: `1px solid ${savedKeywords.has(kw.keyword) ? 'rgba(34,197,94,0.3)' : 'rgba(59,130,246,0.3)'}`, color: savedKeywords.has(kw.keyword) ? '#22C55E' : '#3B82F6' }}
                      >
                        {savedKeywords.has(kw.keyword) ? '✓ Mentve' : '📌 Mentés'}
                      </button>
                      <Link href={`/dashboard/opportunities?niche=${encodeURIComponent(kw.keyword)}`} className="text-xs px-3 py-1.5 rounded-lg text-center whitespace-nowrap" style={{ background: '#121826', border: '1px solid rgba(255,255,255,0.08)', color: '#CBD5E1' }}>
                        🧭 Validálás
                      </Link>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {!loading && !result && !error && (
        <div className="card text-center py-12">
          <p className="text-3xl mb-3">🔎</p>
          <p style={{ color: '#CBD5E1' }}>Írj be egy kulcsszót, és valós YouTube/Google-jelek alapján kapsz konkrét témajavaslatokat.</p>
        </div>
      )}
    </div>
  )
}
