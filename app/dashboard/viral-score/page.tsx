'use client'

import { useState, useEffect, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import type { ViralScoreResult, VideoCardData } from '@/types'
import CreditConfirmModal from '@/components/CreditConfirmModal'
import type { UsageCheckResult } from '@/lib/usage-protection'
import { scoreLabel, scoreLabelColor } from '@/lib/score-utils'
import VideoCardActions from '@/components/VideoCardActions'
import LoadingScreen, { LOADING_STEPS } from '@/components/ui/LoadingScreen'

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return n.toString()
}

function ScoreRing({ score, verdict }: { score: number; verdict: string }) {
  const color = verdict === 'strong' ? '#10B981' : verdict === 'moderate' ? '#F59E0B' : '#F43F5E'
  const radius = 54
  const circumference = 2 * Math.PI * radius
  const strokeDashoffset = circumference - (score / 100) * circumference

  return (
    <div className="relative w-36 h-36 mx-auto">
      <svg className="w-full h-full -rotate-90" viewBox="0 0 140 140">
        <circle cx="70" cy="70" r={radius} fill="none" stroke="#121826" strokeWidth="10" />
        <circle
          cx="70" cy="70" r={radius}
          fill="none"
          stroke={color}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          style={{ transition: 'stroke-dashoffset 1s ease-out' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-bold text-text-primary">{score}</span>
        <span className="text-xs text-text-muted">/ 100</span>
        <span className="text-xs font-semibold mt-0.5" style={{ color: scoreLabelColor(score) }}>
          {scoreLabel(score)}
        </span>
      </div>
    </div>
  )
}

const verdictConfig = {
  strong: { label: 'Erős téma ✓', color: 'text-emerald', bg: 'bg-emerald/10', border: 'border-emerald/20' },
  moderate: { label: 'Közepes lehetőség', color: 'text-amber', bg: 'bg-amber/10', border: 'border-amber/20' },
  weak: { label: 'Gyenge piaci igény', color: 'text-rose', bg: 'bg-rose/10', border: 'border-rose/20' },
  avoid: { label: 'Nem ajánlott', color: 'text-rose', bg: 'bg-rose/10', border: 'border-rose/20' },
}

const confidenceLabel = {
  magas: 'Magas megbízhatóság (30+ videó)',
  közepes: 'Közepes megbízhatóság (10–29 videó)',
  alacsony: 'Alacsony megbízhatóság (5–9 videó)',
  nagyon_alacsony: 'Nagyon alacsony megbízhatóság (1–4 videó)',
}

export default function ViralScorePage() {
  const searchParams = useSearchParams()
  const initialTopic = searchParams.get('topic') || ''

  const [topic, setTopic] = useState(initialTopic)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<ViralScoreResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creditCheck, setCreditCheck] = useState<UsageCheckResult | null>(null)
  const pendingActionRef = useRef<(() => void) | null>(null)

  // Keresési előzmény visszaállítása böngésző vissza gombhoz
  useEffect(() => {
    if (initialTopic) {
      checkCreditsBeforeAction(1, 'Viral Score', () => runAnalysis(initialTopic))
      return
    }
    const saved = sessionStorage.getItem('willviral_viral_score_state')
    if (saved) {
      try {
        const state = JSON.parse(saved)
        if (state.topic) setTopic(state.topic)
        if (state.result) setResult(state.result)
      } catch {}
    }
  }, [])

  async function checkCreditsBeforeAction(cost: number, featureName: string, onConfirm: () => void) {
    try {
      const res = await fetch('/api/credits')
      const credits = await res.json()
      const balance = credits.balance ?? 0

      if (balance < cost) {
        setCreditCheck({
          feature: featureName,
          cost,
          currency: 'credit',
          currentCredits: Math.round(balance),
          remainingCreditsAfterRun: balance,
          requiresConfirmation: true,
          canRun: false,
          reason: 'insufficient_credits',
          message: `Nincs eleg kredited. ${cost} kredit szukseges, neked ${Math.round(balance)} van.`,
        })
        return
      }

      pendingActionRef.current = onConfirm
      setCreditCheck({
        feature: featureName,
        cost,
        currency: 'credit',
        currentCredits: Math.round(balance),
        remainingCreditsAfterRun: Math.round(balance - cost),
        requiresConfirmation: true,
        canRun: true,
        message: `Ez a muvelet ${cost} kreditbe kerul.`,
      })
    } catch {
      onConfirm()
    }
  }

  async function runAnalysis(t: string) {
    if (!t.trim()) return

    setLoading(true)
    setError(null)
    setResult(null)

    try {
      const res = await fetch('/api/viral-score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: t, platform: 'youtube', region: 'HU' }),
      })

      const data = await res.json()

      if (!res.ok) {
        setError(data.error || 'Hiba történt')
        return
      }

      setResult(data)

      // Mentés sessionStorage-ba — böngésző vissza gomb támogatás
      sessionStorage.setItem('willviral_viral_score_state', JSON.stringify({
        topic: t,
        result: data,
      }))
    } catch {
      setError('Kapcsolati hiba. Próbáld újra.')
    } finally {
      setLoading(false)
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    checkCreditsBeforeAction(1, 'Viral Score', () => runAnalysis(topic))
  }

  async function saveToMemory() {
    if (!result) return
    await fetch('/api/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: result.topic,
        state: 'saved',
        viral_score: result.score,
      }),
    })
    alert('Téma mentve a Creator Memory-ba!')
  }

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-text-primary mb-1">Viral Score</h1>
        <p className="text-text-secondary text-sm">Megéri ez a téma? Valós YouTube adatok alapján.</p>
      </div>

      {/* Input */}
      <div className="card mb-6">
        <form onSubmit={handleSubmit} className="flex gap-3">
          <input
            value={topic}
            onChange={e => setTopic(e.target.value)}
            placeholder="pl. AI eszközök kis vállalkozásoknak"
            className="input flex-1"
            disabled={loading}
          />
          <button type="submit" disabled={loading || !topic.trim()} className="btn-primary px-6 whitespace-nowrap">
            {loading ? 'Elemzés...' : 'Elemzés'}
          </button>
        </form>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-rose/10 border border-rose/20 rounded-xl px-5 py-4 text-rose text-sm mb-6">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="card">
          <LoadingScreen steps={LOADING_STEPS.viralScore} />
        </div>
      )}

      {/* Result */}
      {result && !loading && (
        <div className="space-y-4 animate-slide-up">
          {/* Score card */}
          <div className="card text-center">
            <ScoreRing score={result.score} verdict={result.verdict} />
            
            <div className="mt-4">
              {(() => {
                const cfg = verdictConfig[result.verdict]
                return (
                  <span className={`inline-block px-3 py-1 rounded-full text-sm font-medium border ${cfg.bg} ${cfg.color} ${cfg.border}`}>
                    {cfg.label}
                  </span>
                )
              })()}
            </div>

            <p className="text-text-secondary text-sm mt-3 max-w-sm mx-auto leading-relaxed">
              {result.recommendation}
            </p>

            {/* Confidence */}
            <p className="text-text-muted text-xs mt-3">
              {confidenceLabel[result.confidence]}
            </p>
          </div>

          {/* Breakdown */}
          <div className="card">
            <p className="section-label mb-4">Részletes adatok</p>
            <div className="grid grid-cols-2 gap-4">
              {[
                { label: 'Átlag megtekintés', value: result.breakdown.avg_views.toLocaleString() },
                { label: 'Átlag like', value: result.breakdown.avg_likes.toLocaleString() },
                { label: 'Átlag komment', value: result.breakdown.avg_comments.toLocaleString() },
                { label: 'Vizsgált videók', value: result.video_count },
              ].map(item => (
                <div key={item.label} className="bg-surface-2 rounded-lg p-3">
                  <p className="text-text-muted text-xs mb-1">{item.label}</p>
                  <p className="text-text-primary font-semibold">{item.value}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Forrás videók */}
          {result.videos && result.videos.length > 0 && (
            <div className="card">
              <p className="section-label mb-4">Forrás videók ({result.videos.length})</p>
              <div className="space-y-2">
                {result.videos.map(video => {
                  const cardData: VideoCardData = {
                    video_id: video.video_id,
                    title: video.title,
                    channel_title: video.channel_title,
                    thumbnail_url: video.thumbnail_url,
                    video_url: video.url,
                    published_at: video.published_at,
                    views: video.view_count,
                    likes: video.like_count,
                    comments: video.comment_count,
                    source_context: 'viral_score',
                  }
                  return (
                    <div key={video.video_id} className="flex flex-col gap-1.5 rounded-lg p-2"
                      style={{ background: '#0A0E18', border: '1px solid rgba(255,255,255,0.06)' }}>
                      <a href={video.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 min-w-0">
                        <div className="w-16 h-10 rounded overflow-hidden flex-shrink-0 bg-surface-2">
                          {video.thumbnail_url && <img src={video.thumbnail_url} alt="" className="w-full h-full object-cover" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium line-clamp-1" style={{ color: '#F8FAFC' }}>{video.title}</p>
                          <p className="text-xs" style={{ color: '#94A3B8' }}>{video.channel_title} · 👁 {formatNumber(video.view_count)}</p>
                        </div>
                      </a>
                      <VideoCardActions video={cardData} compact />
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3">
            <button onClick={saveToMemory} className="btn-secondary flex-1">
              📌 Mentés
            </button>
            <a
              href={`/dashboard/similar-videos?topic=${encodeURIComponent(result.topic)}`}
              className="btn-secondary flex-1 text-center"
            >
              🎬 Similar Videos →
            </a>
            <a
              href={`/dashboard/video-package?topic=${encodeURIComponent(result.topic)}`}
              className="btn-primary flex-1 text-center"
            >
              🎁 Videócsomag →
            </a>
          </div>
        </div>
      )}

      {creditCheck && (
        <CreditConfirmModal
          check={creditCheck}
          onConfirm={() => { const action = pendingActionRef.current; setCreditCheck(null); pendingActionRef.current = null; action?.() }}
          onCancel={() => { setCreditCheck(null); pendingActionRef.current = null }}
          loading={loading}
        />
      )}
    </div>
  )
}
