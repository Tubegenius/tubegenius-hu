'use client'

import { useState, useEffect } from 'react'
import Image from 'next/image'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import type { SimilarVideo, CreatorProfile, VideoCardData } from '@/types'
import VideoCardActions from '@/components/VideoCardActions'
import CreditConfirmModal from '@/components/CreditConfirmModal'
import type { UsageCheckResult } from '@/lib/usage-protection'
import LoadingScreen, { LOADING_STEPS } from '@/components/ui/LoadingScreen'

interface ViralSimilarVideo extends SimilarVideo {
  relevance_score?: number
  viral_video_score?: number
  score_breakdown?: {
    search_relevance: number
    freshness_score: number
    velocity_score: number
    engagement_score: number
    outlier_score: number
  }
  reason?: string
  freshness_label?: string
  velocity_label?: string
  badges?: string[]
  decision_status?: 'ready' | 'watch' | 'research' | 'rejected'
  decision_label?: string
  decision_score?: number
  risk_flags?: string[]
  niche_fit?: { score: number; label: string; reason: string }
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return n.toString()
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('hu-HU', { year: 'numeric', month: 'short', day: 'numeric' })
}

function scoreColor(score: number) {
  if (score >= 75) return '#22C55E'
  if (score >= 55) return '#3B82F6'
  if (score >= 40) return '#F59E0B'
  return '#CBD5E1'
}

function normalizedDecisionStatus(video: ViralSimilarVideo): 'ready' | 'watch' | 'research' | 'rejected' {
  if (video.view_count < 100) return 'rejected'
  return video.decision_status || 'research'
}

function MiniScore({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="flex items-center justify-between text-[10px] mb-1" style={{ color: '#CBD5E1' }}>
        <span>{label}</span>
        <span style={{ color: scoreColor(value) }}>{value}</span>
      </div>
      <div className="h-1 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, value))}%`, background: scoreColor(value) }} />
      </div>
    </div>
  )
}

function VideoCard({ video }: { video: ViralSimilarVideo }) {
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
    source_context: 'similar_videos',
    decision_status: video.decision_status,
    decision_label: video.decision_label,
    decision_score: video.decision_score,
    risk_flags: video.risk_flags || [],
    viral_video_score: video.viral_video_score,
    relevance_score: video.relevance_score,
    score_breakdown: video.score_breakdown,
    reason: video.reason,
  }

  const score = video.viral_video_score ?? 0
  const breakdown = video.score_breakdown
  const decisionStatus = normalizedDecisionStatus(video)
  const decisionColor = decisionStatus === 'ready' ? '#22C55E'
    : decisionStatus === 'watch' ? '#F59E0B'
    : decisionStatus === 'rejected' ? '#EF4444'
    : '#CBD5E1'
  const decisionBg = decisionStatus === 'ready' ? 'rgba(34,197,94,0.1)'
    : decisionStatus === 'watch' ? 'rgba(245,158,11,0.1)'
    : decisionStatus === 'rejected' ? 'rgba(239,68,68,0.1)'
    : 'rgba(139,155,180,0.08)'

  return (
    <div className="card-hover flex flex-col gap-0 overflow-hidden p-0 group">
      <a href={video.url} target="_blank" rel="noopener noreferrer" className="block">
        <div className="relative aspect-video bg-surface-2 overflow-hidden">
          {video.thumbnail_url ? (
            <Image src={video.thumbnail_url} alt={video.title} fill className="object-cover group-hover:scale-105 transition-transform duration-300" sizes="(max-width: 768px) 100vw, 33vw" />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-text-muted">Video</div>
          )}
          <div className="absolute top-2 left-2 rounded-lg px-2 py-1 text-xs font-bold" style={{ background: 'rgba(11,15,25,0.86)', color: scoreColor(score), border: '1px solid rgba(255,255,255,0.12)' }}>
            Viral {score}
          </div>
        </div>
      </a>
      <div className="p-4 flex flex-col flex-1">
        <div className="flex flex-wrap gap-1.5 mb-2">
          {(video.badges || []).map(badge => (
            <span key={badge} className="text-[10px] px-2 py-0.5 rounded-full" style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.18)', color: '#3B82F6' }}>
              {badge}
            </span>
          ))}
          {video.freshness_label && (
            <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.18)', color: '#22C55E' }}>
              {video.freshness_label}
            </span>
          )}
        </div>

        <a href={video.url} target="_blank" rel="noopener noreferrer"
          className="text-sm font-medium text-text-primary line-clamp-2 mb-1 leading-snug hover:text-violet transition-colors">
          {video.title}
        </a>
        <p className="text-xs text-text-muted mb-3">{video.channel_title}</p>

        {(() => {
          const nf = video.niche_fit
          if (!nf) return null
          const s = nf.score
          const icon = s >= 70 ? 'ti-target' : s >= 40 ? 'ti-target' : s > 0 ? 'ti-target' : 'ti-world'
          const clr = s >= 70 ? '#22C55E' : s >= 40 ? '#3B82F6' : s > 0 ? '#F59E0B' : '#94A3B8'
          const bg = s >= 70 ? 'rgba(34,197,94,0.06)' : s >= 40 ? 'rgba(59,130,246,0.06)' : s > 0 ? 'rgba(245,158,11,0.06)' : 'rgba(255,255,255,0.03)'
          const br = s >= 70 ? 'rgba(34,197,94,0.15)' : s >= 40 ? 'rgba(59,130,246,0.15)' : s > 0 ? 'rgba(245,158,11,0.15)' : 'rgba(255,255,255,0.06)'
          return (
            <div className="rounded-lg px-3 py-2 mb-3 flex items-center gap-2" style={{ background: bg, border: `1px solid ${br}` }}>
              <i className={`ti ${icon}`} style={{ color: clr, fontSize: '14px' }} />
              <div className="flex-1 min-w-0">
                <span className="text-xs font-medium" style={{ color: clr }}>
                  {s > 0 ? `${nf.label} (${s})` : nf.label}
                </span>
                <p className="text-xs truncate" style={{ color: '#94A3B8' }}>{nf.reason}</p>
              </div>
            </div>
          )
        })()}

        <div className="grid grid-cols-2 gap-2 mb-3">
          <div className="rounded-lg p-2" style={{ background: '#0A0E18', border: '1px solid rgba(255,255,255,0.06)' }}>
            <p className="text-[10px]" style={{ color: '#CBD5E1' }}>Relevancia</p>
            <p className="text-sm font-bold" style={{ color: scoreColor(video.relevance_score || 0) }}>{video.relevance_score || 0}</p>
          </div>
          <div className="rounded-lg p-2" style={{ background: '#0A0E18', border: '1px solid rgba(255,255,255,0.06)' }}>
            <p className="text-[10px]" style={{ color: '#CBD5E1' }}>Sebesség</p>
            <p className="text-sm font-bold" style={{ color: '#F8FAFC' }}>{video.velocity_label || '-'}</p>
          </div>
        </div>

        {breakdown && (
          <div className="space-y-1.5 mb-3">
            <MiniScore label="Frissesség" value={breakdown.freshness_score} />
            <MiniScore label="Engagement" value={breakdown.engagement_score} />
            <MiniScore label="Kiugrás a találatokhoz képest" value={breakdown.outlier_score} />
          </div>
        )}

        {video.reason && <p className="text-xs leading-relaxed mb-3" style={{ color: '#CBD5E1' }}>{video.reason}</p>}

        <div className="rounded-lg px-3 py-2 mb-3"
          style={{ background: decisionBg, border: `1px solid ${decisionColor}30` }}>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold" style={{ color: decisionColor }}>
              WillViral döntés: {video.decision_label || 'Kutatási inspiráció'}
            </p>
            {video.decision_score !== undefined && (
              <span className="text-xs font-mono" style={{ color: decisionColor }}>{video.decision_score}/100</span>
            )}
          </div>
          {video.risk_flags && video.risk_flags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {video.risk_flags.slice(0, 3).map(flag => (
                <span key={flag} className="text-[10px] px-2 py-0.5 rounded-full"
                  style={{ background: '#121826', border: '1px solid rgba(255,255,255,0.08)', color: '#CBD5E1' }}>
                  {flag}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 text-xs text-text-muted mt-auto flex-wrap">
          <span>Megtekintés: {formatNumber(video.view_count)}</span>
          <span>Like: {formatNumber(video.like_count)}</span>
          <span>Komment: {formatNumber(video.comment_count)}</span>
          <span className="ml-auto">{formatDate(video.published_at)}</span>
        </div>
        <div className="mt-3 pt-3 border-t border-border">
          <VideoCardActions video={cardData} compact />
        </div>
      </div>
    </div>
  )
}

const REGION_OPTIONS = [
  { value: 'HU', label: 'HU Magyar' },
  { value: 'US', label: 'US Globális' },
]


function looksLikeEnglishTopic(value: string) {
  const text = value.trim()
  if (!text) return false
  const hasHungarianChars = /[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/.test(text)
  const letters = text.match(/[a-zA-Z]/g)?.length || 0
  const asciiRatio = letters / Math.max(1, text.length)
  const englishSignals = /\b(explained|breakthrough|research|why|science|scientific|phenomena|mystery|facts|history|health|technology|ai)\b/i.test(text)
  return !hasHungarianChars && (englishSignals || asciiRatio > 0.55)
}

export default function SimilarVideosPage() {
  const searchParams = useSearchParams()
  const supabase = createClient()
  const initialTopic = searchParams.get('topic') || ''
  const initialUserNiche = searchParams.get('user_niche') || searchParams.get('niche') || ''
  const paidResultId = searchParams.get('paidResultId') || ''

  const [profile, setProfile] = useState<CreatorProfile | null>(null)
  const [topic, setTopic] = useState(initialTopic)
  const [searchTopic, setSearchTopic] = useState(initialTopic)
  const [region, setRegion] = useState<'HU' | 'US'>('HU')
  const [videos, setVideos] = useState<ViralSimilarVideo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchedRegions, setSearchedRegions] = useState<string[]>([])
  const [queriesUsed, setQueriesUsed] = useState<string[]>([])
  const [fromCache, setFromCache] = useState(false)
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null)
  const [creditCheck, setCreditCheck] = useState<UsageCheckResult | null>(null)
  const [pendingSearch, setPendingSearch] = useState<{ topic: string; region: 'HU' | 'US'; allowFallback: boolean; forceRefresh?: boolean } | null>(null)

  // Keresési előzmény visszaállítása böngésző vissza gombhoz
  useEffect(() => {
    const saved = sessionStorage.getItem('willviral_similar_videos_state')
    if (saved) {
      try {
        const state = JSON.parse(saved)
        // Ha az URL topic ugyanaz mint a cache-elt topic, ne induljon új fizetős keresés (pl. F5 frissítés)
        const sameTopicAsCache = !initialTopic || state.topic === initialTopic
        if (sameTopicAsCache && state.videos?.length > 0) {
          setTopic(state.topic || '')
          setSearchTopic(state.searchTopic || '')
          setRegion(state.region || 'HU')
          setVideos(state.videos || [])
          setQueriesUsed(state.queriesUsed || [])
          loadProfileOnly()
          return
        }
        if (!initialTopic) {
          setTopic(state.topic || '')
          setSearchTopic(state.searchTopic || '')
          setRegion(state.region || 'HU')
          setVideos(state.videos || [])
          setQueriesUsed(state.queriesUsed || [])
        }
      } catch {}
    }
    loadProfileAndSearch()
  }, [])

  async function loadProfileOnly() {
    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
      const { data } = await supabase.from('profiles').select('*').eq('user_id', user.id).single()
      if (data) setProfile(data)
    }
  }

  async function loadProfileAndSearch() {
    const { data: { user } } = await supabase.auth.getUser()
    let initialRegion: 'HU' | 'US' = 'HU'

    if (user) {
      const { data } = await supabase.from('profiles').select('*').eq('user_id', user.id).single()
      if (data) {
        setProfile(data)
        if (data.region === 'US') initialRegion = 'US'
        else if (data.region === 'BOTH') {
          initialRegion = /^[a-zA-Z0-9\s\-:.,!?'"]+$/.test(initialTopic) && initialTopic.length > 0 ? 'US' : 'HU'
        }
      }
    }

    if (looksLikeEnglishTopic(initialTopic)) initialRegion = 'US'

    setRegion(initialRegion)
    // FONTOS: még automatikus (URL-ből jövő topic) keresésnél sem szabad
    // kreditet levonni felugró megerősítés nélkül — ugyanazon a kredit-
    // ellenőrzésen megy át, mint a kézi keresés gomb.
    if (initialTopic) await runSearchWithCreditCheck(initialTopic, initialRegion, true)
  }

  async function loadVideos(t: string, r: 'HU' | 'US', allowFallback = false, forceRefresh = false) {
    setLoading(true)
    setError(null)
    setQueriesUsed([])
    setFromCache(false)
    setLastRefreshedAt(null)

    async function requestVideos(regionToTry: 'HU' | 'US') {
      const res = await fetch('/api/similar-videos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: t,
          region: regionToTry,
          max_results: 9,
          force_refresh: forceRefresh,
          user_niche: initialUserNiche || undefined,
          paidResultId: paidResultId || undefined,
        }),
      })
      const data = await res.json()
      return { ok: res.ok, data }
    }

    try {
      const tried: Array<'HU' | 'US'> = [r]
      const first = await requestVideos(r)
      let foundVideos = first.ok ? (first.data.videos || []) : []
      setQueriesUsed(first.data?.queries_used || [])
      if (first.ok && (first.data?.from_cache || first.data?.from_paid_result)) {
        setFromCache(true)
        setLastRefreshedAt(first.data.last_refreshed_at || null)
      }

      const shouldTryOtherRegion = foundVideos.length === 0 && (allowFallback || looksLikeEnglishTopic(t) || r === 'HU')
      if (shouldTryOtherRegion) {
        const fallbackRegion = r === 'HU' ? 'US' : 'HU'
        const second = await requestVideos(fallbackRegion)
        tried.push(fallbackRegion)
        if (second.ok && second.data.videos?.length > 0) {
          foundVideos = second.data.videos
          setRegion(fallbackRegion)
          setQueriesUsed(second.data.queries_used || [])
          setError(null)
        } else if (!first.ok && !second.ok) {
          setError(second.data?.error || first.data?.error || 'Videók betöltése sikertelen.')
        } else if (first.data?.warning || second.data?.warning) {
          setError(first.data?.warning || second.data?.warning)
        }
      } else if (!first.ok) {
        setError(first.data?.error || 'Videók betöltése sikertelen.')
      }

      setSearchedRegions(tried)
      setVideos(foundVideos)

      // Mentés sessionStorage-ba — böngésző vissza gomb támogatás
      sessionStorage.setItem('willviral_similar_videos_state', JSON.stringify({
        topic: t,
        searchTopic: t,
        region: r,
        videos: foundVideos,
        queriesUsed: first.data?.queries_used || [],
      }))
    } catch {
      setError('Kapcsolati hiba.')
    } finally {
      setLoading(false)
    }
  }

  // Közös kredit-ellenőrzés — kézi kereséshez ÉS az URL-ből jövő automatikus
  // kereséshez is. Soha ne fusson le fizetős keresés felugró megerősítés
  // nélkül, akárhonnan indul. Előbb megnézzük, van-e mentett (ingyenes)
  // eredmény ehhez a témához — ha van, azt mutatjuk, kredit-ellenőrzés
  // és -levonás nélkül.
  async function runSearchWithCreditCheck(t: string, r: 'HU' | 'US', allowFallback: boolean) {
    if (!t.trim()) return

    try {
      const cacheRes = await fetch('/api/similar-videos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: t,
          region: r,
          max_results: 9,
          cache_only: true,
          user_niche: initialUserNiche || undefined,
          paidResultId: paidResultId || undefined,
        }),
      })
      const cacheData = await cacheRes.json()
      if (cacheRes.ok && (cacheData.from_cache || cacheData.from_paid_result)) {
        setSearchTopic(t)
        setVideos(cacheData.videos || [])
        setFromCache(true)
        setLastRefreshedAt(cacheData.last_refreshed_at || null)
        setSearchedRegions([r])
        return
      }
    } catch {}

    try {
      const checkRes = await fetch('/api/credit-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feature: 'similar_videos' }),
      })
      const check = await checkRes.json() as UsageCheckResult

      if (!check.canRun) {
        setCreditCheck(check)
        return
      }
      if (check.requiresConfirmation) {
        setPendingSearch({ topic: t, region: r, allowFallback })
        setCreditCheck(check)
        return
      }
    } catch {}

    setSearchTopic(t)
    loadVideos(t, r, allowFallback)
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    await runSearchWithCreditCheck(topic, region, false)
  }

  async function handleConfirmedSearch() {
    if (!pendingSearch) return
    setCreditCheck(null)
    setSearchTopic(pendingSearch.topic)
    loadVideos(pendingSearch.topic, pendingSearch.region, pendingSearch.allowFallback, pendingSearch.forceRefresh || false)
    setPendingSearch(null)
  }

  // Explicit "Frissítés" — mindig új, fizetős keresést indít (kredit-
  // megerősítéssel), a cache-t figyelmen kívül hagyja.
  async function handleRefresh() {
    try {
      const checkRes = await fetch('/api/credit-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feature: 'similar_videos' }),
      })
      const check = await checkRes.json() as UsageCheckResult
      if (!check.canRun) { setCreditCheck(check); return }
      if (check.requiresConfirmation) {
        setPendingSearch({ topic: searchTopic || topic, region, allowFallback: false, forceRefresh: true })
        setCreditCheck(check)
        return
      }
    } catch {}
    loadVideos(searchTopic || topic, region, false, true)
  }

  return (
    <div className="max-w-5xl mx-auto">
      {creditCheck && (
        <CreditConfirmModal
          check={creditCheck}
          onConfirm={handleConfirmedSearch}
          onCancel={() => { setCreditCheck(null); setPendingSearch(null) }}
          loading={loading}
        />
      )}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-text-primary mb-1">Piaci bizonyítékok</h1>
        <p className="text-text-secondary text-sm">Hasonló, friss, releváns videók — virális potenciál alapján rangsorolva.</p>
      </div>

      <div className="card mb-6">
        <form onSubmit={handleSearch} className="flex gap-3">
          <input value={topic} onChange={e => setTopic(e.target.value)} placeholder="pl. AI az orvostudományban" className="input flex-1" />
          <div className="flex gap-1">
            {REGION_OPTIONS.map(opt => (
              <button key={opt.value} type="button" onClick={() => setRegion(opt.value as 'HU' | 'US')}
                className="px-3 py-2 rounded-lg text-xs font-medium transition-all"
                style={{
                  background: region === opt.value ? 'rgba(59,130,246,0.1)' : '#121826',
                  border: region === opt.value ? '1px solid rgba(59,130,246,0.4)' : '1px solid rgba(255,255,255,0.08)',
                  color: region === opt.value ? '#3B82F6' : '#CBD5E1',
                }}>
                {opt.label}
              </button>
            ))}
          </div>
          <button type="submit" disabled={loading || !topic.trim()} className="btn-primary px-6">Keresés</button>
        </form>
        {queriesUsed.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {queriesUsed.map(q => (
              <span key={q} className="text-[10px] px-2 py-1 rounded-full" style={{ background: '#0A0E18', border: '1px solid rgba(255,255,255,0.06)', color: '#CBD5E1' }}>
                {q}
              </span>
            ))}
          </div>
        )}
      </div>

      {error && <div className="bg-rose/10 border border-rose/20 rounded-xl px-5 py-4 text-rose text-sm mb-6">{error}</div>}

      {!loading && fromCache && videos.length > 0 && (
        <div className="rounded-xl px-4 py-3 mb-4 flex items-center justify-between gap-3 flex-wrap"
          style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)' }}>
          <div>
            <p className="text-sm font-medium" style={{ color: '#93C5FD' }}>
              <i className="ti ti-database mr-1.5" />Mentett eredmény
            </p>
            <p className="text-xs mt-0.5" style={{ color: '#94A3B8' }}>
              Ezt a keresést már korábban lefuttattad. Nem vontunk le új kreditet.
              {lastRefreshedAt && ` Utolsó frissítés: ${new Date(lastRefreshedAt).toLocaleDateString('hu-HU')}.`}
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

      {loading && (
        <div className="card">
          <LoadingScreen steps={LOADING_STEPS.similarVideos} message="Virális potenciál alapján rangsorolunk" />
        </div>
      )}

      {!loading && videos.length > 0 && (() => {
        const recommendedVideos = videos.filter(v => {
          const status = normalizedDecisionStatus(v)
          return status === 'ready' || status === 'watch'
        })
        const researchVideos = videos.filter(v => normalizedDecisionStatus(v) === 'research')
        const rejectedVideos = videos.filter(v => normalizedDecisionStatus(v) === 'rejected')
        const readyCount = recommendedVideos.filter(v => v.decision_status === 'ready').length
        const watchCount = recommendedVideos.filter(v => v.decision_status === 'watch').length
        const researchCount = researchVideos.length
        const bestScore = Math.max(...recommendedVideos.map(v => v.viral_video_score || v.decision_score || 0), 0)
        return (
        <div>
          <div className="grid grid-cols-4 gap-3 mb-4">
            {[
              { label: 'Legjobb viral jel', value: bestScore, color: scoreColor(bestScore) },
              { label: 'Gyártható inspiráció', value: readyCount, color: '#22C55E' },
              { label: 'Korai lehetőség', value: watchCount, color: '#F59E0B' },
              { label: 'Kutatási jel', value: researchCount, color: '#94A3B8' },
            ].map(item => (
              <div key={item.label} className="rounded-xl px-4 py-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <p className="text-xl font-bold" style={{ color: item.color }}>{item.value}</p>
                <p className="text-xs mt-0.5" style={{ color: '#94A3B8' }}>{item.label}</p>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between mb-4">
            <p className="section-label">{recommendedVideos.length} ajánlott inspiráció - <span className="text-text-secondary normal-case font-normal text-xs">{searchTopic}</span></p>
            {searchedRegions.length > 1 && (
              <p className="text-xs" style={{ color: '#F59E0B' }}>
                Figyelem: {searchedRegions[0]} régióban nem volt elég erős találat, automatikusan {searchedRegions[1]} régióra váltottunk
              </p>
            )}
          </div>
          {recommendedVideos.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {recommendedVideos.map(video => <VideoCard key={video.video_id} video={video} />)}
            </div>
          ) : (
            <div className="rounded-xl px-4 py-3 text-sm mb-4" style={{ background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.18)', color: '#F59E0B' }}>
              Nincs elég erős gyártási inspiráció. A találatokat kutatási nyomként vagy gyenge jelzésként kezeld.
            </div>
          )}
          {researchVideos.length > 0 && (
            <div className="mt-6">
              <div className="mb-3">
                <p className="text-sm font-semibold" style={{ color: '#CBD5E1' }}>
                  Kutatási nyomok: {researchVideos.length}
                </p>
                <p className="text-xs mt-0.5" style={{ color: '#94A3B8' }}>
                  Ezek még nem ajánlott inspirációk. Használd őket iránykeresésre, majd validáld tovább Piaci bizonyítékok vagy Virális esély alapján.
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 opacity-90">
                {researchVideos.map(video => <VideoCard key={video.video_id} video={video} />)}
              </div>
            </div>
          )}
          {rejectedVideos.length > 0 && (
            <div className="mt-6 rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <p className="text-sm font-semibold mb-1" style={{ color: '#CBD5E1' }}>
                Kiszűrt gyenge találatok: {rejectedVideos.length}
              </p>
              <p className="text-xs" style={{ color: '#94A3B8' }}>
                Ezeket a rendszer megtalálta, de alacsony nézettség, gyenge piaci jel vagy túl alacsony validáció miatt nem ajánlja inspirációnak.
              </p>
            </div>
          )}
        </div>
        )
      })()}

      {!loading && videos.length === 0 && searchTopic && (
        <div className="card text-center py-12">
          <p className="text-3xl mb-3">Nincs találat</p>
          <p className="text-text-secondary">Nem találtunk elég releváns, friss és virális potenciálú videót erre a témára.</p>
          <p className="text-text-muted text-sm mt-1">Próbálj konkrétabb témát, például: AI diagnosztika rák felismerésében.</p>
        </div>
      )}
    </div>
  )
}
