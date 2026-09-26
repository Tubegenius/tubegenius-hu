'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  CheckCircle2,
  CircleAlert,
  Compass,
  ExternalLink,
  Gauge,
  Link2,
  LockKeyhole,
  PlayCircle,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingDown,
  Trophy,
  Youtube,
} from 'lucide-react'
import CreditConfirmModal from '@/components/CreditConfirmModal'
import { useCreatorOS } from '@/components/dashboard/CreatorOSContext'
import type { ChannelProfile } from '@/components/channel-audit/ChannelHeaderCard'
import LoadingScreen, { LOADING_STEPS } from '@/components/ui/LoadingScreen'
import {
  CHANNEL_AUDIT_LANE_COPY,
  deriveChannelAuditFocus,
  presentChannelAuditDimensions,
  type ChannelAuditDimensionAverages,
  type ChannelAuditFocus,
} from '@/lib/creator-channel-audit-presentation'
import type { UsageCheckResult } from '@/lib/usage-protection'
import { publishCreditMutationCompleted } from '@/lib/credit-balance-events'
import { useCreditBalance } from '@/components/credits/CreditBalanceContext'

interface ChannelVideoPerformance {
  videoId: string
  title: string | null
  views: number
  estimatedMinutesWatched: number
  averageViewDuration: number
}

interface ChannelAnalyticsSummary {
  channelId: string
  channelTitle: string | null
  rangeStart: string
  rangeEnd: string
  totals: { views: number; estimatedMinutesWatched: number; subscribersGained: number; subscribersLost: number }
  topVideos: ChannelVideoPerformance[]
  weakestVideos: ChannelVideoPerformance[]
}

interface AuditSummary {
  id: string
  video_title: string
  overall_score: number
  overall_label: string
  created_at: string
}

interface ChannelAuditData {
  has_enough_data: boolean
  audit_count: number
  min_required?: number
  relevant_audit_count?: number
  min_relevant_required?: number
  can_generate_suggestions?: boolean
  dimension_averages?: ChannelAuditDimensionAverages
  weakest_dimension?: { key: string; label: string; value: number }
  top_strong?: AuditSummary[]
  top_weak?: AuditSummary[]
  workflow_completion_rhythm?: Array<{ month: string; count: number }>
  niche_review_required?: boolean
  active_channel_id?: string | null
  no_active_channel?: boolean
  legacy_unassigned_audit_count?: number
}

interface SuggestionsResult {
  suggestions: Array<{ topic: string; reasoning: string }>
  from_paid_result?: boolean
  cache_status?: 'fresh' | 'stale_saved'
  last_analyzed_at?: string
  paid_result_id?: string | null
}

const CHANNEL_AUDIT_COST = 2
const SUGGESTIONS_STATE_KEY = 'willviral_channel_audit_suggestions'

function formatCount(value: number | null | undefined): string {
  return value == null ? '—' : value.toLocaleString('hu-HU')
}

function ChannelIdentity({ profile }: { profile: ChannelProfile | null }) {
  return (
    <div className="wv-channel-identity">
      <div className="wv-channel-portrait">
        {profile?.channel_avatar_url ? <img src={profile.channel_avatar_url} alt={profile.channel_name || 'YouTube-csatorna'} /> : <Youtube aria-hidden="true" />}
        <i aria-hidden="true" />
      </div>
      <div className="wv-channel-identity-copy">
        <span className="wv-eyebrow">Aktív csatornakép</span>
        <h2>{profile?.channel_name || 'A csatornád helye'}</h2>
        {profile?.youtube_handle && <a href={profile.youtube_channel_url || '#'} target="_blank" rel="noopener noreferrer">@{profile.youtube_handle}<ExternalLink aria-hidden="true" /></a>}
        <p>{profile ? 'Publikus YouTube-identitás és a hozzá rendelt WillViral-diagnózisok.' : 'Kapcsold a csatornát a diagnosztikai és teljesítményréteg összekötéséhez.'}</p>
      </div>
      <div className="wv-channel-public-stats" aria-label="Publikus csatornaadatok">
        <div><span>Feliratkozó</span><strong>{formatCount(profile?.subscriber_count)}</strong></div>
        <div><span>Összes megtekintés</span><strong>{formatCount(profile?.total_view_count)}</strong></div>
        <div><span>Videók</span><strong>{formatCount(profile?.video_count)}</strong></div>
      </div>
    </div>
  )
}

function ChannelFocusCard({
  focus,
  connecting,
  onConnect,
  onRetry,
  onRequest,
}: {
  focus: ChannelAuditFocus
  connecting: boolean
  onConnect: () => void
  onRetry: () => void
  onRequest: () => void
}) {
  const progress = focus.progressCurrent != null && focus.progressTarget != null
    ? Math.min(100, Math.round((focus.progressCurrent / Math.max(1, focus.progressTarget)) * 100))
    : null

  return (
    <div className={`wv-channel-focus-card state-${focus.kind}`}>
      <span className="wv-channel-focus-index"><Target aria-hidden="true" />01</span>
      <div><span className="wv-eyebrow">{focus.label}</span><h2>{focus.title}</h2>{focus.description && <p>{focus.description}</p>}</div>
      {progress != null && <div className="wv-channel-audit-progress"><span><strong>{focus.progressCurrent}</strong> / {focus.progressTarget}</span><i><b style={{ width: `${progress}%` }} /></i></div>}
      <div className="wv-channel-focus-action">
        {focus.kind === 'load_error' && <button type="button" className="wv-secondary-action" onClick={onRetry}><RefreshCw aria-hidden="true" />Újrapróbálás</button>}
        {focus.kind === 'niche_review' && <Link href="/dashboard/profile" className="wv-primary-action">Niche megerősítése<ArrowRight aria-hidden="true" /></Link>}
        {focus.kind === 'connect' && <button type="button" className="wv-primary-action" disabled={connecting} onClick={onConnect}>{connecting ? 'Átirányítás…' : 'YouTube összekapcsolása'}<Link2 aria-hidden="true" /></button>}
        {(focus.kind === 'build_evidence' || focus.kind === 'build_relevance') && <Link href="/dashboard/video-audit" className="wv-primary-action">Videódiagnózis készítése<ArrowRight aria-hidden="true" /></Link>}
        {focus.kind === 'ready' && <button type="button" className="wv-primary-action" onClick={onRequest}>10 új tartalomirány<ArrowRight aria-hidden="true" /></button>}
        {focus.kind === 'suggestions' && <a href="#channel-directions" className="wv-primary-action">Irányok megnyitása<ArrowRight aria-hidden="true" /></a>}
        {focus.kind === 'suggestion_error' && <button type="button" className="wv-secondary-action" onClick={onRequest}><RefreshCw aria-hidden="true" />Újrapróbálás</button>}
        {(focus.kind === 'loading' || focus.kind === 'generating') && <button type="button" className="wv-primary-action" disabled>Feldolgozás…</button>}
      </div>
    </div>
  )
}

function DiagnosticProfile({ data }: { data: ChannelAuditData }) {
  const dimensions = data.dimension_averages ? presentChannelAuditDimensions(data.dimension_averages, data.weakest_dimension?.key) : []
  const maxRhythm = Math.max(1, ...(data.workflow_completion_rhythm || []).map(item => item.count))

  return (
    <section className="wv-channel-diagnostic" aria-labelledby="wv-channel-diagnostic-title">
      <header><div><span className="wv-eyebrow">Diagnosztikai profil</span><h2 id="wv-channel-diagnostic-title">A csatorna alkotói mintázata.</h2></div><span>{data.audit_count} beküldött audit alapján</span></header>
      {dimensions.length > 0 ? (
        <div className="wv-channel-diagnostic-grid">
          <div className="wv-channel-dimension-map">
            <span className="wv-channel-map-core"><Gauge aria-hidden="true" /><strong>{data.weakest_dimension?.value ?? '—'}</strong><small>figyelendő dimenzió</small></span>
            <div>{dimensions.map((dimension, index) => <article key={dimension.key} data-weakest={dimension.isWeakest || undefined} style={{ '--dimension-value': `${dimension.value}%`, '--dimension-index': index } as React.CSSProperties}><span>{String(index + 1).padStart(2, '0')}</span><div><strong>{dimension.label}</strong><i><b /></i></div><em>{dimension.value}</em></article>)}</div>
          </div>
          <div className="wv-channel-patterns">
            <article className="is-strong"><Trophy aria-hidden="true" /><div><span>Erős minták</span><h3>Ahol már van működő alap.</h3></div><ul>{(data.top_strong || []).slice(0, 3).map(item => <li key={item.id}><Link href={`/dashboard/video-audit?id=${item.id}`}>{item.video_title}<strong>{item.overall_score}</strong></Link></li>)}</ul></article>
            <article className="is-focus"><TrendingDown aria-hidden="true" /><div><span>Fejlesztési tér</span><h3>Ahol a következő döntés számít.</h3></div><ul>{(data.top_weak || []).slice(0, 3).map(item => <li key={item.id}><Link href={`/dashboard/video-audit?id=${item.id}`}>{item.video_title}<strong>{item.overall_score}</strong></Link></li>)}</ul></article>
          </div>
        </div>
      ) : (
        <div className="wv-channel-diagnostic-empty"><Gauge aria-hidden="true" /><div><h3>Még épül a diagnosztikai profil.</h3><p>Az öt dimenzió legalább {data.min_required ?? 3} megfelelő Videódiagnózis után válik összehasonlíthatóvá.</p></div><Link href="/dashboard/video-audit" className="wv-primary-action">Diagnózis indítása<ArrowRight aria-hidden="true" /></Link></div>
      )}
      {(data.workflow_completion_rhythm?.length || 0) > 0 && <div className="wv-channel-rhythm"><div><span className="wv-eyebrow">Workflow-ritmus</span><p>WillViralban publikáltnak jelölt ötletek; nem YouTube-publikálási gyakoriság.</p></div><div>{data.workflow_completion_rhythm!.map(item => <span key={item.month}><i><b style={{ height: `${Math.max(8, (item.count / maxRhythm) * 100)}%` }} /></i><small>{item.month.slice(5)}</small></span>)}</div></div>}
      <p className="wv-channel-source-note"><ShieldCheck aria-hidden="true" /><span><strong>Forráshatár:</strong> ez a profil a kézzel beküldött Videódiagnózisok értékelésén alapul, nem a YouTube Analytics adatsorán.</span></p>
    </section>
  )
}

function AnalyticsPulse({
  analytics,
  connected,
  error,
  disconnecting,
  confirmDisconnect,
  onConnect,
  onAskDisconnect,
  onCancelDisconnect,
  onDisconnect,
}: {
  analytics: ChannelAnalyticsSummary | null
  connected: boolean | null
  error: string | null
  disconnecting: boolean
  confirmDisconnect: boolean
  onConnect: () => void
  onAskDisconnect: () => void
  onCancelDisconnect: () => void
  onDisconnect: () => void
}) {
  if (!connected || !analytics) {
    return (
      <section className="wv-channel-analytics is-locked" aria-labelledby="wv-channel-analytics-title">
        <span className="wv-channel-lock"><LockKeyhole aria-hidden="true" /></span>
        <div><span className="wv-eyebrow">Valós csatornapulzus</span><h2 id="wv-channel-analytics-title">A privát teljesítményréteg még zárva van.</h2><p>Összekapcsolás után a valós megtekintés, watch time és feliratkozói mozgás külön rétegként jelenik meg.</p>{error && <p className="wv-channel-connection-error" role="alert">{error}</p>}</div>
        <button type="button" className="wv-secondary-action" onClick={onConnect}>Összekapcsolás<Link2 aria-hidden="true" /></button>
      </section>
    )
  }

  const metrics = [
    ['Megtekintés', analytics.totals.views.toLocaleString('hu-HU')],
    ['Watch time', `${Math.round(analytics.totals.estimatedMinutesWatched).toLocaleString('hu-HU')} perc`],
    ['Új feliratkozó', `+${analytics.totals.subscribersGained.toLocaleString('hu-HU')}`],
    ['Elvesztett', `−${analytics.totals.subscribersLost.toLocaleString('hu-HU')}`],
  ]

  return (
    <section className="wv-channel-analytics" aria-labelledby="wv-channel-analytics-title">
      <header><div><span className="wv-eyebrow">Valós csatornapulzus</span><h2 id="wv-channel-analytics-title">{analytics.channelTitle || 'YouTube Analytics'}</h2><p>{analytics.rangeStart} – {analytics.rangeEnd}</p></div><span><Activity aria-hidden="true" />OAuth-analitika</span></header>
      <div className="wv-channel-metric-grid">{metrics.map(([label, value], index) => <div key={label} data-tone={index}><span>{label}</span><strong>{value}</strong></div>)}</div>
      <div className="wv-channel-video-contrast">
        <article><header><Trophy aria-hidden="true" /><div><span>Felső minta</span><h3>Legjobban teljesítő videók</h3></div></header><div>{analytics.topVideos.slice(0, 4).map(video => <a key={video.videoId} href={`https://www.youtube.com/watch?v=${video.videoId}`} target="_blank" rel="noopener noreferrer"><span><PlayCircle aria-hidden="true" />{video.title || video.videoId}</span><strong>{video.views.toLocaleString('hu-HU')}</strong></a>)}</div></article>
        <article><header><TrendingDown aria-hidden="true" /><div><span>Alsó minta</span><h3>A 28 napos minta gyengébb videói</h3></div></header><div>{analytics.weakestVideos.slice(0, 4).map(video => <a key={video.videoId} href={`https://www.youtube.com/watch?v=${video.videoId}`} target="_blank" rel="noopener noreferrer"><span><PlayCircle aria-hidden="true" />{video.title || video.videoId}</span><strong>{video.views.toLocaleString('hu-HU')}</strong></a>)}</div></article>
      </div>
      {error && <p className="wv-channel-connection-error" role="alert">{error}</p>}
      <footer>{confirmDisconnect ? <div role="alert"><span>Biztosan bontod a privát analitikai kapcsolatot?</span><button type="button" onClick={onCancelDisconnect}>Mégse</button><button type="button" disabled={disconnecting} onClick={onDisconnect}>{disconnecting ? 'Bontás…' : 'Kapcsolat bontása'}</button></div> : <button type="button" onClick={onAskDisconnect}>Analitikai kapcsolat bontása</button>}</footer>
    </section>
  )
}

function SuggestionStudio({
  data,
  result,
  generating,
  error,
  onRequest,
  onRefresh,
}: {
  data: ChannelAuditData
  result: SuggestionsResult | null
  generating: boolean
  error: string | null
  onRequest: () => void
  onRefresh: () => void
}) {
  const missing = Math.max(0, (data.min_relevant_required ?? 3) - (data.relevant_audit_count ?? 0))
  return (
    <section id="channel-directions" className="wv-channel-directions" aria-labelledby="wv-channel-directions-title">
      <header><div><span className="wv-eyebrow">Következő tartalomirányok</span><h2 id="wv-channel-directions-title">Az auditból legyen alkotói mozdulat.</h2></div>{!result && data.can_generate_suggestions && <button type="button" className="wv-primary-action" disabled={generating} onClick={onRequest}>{generating ? 'Elemzés…' : '10 irány kérése'}<Sparkles aria-hidden="true" /></button>}{result && <button type="button" className="wv-secondary-action" disabled={generating} onClick={onRefresh}><RefreshCw aria-hidden="true" />Frissítés</button>}</header>
      {error && <div className="wv-channel-alert is-error" role="alert"><CircleAlert aria-hidden="true" /><div><strong>A javaslatok most nem készültek el.</strong><p>{error}</p></div></div>}
      {!result && !data.can_generate_suggestions && <div className="wv-channel-alert"><ShieldCheck aria-hidden="true" /><div><strong>Még {missing} niche-releváns Videódiagnózis szükséges.</strong><p>Jelenleg {data.relevant_audit_count ?? 0}/{data.min_relevant_required ?? 3} releváns audit áll rendelkezésre. Ez az előzetes ellenőrzés 0 kredit.</p><Link href="/dashboard/video-audit">Releváns diagnózis készítése<ArrowRight aria-hidden="true" /></Link></div></div>}
      {generating && !result && <div className="wv-channel-generating"><LoadingScreen steps={LOADING_STEPS.channelAudit} /></div>}
      {result?.from_paid_result && <div className="wv-channel-saved-result"><CheckCircle2 aria-hidden="true" /><div><strong>{result.cache_status === 'fresh' ? 'Friss mentett elemzés' : 'Korábbi mentett elemzés'}</strong><span>Megnyitva új kredit levonása nélkül{result.last_analyzed_at ? ` · ${new Date(result.last_analyzed_at).toLocaleDateString('hu-HU')}` : ''}</span></div></div>}
      {result && <div className="wv-channel-direction-grid">{result.suggestions.map((suggestion, index) => <article key={`${suggestion.topic}-${index}`}><span>{String(index + 1).padStart(2, '0')}</span><h3>{suggestion.topic}</h3><p>{suggestion.reasoning}</p><Link href={`/dashboard/opportunities?niche=${encodeURIComponent(suggestion.topic)}`}><Compass aria-hidden="true" />Validálás a Felfedezésben<ArrowUpRight aria-hidden="true" /></Link></article>)}</div>}
      {!result && data.can_generate_suggestions && !generating && <div className="wv-channel-direction-empty"><Sparkles aria-hidden="true" /><div><h3>A csatornaminta készen áll.</h3><p>A kérés kreditmegerősítés után indul; változatlan mintánál a mentett eredmény újra felhasználható.</p></div></div>}
    </section>
  )
}

export default function ChannelAuditPage() {
  const { refreshCredits } = useCreditBalance()
  const searchParams = useSearchParams()
  const { creatorLane } = useCreatorOS()
  const laneCopy = CHANNEL_AUDIT_LANE_COPY[creatorLane]
  const [data, setData] = useState<ChannelAuditData | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [suggestionError, setSuggestionError] = useState<string | null>(null)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [suggestionsResult, setSuggestionsResult] = useState<SuggestionsResult | null>(null)
  const [generating, setGenerating] = useState(false)
  const [creditCheck, setCreditCheck] = useState<UsageCheckResult | null>(null)
  const [pendingForceRefresh, setPendingForceRefresh] = useState(false)
  const [channelAnalytics, setChannelAnalytics] = useState<ChannelAnalyticsSummary | null>(null)
  const [channelConnected, setChannelConnected] = useState<boolean | null>(null)
  const [channelProfile, setChannelProfile] = useState<ChannelProfile | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)

  useEffect(() => {
    void loadChannelAnalytics()
    void load()
    const oauthStatus = searchParams.get('youtube_oauth')
    if (oauthStatus === 'error') setConnectionError(`A csatorna-összekapcsolás sikertelen (${searchParams.get('youtube_oauth_message') || 'ismeretlen hiba'}). Próbáld újra.`)
    const paidResultId = searchParams.get('paidResultId')
    if (paidResultId) void loadPaidResult(paidResultId)
  }, [])

  async function loadPaidResult(id: string) {
    setGenerating(true)
    setSuggestionError(null)
    try {
      const response = await fetch(`/api/channel-audit?paidResultId=${id}`)
      const body = await response.json()
      if (!response.ok || body.error) setSuggestionError(body.error || 'A mentett javaslat nem található.')
      else setSuggestionsResult(body)
    } catch { setSuggestionError('Hiba a mentett javaslat betöltésekor.') }
    finally { setGenerating(false) }
  }

  async function loadChannelAnalytics() {
    try {
      const response = await fetch('/api/youtube/analytics')
      if (response.status === 404) { setChannelConnected(false); setChannelProfile(null); return }
      const body = await response.json()
      if (!response.ok) { setChannelConnected(false); setChannelProfile(null); return }
      setChannelProfile(body.channel_profile || null)
      setChannelAnalytics(body.analytics_available ? body : null)
      setChannelConnected(Boolean(body.analytics_available))
    } catch { setChannelConnected(false); setChannelProfile(null) }
  }

  async function load() {
    setLoading(true)
    setLoadError(null)
    try {
      const response = await fetch('/api/channel-audit')
      const body = await response.json()
      if (!response.ok) { setLoadError(body.error || 'A Channel Audit adatok betöltése sikertelen.'); return }
      setData(body)
      if (body.niche_review_required) setSuggestionsResult(null)
      else if (body.active_channel_id) {
        try { const saved = sessionStorage.getItem(`${SUGGESTIONS_STATE_KEY}_${body.active_channel_id}`); setSuggestionsResult(saved ? JSON.parse(saved) : null) }
        catch { setSuggestionsResult(null) }
      }
    } catch { setLoadError('Kapcsolati hiba. Próbáld újra később.') }
    finally { setLoading(false) }
  }

  function connectChannel() {
    setConnectionError(null)
    setConnecting(true)
    window.location.href = '/api/youtube/connect'
  }

  async function disconnectChannel() {
    setDisconnecting(true)
    try {
      const response = await fetch('/api/youtube/disconnect', { method: 'POST' })
      if (response.ok) { setChannelConnected(false); setChannelAnalytics(null); setConfirmDisconnect(false) }
      else setConnectionError('A kapcsolat bontása sikertelen.')
    } catch { setConnectionError('Kapcsolati hiba a YouTube-kapcsolat bontása közben.') }
    finally { setDisconnecting(false) }
  }

  async function requestSuggestions(forceRefresh = false) {
    setSuggestionError(null)
    if (data?.niche_review_required) { setSuggestionError('Előbb erősítsd meg a Creator Profile niche-t az új csatornához. Ez az ellenőrzés 0 kredit.'); return }
    if (!data?.can_generate_suggestions) {
      const relevant = data?.relevant_audit_count ?? 0
      const required = data?.min_relevant_required ?? 3
      setSuggestionError(`A javaslatokhoz legalább ${required} niche-releváns Videódiagnózis szükséges. Jelenleg ${relevant}/${required} áll rendelkezésre. Ez az ellenőrzés ingyenes.`)
      return
    }
    try {
      const credits = await refreshCredits()
      if (!credits) throw new Error('credit_balance_unavailable')
      const balance = credits.balance
      setPendingForceRefresh(forceRefresh)
      setCreditCheck({
        feature: 'Channel Audit — következő videók', cost: CHANNEL_AUDIT_COST, currency: 'credit', currentCredits: balance,
        remainingCreditsAfterRun: balance - CHANNEL_AUDIT_COST, requiresConfirmation: true, canRun: balance >= CHANNEL_AUDIT_COST,
        reason: balance >= CHANNEL_AUDIT_COST ? undefined : 'insufficient_credits',
        message: balance >= CHANNEL_AUDIT_COST ? (forceRefresh ? 'Új, friss javaslatot kérünk — ez új kreditet használ.' : '10 videótéma-javaslat a valós audit-előzmény mintázatai alapján. Változatlan mintánál nem vonunk le új kreditet.') : 'Ehhez nincs elég kredited.',
      })
    } catch { setSuggestionError('Kapcsolati hiba a kreditegyenleg ellenőrzésekor.') }
  }

  async function confirmSuggestions() {
    setCreditCheck(null)
    setGenerating(true)
    try {
      const response = await fetch('/api/channel-audit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force_refresh: pendingForceRefresh }) })
      const body = await response.json()
      if (!response.ok) { setSuggestionError(body.error || 'Generálás sikertelen.'); return }
      setSuggestionsResult(body)
      publishCreditMutationCompleted('/api/channel-audit', body)
      try { if (data?.active_channel_id) sessionStorage.setItem(`${SUGGESTIONS_STATE_KEY}_${data.active_channel_id}`, JSON.stringify(body)) } catch {}
    } catch { setSuggestionError('Kapcsolati hiba a tartalomirányok készítésekor.') }
    finally { setGenerating(false); setPendingForceRefresh(false) }
  }

  const focus = deriveChannelAuditFocus({
    loading, loadError: Boolean(loadError), generating, suggestionError: Boolean(suggestionError), nicheReviewRequired: Boolean(data?.niche_review_required),
    channelConnected, hasChannelProfile: Boolean(channelProfile), hasEnoughData: Boolean(data?.has_enough_data), canGenerateSuggestions: Boolean(data?.can_generate_suggestions),
    auditCount: data?.audit_count ?? 0, minimumAudits: data?.min_required ?? 3, relevantAuditCount: data?.relevant_audit_count ?? 0,
    minimumRelevantAudits: data?.min_relevant_required ?? 3, suggestionCount: suggestionsResult?.suggestions.length ?? 0,
  })

  return (
    <div className="wv-destination wv-channel-audit" data-creator-lane={creatorLane}>
      {creditCheck && <CreditConfirmModal check={creditCheck} onConfirm={confirmSuggestions} onCancel={() => setCreditCheck(null)} loading={generating} />}
      <header className="wv-page-heading"><div><span className="wv-eyebrow">Csatornaaudit</span><h1>A csatornád, döntési képként.</h1></div><span className="wv-heading-meta">{laneCopy.lens}<br />aktuális alkotói fókusz</span></header>
      <section className="wv-channel-audit-stage" aria-label="Csatornaidentitás és következő döntés"><ChannelIdentity profile={channelProfile} /><ChannelFocusCard focus={focus} connecting={connecting} onConnect={connectChannel} onRetry={() => void load()} onRequest={() => void requestSuggestions()} /></section>
      <p className="wv-channel-lane-intent"><Sparkles aria-hidden="true" /><span><strong>{laneCopy.headline}</strong>{laneCopy.support}</span></p>
      {data?.niche_review_required && <div className="wv-channel-safety"><ShieldCheck aria-hidden="true" /><div><strong>Új csatornához niche-döntés szükséges.</strong><p>A profil niche-ét nem módosítottuk automatikusan, és a döntésig nem indul fizetős témagenerálás.</p></div><Link href="/dashboard/profile">Döntés megnyitása<ArrowRight aria-hidden="true" /></Link></div>}
      {(data?.legacy_unassigned_audit_count || 0) > 0 && <p className="wv-channel-legacy-note"><CircleAlert aria-hidden="true" />{data!.legacy_unassigned_audit_count} korábbi, csatornához nem rendelhető audit nem része ennek az összesítésnek.</p>}
      {data && !loadError && <DiagnosticProfile data={data} />}
      <AnalyticsPulse analytics={channelAnalytics} connected={channelConnected} error={connectionError} disconnecting={disconnecting} confirmDisconnect={confirmDisconnect} onConnect={connectChannel} onAskDisconnect={() => setConfirmDisconnect(true)} onCancelDisconnect={() => setConfirmDisconnect(false)} onDisconnect={() => void disconnectChannel()} />
      {data?.has_enough_data && <SuggestionStudio data={data} result={suggestionsResult} generating={generating} error={suggestionError} onRequest={() => void requestSuggestions()} onRefresh={() => void requestSuggestions(true)} />}
      {!data?.has_enough_data && !loading && !loadError && <section className="wv-channel-next-rail"><BarChart3 aria-hidden="true" /><div><span className="wv-eyebrow">A profil innen épül</span><h2>Minden releváns videódiagnózis tisztább csatornaképet ad.</h2></div><Link href="/dashboard/video-audit" className="wv-primary-action">Következő diagnózis<ArrowRight aria-hidden="true" /></Link></section>}
      <nav className="wv-channel-tool-rail" aria-label="Kapcsolódó Creator OS-terek"><span><Activity aria-hidden="true" /><strong>Diagnózisból következő lépés</strong></span><Link href="/dashboard/video-audit"><Gauge aria-hidden="true" />Videódiagnózis</Link><Link href="/dashboard/discover"><Compass aria-hidden="true" />Felfedezés</Link><Link href="/dashboard/growth"><BarChart3 aria-hidden="true" />Növekedés</Link></nav>
    </div>
  )
}
