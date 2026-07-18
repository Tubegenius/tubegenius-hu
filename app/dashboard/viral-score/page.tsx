'use client'

import { useState, useEffect, useRef } from 'react'
import { fetchWithDailySoftLimit } from '@/lib/client/fetch-with-daily-soft-limit'
import { useSearchParams } from 'next/navigation'
import type { ViralScoreResult, VideoCardData } from '@/types'
import CreditConfirmModal from '@/components/CreditConfirmModal'
import type { UsageCheckResult } from '@/lib/usage-protection'
import { scoreColor } from '@/lib/score-utils'
import VideoCardActions from '@/components/VideoCardActions'
import LoadingScreen, { LOADING_STEPS } from '@/components/ui/LoadingScreen'
import ViralScoreHero from '@/components/viral-score/ViralScoreHero'
import StatusIcon from '@/components/icons/StatusIcon'
import { Bookmark, PlayCircle, Package, Eye } from 'lucide-react'

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return n.toString()
}


export default function ViralScorePage() {
  const searchParams = useSearchParams()
  const initialTopic = searchParams.get('topic') || ''
  const paidResultId = searchParams.get('paidResultId') || ''

  const [topic, setTopic] = useState(initialTopic)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<ViralScoreResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creditCheck, setCreditCheck] = useState<UsageCheckResult | null>(null)
  const pendingActionRef = useRef<(() => void) | null>(null)

  // Keresési előzmény visszaállítása böngésző vissza gombhoz
  useEffect(() => {
    if (paidResultId) {
      loadPaidResult(paidResultId)
      return
    }
    if (initialTopic) {
      runAnalysisWithCreditCheck(initialTopic)
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

  async function loadPaidResult(id: string) {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/viral-score?paidResultId=${id}`)
      const data = await res.json()
      if (!res.ok || data.error) {
        setError(data.error || 'A Virális esély eredmény nem található.')
        return
      }
      setTopic(data.topic || initialTopic)
      setResult(data)
      sessionStorage.setItem('willviral_viral_score_state', JSON.stringify({ topic: data.topic || initialTopic, result: data }))
    } catch {
      setError('Hiba a mentett Virális esély betöltésekor.')
    } finally {
      setLoading(false)
    }
  }

  // Előbb megnézzük, van-e mentett (ingyenes) eredmény ehhez a témához —
  // ha van (akár friss, akár korábbi), azt mutatjuk kredit-igény és
  // megerősítő modal nélkül. Amit a user egyszer megvett, azt bármikor
  // újra meg tudja nyitni — a 6 órás "friss" ablak csak jelzés, nem
  // fizetési határ. Csak akkor kérünk megerősítést, ha tényleg új,
  // fizetős elemzés indulna.
  async function runAnalysisWithCreditCheck(t: string) {
    if (!t.trim()) return
    try {
      const cacheRes = await fetch('/api/viral-score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: t, platform: 'youtube', region: 'HU', cache_only: true, paidResultId: paidResultId || undefined }),
      })
      const cacheData = await cacheRes.json()
      if (cacheRes.ok && (cacheData.from_cache || cacheData.from_paid_result)) {
        setTopic(t)
        setResult(cacheData)
        sessionStorage.setItem('willviral_viral_score_state', JSON.stringify({ topic: t, result: cacheData }))
        return
      }
    } catch {}
    checkCreditsBeforeAction(1, 'Viral Score', () => runAnalysis(t))
  }

  // Explicit "Frissítés" — mindig új, fizetős elemzést indít (kredit-
  // megerősítéssel), a mentett eredményt figyelmen kívül hagyja.
  async function handleRefresh() {
    checkCreditsBeforeAction(1, 'Viral Score', () => runAnalysis(topic || result?.topic || '', true))
  }

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
          message: `Nincs elég kredited. ${cost} kredit szükséges, neked ${Math.round(balance)} van.`,
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
        message: `Ez a művelet ${cost} kreditbe kerül.`,
      })
    } catch {
      onConfirm()
    }
  }

  async function runAnalysis(t: string, forceRefresh = false) {
    if (!t.trim()) return

    setLoading(true)
    setError(null)
    setResult(null)

    try {
      const res = await fetchWithDailySoftLimit('/api/viral-score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: t, platform: 'youtube', region: 'HU', force_refresh: forceRefresh, paidResultId: paidResultId || undefined }),
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
    runAnalysisWithCreditCheck(topic)
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
    alert('Téma mentve a Tartalommemóriába!')
  }

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-text-primary mb-1">Virális esély</h1>
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
          {/* Mentett eredmény jelzés — csak ez dönt a UI-ban, a kreditlevonás
              sosem függ ettől, azt már a szerver eldöntötte */}
          {result.from_cache && (
            <div className="rounded-xl px-4 py-3 flex items-center justify-between gap-3 flex-wrap"
              style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)' }}>
              <div>
                <p className="text-sm font-medium flex items-center gap-1.5" style={{ color: '#93C5FD' }}>
                  <StatusIcon kind="saved" className="w-4 h-4" />
                  {result.cache_status === 'fresh' ? 'Friss mentett eredmény betöltve' : 'Korábbi mentett eredmény betöltve'}
                </p>
                <p className="text-xs mt-0.5" style={{ color: '#94A3B8' }}>
                  {result.cache_status === 'fresh'
                    ? 'Ezért nem vontunk le új kreditet.'
                    : 'Ezért nem vontunk le új kreditet. Frissítheted új adatokért.'}
                  {result.last_analyzed_at && ` Utolsó elemzés: ${new Date(result.last_analyzed_at).toLocaleDateString('hu-HU')}.`}
                </p>
              </div>
              <button onClick={handleRefresh} disabled={loading}
                className="text-xs px-3 py-2 rounded-lg font-semibold flex-shrink-0"
                style={{ background: 'rgba(255,255,255,0.06)', color: '#F8FAFC' }}
                title="A frissítés új keresést indít, ezért kreditet használ.">
                Eredmény frissítése
              </button>
            </div>
          )}

          <ViralScoreHero result={result} />

          {/* Breakdown */}
          <div className="card">
            <p className="section-label mb-4">Részletes adatok</p>
            <div className="grid grid-cols-2 gap-4">
              {[
                { label: 'Átlag megtekintés', value: result.breakdown.avg_views.toLocaleString() },
                { label: 'Átlag like', value: result.breakdown.avg_likes.toLocaleString() },
                { label: 'Átlag komment', value: result.breakdown.avg_comments.toLocaleString() },
                { label: 'Vizsgált videók', value: result.video_count },
                ...(result.breakdown.web_buzz !== null
                  ? [{ label: 'Webes visszhang', value: `${result.breakdown.web_buzz}/100` }]
                  : []),
              ].map(item => (
                <div key={item.label} className="bg-surface-2 rounded-lg p-3">
                  <p className="text-text-muted text-xs mb-1">{item.label}</p>
                  <p className="text-text-primary font-semibold">{item.value}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Magyarázható score-bontás */}
          <div className="card">
            <p className="section-label mb-1">Miért ez a pontszám?</p>
            <p className="text-xs text-text-muted mb-4">A fő szám mögötti tényezők — nem csak azt mutatja, MENNYIRE virális, hanem hogy MIÉRT.</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'Friss adat', value: result.breakdown.freshness },
                { label: 'Bizonyíték erőssége', value: result.breakdown.proof_strength },
                { label: 'Hook potenciál', value: result.breakdown.hook_potential },
                { label: 'Kíváncsiság', value: result.breakdown.audience_curiosity },
                { label: 'Platform illeszkedés', value: result.breakdown.platform_fit },
                { label: 'Gyárthatóság', value: result.breakdown.production_difficulty != null ? 100 - result.breakdown.production_difficulty : undefined, sub: 'Könnyebb legyártani, ha magas' },
                ...(result.breakdown.niche_fit != null ? [{ label: 'Niche illeszkedés', value: result.breakdown.niche_fit }] : []),
              ].filter(item => item.value != null).map(item => (
                <div key={item.label} className="bg-surface-2 rounded-lg p-3">
                  <p className="text-text-muted text-xs mb-1">{item.label}</p>
                  <p className="text-lg font-bold" style={{ color: scoreColor(item.value as number) }}>{item.value}/100</p>
                </div>
              ))}
              {result.breakdown.risk_level && (
                <div className="bg-surface-2 rounded-lg p-3">
                  <p className="text-text-muted text-xs mb-1">Kockázati szint</p>
                  <p className="text-lg font-bold" style={{
                    color: result.breakdown.risk_level === 'low' ? '#22C55E' : result.breakdown.risk_level === 'medium' ? '#F59E0B' : '#EF4444',
                  }}>
                    {result.breakdown.risk_level === 'low' ? 'Alacsony' : result.breakdown.risk_level === 'medium' ? 'Közepes' : 'Magas'}
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Webes visszhang forrásai */}
          {result.web_sources && result.web_sources.length > 0 && (
            <div className="card">
              <p className="section-label mb-4">Webes visszhang ({result.web_sources.length})</p>
              <div className="space-y-1.5">
                {result.web_sources.map((s, i) => (
                  <a key={s.url + i} href={s.url} target="_blank" rel="noopener noreferrer"
                    className="block py-2 px-2 rounded-lg transition-colors hover:bg-white/[0.03]"
                    style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.045)' }}>
                    <p className="text-xs font-medium line-clamp-1" style={{ color: '#CBD5E1' }}>{s.title}</p>
                    {(s.source || s.date) && (
                      <p className="text-[11px] mt-0.5" style={{ color: '#64748B' }}>
                        {[s.source, s.date].filter(Boolean).join(' · ')}
                      </p>
                    )}
                  </a>
                ))}
              </div>
            </div>
          )}

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
                          <p className="text-xs flex items-center gap-1" style={{ color: '#94A3B8' }}>
                            {video.channel_title} · <Eye className="w-3 h-3" aria-hidden="true" /> {formatNumber(video.view_count)}
                          </p>
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
            <button onClick={saveToMemory} className="btn-secondary flex-1 inline-flex items-center justify-center gap-1.5">
              <Bookmark className="w-4 h-4" aria-hidden="true" /> Mentés
            </button>
            <a
              href={`/dashboard/similar-videos?topic=${encodeURIComponent(result.topic)}`}
              className="btn-secondary flex-1 text-center inline-flex items-center justify-center gap-1.5"
            >
              <PlayCircle className="w-4 h-4" aria-hidden="true" /> Piaci bizonyítékok →
            </a>
            <a
              href={`/dashboard/video-package?topic=${encodeURIComponent(result.topic)}`}
              className="btn-primary flex-1 text-center inline-flex items-center justify-center gap-1.5"
            >
              <Package className="w-4 h-4" aria-hidden="true" /> Videócsomag →
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
