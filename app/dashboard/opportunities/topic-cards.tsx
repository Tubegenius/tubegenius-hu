'use client'

// Extracted out of app/dashboard/opportunities/page.tsx (verbatim, no
// behavior change) specifically so TopicCard/DiscoveryLaneCard can be
// exported for direct RTL component-interaction tests (see
// tests/opportunity-evidence-snapshot-component-interaction.test.tsx)
// WITHOUT adding an extra named export to page.tsx itself -- a Next.js App
// Router page.tsx file may only export the small fixed set of names Next's
// own page-type generator recognizes (default, metadata, config,
// generateStaticParams, ...); any other named export makes
// `.next/types/app/.../page.ts` fail to type-check. A plain component module
// like this one has no such restriction. page.tsx imports TopicCard,
// DiscoveryLaneCard, ExtendedTopic and isDiscoveryLane back from here and
// renders them exactly as before the extraction.
import { useId, useRef, useState } from 'react'
import { SCORE_LABELS } from '@/types'
import type { OpportunityTopic, RejectReason, SimilarVideo } from '@/types'
import { scoreColor as getScoreColor, scoreLabel, scoreLabelColor } from '@/lib/score-utils'
import CreditConfirmModal from '@/components/CreditConfirmModal'
import type { UsageCheckResult } from '@/lib/usage-protection'
import { polishHungarianText } from '@/lib/hungarian-output-polish'
import { useFocusTrap } from '@/lib/useFocusTrap'
import { saveTopicToMemory } from '@/lib/creator-lane/memory-save-client'
import { normalizeTopicKey } from '@/lib/creator-lane/topic-identity'
import { useCreditBalance } from '@/components/credits/CreditBalanceContext'
import { publishCreditMutationCompleted } from '@/lib/credit-balance-events'
import { classifyEvidenceSnapshotFailure } from '@/lib/opportunity-evidence/client-error-policy'
import { REJECT_REASONS } from '@/types'

// ── Score komponensek ─────────────────────────────────────────

function CompetitionScoreBar({ value, weight }: { value: number; weight: number }) {
  const displayValue = 100 - value
  const barColor = getScoreColor(displayValue)
  const label = displayValue >= 75 ? 'Kiváló' : displayValue >= 60 ? 'Jó' : displayValue >= 40 ? 'Közepes' : 'Telített'
  return (
    <div className="flex items-center gap-3">
      <span className="text-text-muted text-xs w-36 flex-shrink-0">Szabad Piac</span>
      <div className="flex-1 h-1.5 bg-surface-2 rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${displayValue}%`, background: barColor }} />
      </div>
      <span className="text-xs font-medium" style={{ color: barColor }}>{displayValue}</span>
      <span className="text-xs ml-1" style={{ color: barColor }}>{label}</span>
      <span className="text-text-muted text-xs w-8 text-right">{weight}%</span>
    </div>
  )
}

function TrendSourceBadge({ sourceType }: { sourceType?: string }) {
  if (!sourceType) return null
  const configs: Record<string, { label: string; color: string; bg: string }> = {
    serper_youtube:        { label: '🔥 Erős trendjel', color: '#22C55E', bg: 'rgba(34,197,94,0.1)' },
    serper_only:           { label: '⚡ Korai lehetőség', color: '#3B82F6', bg: 'rgba(59,130,246,0.1)' },
    youtube_multi_creator: { label: '📺 YouTube validált', color: '#F59E0B', bg: 'rgba(245,158,11,0.1)' },
    weak_signal:           { label: '⚠ Gyenge jel', color: '#EF4444', bg: 'rgba(239,68,68,0.1)' },
  }
  const cfg = configs[sourceType] || configs.weak_signal
  return (
    <span className="text-xs px-2 py-0.5 rounded-full font-semibold flex-shrink-0"
      style={{ background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.color}30` }}>
      {cfg.label}
    </span>
  )
}

function ScoreBar({ label, value, weight }: { label: string; value: number; weight: number }) {
  const barColor = getScoreColor(value)
  return (
    <div className="flex items-center gap-3">
      <span className="text-text-muted text-xs w-36 flex-shrink-0">{label}</span>
      <div className="flex-1 h-1.5 bg-surface-2 rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${value}%`, background: barColor }} />
      </div>
      <span className="text-xs w-6 text-right font-medium" style={{ color: barColor }}>{value}</span>
      <span className="text-xs w-14 text-right font-medium" style={{ color: scoreLabelColor(value) }}>{scoreLabel(value)}</span>
      <span className="text-text-muted text-xs w-8 text-right">{weight}%</span>
    </div>
  )
}

function RejectReasonModal({ onSelect, onClose }: { onSelect: (reason: RejectReason) => void; onClose: () => void }) {
  const titleId = useId()
  const containerRef = useFocusTrap(onClose)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(8,11,18,0.7)' }} onClick={onClose}>
      <div ref={containerRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="rounded-2xl p-5 max-w-sm w-full" style={{ background: '#0F1420', border: '1px solid rgba(255,255,255,0.08)' }} onClick={e => e.stopPropagation()}>
        <h3 id={titleId} className="font-semibold mb-1" style={{ color: '#F8FAFC' }}>Miért nem jó ez a téma?</h3>
        <p className="text-xs mb-4" style={{ color: '#CBD5E1' }}>Ez segít, hogy a jövőben jobb ajánlásokat adjunk.</p>
        <div className="space-y-1.5">
          {REJECT_REASONS.map(reason => (
            <button key={reason} onClick={() => onSelect(reason)}
              className="w-full text-left text-sm px-3 py-2 rounded-lg transition-all hover:opacity-80"
              style={{ background: '#121826', border: '1px solid rgba(255,255,255,0.08)', color: '#F8FAFC' }}>
              {reason}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

const confidenceLabelMap: Record<string, { label: string; color: string }> = {
  magas: { label: 'Magas megbízhatóság', color: '#22C55E' },
  közepes: { label: 'Közepes megbízhatóság', color: '#F59E0B' },
  alacsony: { label: 'Alacsony megbízhatóság', color: '#EF4444' },
  nagyon_alacsony: { label: 'Nagyon alacsony megbízhatóság', color: '#EF4444' },
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return n.toString()
}

function cleanText(value: string | null | undefined): string {
  return value ? polishHungarianText(value) : ''
}

function cleanTextList(values: string[] | null | undefined): string[] {
  return (values || []).map(value => polishHungarianText(value))
}

// ── Evidence Video komponens ──────────────────────────────────

function EvidenceVideo({ video }: { video: SimilarVideo }) {
  const [copied, setCopied] = useState(false)

  function handleCopy(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    navigator.clipboard.writeText(video.url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="flex items-center gap-2 rounded-lg p-2 transition-all hover:bg-surface-2"
      style={{ background: '#0A0E18', border: '1px solid rgba(255,255,255,0.06)' }}>
      <a href={video.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 flex-1 min-w-0">
        <div className="w-16 h-10 rounded overflow-hidden flex-shrink-0 bg-surface-2">
          {video.thumbnail_url && <img src={video.thumbnail_url} alt="" className="w-full h-full object-cover" />}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium line-clamp-1" style={{ color: '#F8FAFC' }}>{video.title}</p>
          <p className="text-xs" style={{ color: '#94A3B8' }}>{video.channel_title} · 👁 {formatNumber(video.view_count)}</p>
        </div>
      </a>
      <button onClick={handleCopy} title="Link másolása"
        className="text-xs px-2 py-1 rounded flex-shrink-0 transition-all"
        style={{ background: copied ? 'rgba(34,197,94,0.1)' : '#121826', border: '1px solid rgba(255,255,255,0.08)', color: copied ? '#22C55E' : '#CBD5E1' }}>
        {copied ? '✓' : '📋'}
      </button>
    </div>
  )
}

// ── Web forrás komponens ──────────────────────────────────────

interface WebSource {
  title: string
  url: string
  snippet?: string
  date?: string
  source?: string
}

function WebSourceItem({ source }: { source: WebSource }) {
  const isSearchFallback = source.url && source.url.includes('google.com/search')
  return (
    <a href={source.url} target="_blank" rel="noopener noreferrer"
      className="flex items-start gap-2 rounded-lg p-2 transition-all hover:bg-surface-2"
      style={{ background: '#0A0E18', border: '1px solid rgba(255,255,255,0.06)' }}>
      <span className="text-xs mt-0.5 flex-shrink-0">{isSearchFallback ? '🔍' : '🔗'}</span>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium line-clamp-2" style={{ color: '#F8FAFC' }}>{source.title}</p>
        <div className="flex items-center gap-2 mt-0.5">
          {source.source && <p className="text-xs" style={{ color: '#94A3B8' }}>{source.source}</p>}
          {source.date && <p className="text-xs" style={{ color: '#94A3B8' }}>· {source.date}</p>}
        </div>
      </div>
    </a>
  )
}

// ── TopicCard ─────────────────────────────────────────────────

type ReadyStatus = 'ready' | 'watch' | 'research' | 'rejected'

export type ExtendedTopic = OpportunityTopic & {
  needs_explanation?: boolean
  trend_source_type?: string
  trend_confidence?: string
  trend_source_label?: string
  hook_suggestion?: string
  market_type_label?: string
  expanded_from_query?: string
  expansion_type?: string
  expansion_intent?: string
  story_potential_score?: number
  recommended_angle?: string
  recommended_format?: string
  hook_pattern?: string
  web_sources?: WebSource[]
  ready_to_produce_status?: ReadyStatus
  evidence_strength?: 'strong' | 'medium' | 'weak' | 'none'
  validation_reason?: string
  recommended_next_action?: 'generate_package' | 'deep_refresh' | 'open_similar_videos' | 'refine_topic' | 'reject'
  data_limitations?: string[]
  evidence_match_score?: number
  decision_score?: number
  risk_flags?: string[]
  validation_summary?: {
    validation_type: string
    web_validation_score: number
    video_validation_score: number
    content_gap_score: number
    freshness_score: number
    topic_consistency_score: number
    final_decision: string
    explanation: string
    label: string
    evidence_strength?: 'strong' | 'medium' | 'weak' | 'none'
    validation_reason?: string
    recommended_next_action?: 'generate_package' | 'deep_refresh' | 'open_similar_videos' | 'refine_topic' | 'reject'
    data_limitations?: string[]
    cta_primary: { text: string; action: string }
    cta_secondary?: { text: string; action: string }
  }
}

function evidenceStrengthMeta(strength?: string): { label: string; color: string; bg: string } {
  if (strength === 'strong') return { label: 'Erős bizonyíték', color: '#22C55E', bg: 'rgba(34,197,94,0.1)' }
  if (strength === 'medium') return { label: 'Közepes bizonyíték', color: '#3B82F6', bg: 'rgba(59,130,246,0.1)' }
  if (strength === 'weak') return { label: 'Gyenge jel', color: '#F59E0B', bg: 'rgba(245,158,11,0.1)' }
  return { label: 'Nincs elég bizonyíték', color: '#94A3B8', bg: 'rgba(148,163,184,0.1)' }
}

function nextActionLabel(action?: string): string {
  if (action === 'generate_package') return 'Következő lépés: videócsomag'
  if (action === 'deep_refresh') return 'Következő lépés: mély frissítés'
  if (action === 'open_similar_videos') return 'Következő lépés: hasonló videók'
  if (action === 'refine_topic') return 'Következő lépés: téma szűkítése'
  if (action === 'reject') return 'Következő lépés: elutasítás'
  return 'Következő lépés: ellenőrzés'
}
function getReadyStatus(topic: ExtendedTopic): { status: ReadyStatus; label: string; color: string; bg: string } {
  const backendStatus = topic.ready_to_produce_status
  if (backendStatus === 'ready') {
    return { status: 'ready', label: topic.ready_to_produce_label || 'Gyártható ma', color: '#22C55E', bg: 'rgba(34,197,94,0.1)' }
  }
  if (backendStatus === 'watch') {
    return { status: 'watch', label: topic.ready_to_produce_label || 'Korai lehetőség', color: '#F59E0B', bg: 'rgba(245,158,11,0.1)' }
  }
  if (backendStatus === 'rejected') {
    return { status: 'rejected', label: topic.ready_to_produce_label || 'Nem ajánlott', color: '#EF4444', bg: 'rgba(239,68,68,0.1)' }
  }
  if (backendStatus === 'research') {
    return { status: 'research', label: topic.ready_to_produce_label || 'Kutatás kell', color: '#CBD5E1', bg: 'rgba(139,155,180,0.08)' }
  }

  const hasWeb = !!topic.web_sources?.length
  const hasVideo = !!topic.evidence_videos?.length
  const score = topic.opportunity_score || 0

  if ((topic.trend_source_type === 'serper_youtube' && hasWeb && hasVideo && score >= 70) ||
      (topic.confidence === 'magas' && (hasWeb || hasVideo) && score >= 75)) {
    return { status: 'ready', label: 'Gyártható ma', color: '#22C55E', bg: 'rgba(34,197,94,0.1)' }
  }
  if ((hasWeb || hasVideo) && score >= 55) {
    return { status: 'watch', label: 'Korai lehetőség', color: '#F59E0B', bg: 'rgba(245,158,11,0.1)' }
  }
  return { status: 'research', label: 'Kutatás kell', color: '#CBD5E1', bg: 'rgba(139,155,180,0.08)' }
}

function buildOpportunityPackageUrl(topic: ExtendedTopic, displayTitle: string) {
  const params = new URLSearchParams({
    topic: displayTitle,
    keyword: topic.keyword || '',
    opportunity_id: topic.id,
    source_context: 'opportunity_engine',
  })
  return `/dashboard/video-package?${params.toString()}`
}

function storeOpportunityPackageContext(topic: ExtendedTopic, displayTitle: string) {
  const ready = getReadyStatus(topic)
  const payload = {
    id: topic.id,
    title: displayTitle,
    keyword: topic.keyword || '',
    description: topic.description,
    confidence: topic.confidence,
    trend_source_type: topic.trend_source_type,
    trend_source_label: topic.trend_source_label,
    ready_to_produce_status: ready.status,
    ready_to_produce_label: ready.label,
    evidence_match_score: topic.evidence_match_score || null,
    risk_flags: topic.risk_flags || [],
    score_breakdown: topic.score_breakdown,
    opportunity_score: topic.opportunity_score,
    hook_suggestion: topic.hook_suggestion,
    topic_intelligence: {
      expanded_from_query: topic.expanded_from_query,
      expansion_type: topic.expansion_type,
      story_potential_score: topic.story_potential_score,
      recommended_angle: topic.recommended_angle,
      recommended_format: topic.recommended_format,
      hook_pattern: topic.hook_pattern,
    },
    web_sources: topic.web_sources || [],
    evidence_videos: topic.evidence_videos || [],
  }
  sessionStorage.setItem(`willviral_opportunity_package_${topic.id}`, JSON.stringify(payload))
}

// Exported for OpportunitiesPage's render tree AND for direct RTL
// component-interaction tests -- see
// tests/opportunity-evidence-snapshot-component-interaction.test.tsx.
export function TopicCard({ topic, index, onReplace, hasPool, onSimilarResult, replacing, alreadySavedTopics, onTopicSaved, saveGateReady, paidResultId }: {
  topic: ExtendedTopic
  index: number
  onReplace: (index: number) => void
  hasPool: boolean
  onSimilarResult: (index: number, result: { title: string; description: string }) => void
  replacing: boolean
  // A "már elmentve" igazság a szülőben (OpportunitiesPage) él, nem itt —
  // ez az EGYETLEN módja annak, hogy két duplikált kártya (ugyanaz a cím
  // két helyen a listában) ugyanazt a mentett állapotot lássa, és hogy egy
  // korábbi munkamenetben/oldalfrissítés előtt elmentett téma is eleve
  // "Mentve"-ként jelenjen meg (ld. lib/creator-lane/memory-save-client.ts
  // fetchSavedStatusForTopics()).
  alreadySavedTopics: Set<string>
  onTopicSaved: (topicKey: string) => void
  // A szülő read-only "korábban elmentve" batch-lookupjának állapota
  // (loading/ready/error) — amíg ez nem 'ready', a mentés-gomb zárva marad,
  // hogy egy még folyamatban lévő vagy sikertelen lookup ALATT sose
  // lehessen egy már elmentett témát véletlenül újra POST-olni.
  saveGateReady: boolean
  // The stored id of the result set this topic came from -- null when
  // there is none (e.g. a live candidate preview with no paid_results
  // row). See lib/opportunity-evidence/evidence-service.ts: this is the
  // ONLY evidence-related thing sent to the server for save/create calls.
  paidResultId: string | null
}) {
  const { refreshCredits } = useCreditBalance()
  const [expanded, setExpanded] = useState(false)
  const [packageError, setPackageError] = useState<{ kind: 'blocked' | 'degradable'; message: string } | null>(null)
  const [packageLoading, setPackageLoading] = useState(false)
  // Melyik pontos témacím ("identitás") ment/hibázott éppen — NEM egy sima
  // boolean, mert a cím a komponens élettartama alatt megváltozhat
  // (confirmShowSimilar -> setDisplayTitle "Mutass hasonlót" után). Egy
  // boolean "saved"/"saving" state a régi témára befejeződő mentést a
  // KÖZBEN megjelenő új témára vetítette volna rá (vagy fordítva: egy
  // folyamatban lévő régi mentés blokkolta volna az új téma mentését).
  const [savingTopicKey, setSavingTopicKey] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<{ topicKey: string; message: string } | null>(null)
  // Kártyánkénti re-entrancy őr, DE témaidentitásonként (Set, nem boolean) —
  // "egy adott téma mentése közben ne lehessen ugyanarra új mentést
  // indítani", DE "az új téma [cím-váltás után] külön elmenthető legyen"
  // még akkor is, ha a régi téma mentése a háttérben még fut.
  const saveInFlightKeysRef = useRef<Set<string>>(new Set())
  const [status, setStatus] = useState<'active' | 'rejected'>('active')
  const [noMorePool, setNoMorePool] = useState(false)
  const [showReasonModal, setShowReasonModal] = useState(false)
  const [similarLoading, setSimilarLoading] = useState(false)
  const [similarError, setSimilarError] = useState<string | null>(null)
  const [similarCreditCheck, setSimilarCreditCheck] = useState<UsageCheckResult | null>(null)
  const [displayTitle, setDisplayTitle] = useState(topic.title)
  const [displayDescription, setDisplayDescription] = useState(cleanText(topic.description))
  const similarInFlightRef = useRef(false)
  const scoreColorVal = getScoreColor(topic.opportunity_score)

  // Derivált, a jelenleg megjelenített cím ("identitás") szerint — sose a
  // komponens teljes élettartamára érvényes, statikus boolean. Ugyanazt a
  // normalizeTopicKey()-t használja, mint a handleSave() és a szülő
  // lookup-ja, hogy egy vezető/záró szóköz sose okozzon hamis "nincs
  // elmentve" állapotot egy ténylegesen (szerver-trimelt) már mentett
  // témánál.
  const currentTopicKey = normalizeTopicKey(displayTitle)
  const isSaved = alreadySavedTopics.has(currentTopicKey)
  const isSavingCurrent = savingTopicKey === currentTopicKey
  const currentSaveError = saveError && saveError.topicKey === currentTopicKey ? saveError.message : null

  const hasVideos = topic.evidence_videos && topic.evidence_videos.length > 0
  const hasWebSources = topic.web_sources && topic.web_sources.length > 0
  const readyStatus = getReadyStatus(topic)
  const packageUrl = buildOpportunityPackageUrl(topic, displayTitle)
  const canCreatePackage = readyStatus.status === 'ready' || readyStatus.status === 'watch'
  const decisionScore = topic.decision_score || topic.evidence_match_score

  // Direct-create ("Készíts csomagot") path -- server-side evidence
  // snapshot write BEFORE navigating, per the evidence-snapshot contract
  // (lib/opportunity-evidence/evidence-service.ts). Failure handling is
  // NOT a formality:
  //   - 401/403 (auth/ownership): NEVER auto-navigate with evidence implied
  //     -- a blocking error is shown, the click is a dead end until retried.
  //   - anything else (404/500/network) or no paidResultId at all: an
  //     explicit "Folytatás bizonyíték nélkül" choice is offered -- the
  //     user decides, the page never silently pretends the evidence
  //     attached when it didn't.
  async function handleCreatePackageClick(event: React.MouseEvent) {
    event.preventDefault()
    setPackageError(null)
    if (!paidResultId) {
      // Sose navigáljunk csendben bizonyíték nélkül -- ez a döntés (2026-09-29
      // QA) kizárólag a "Folytatás bizonyíték nélkül" gombon, explicit
      // user-kattintásra hozható meg, ugyanúgy, mint egy sikertelen
      // evidence-snapshot POST után. Hiányzó paidResultId nem jelenti
      // automatikusan, hogy nincs bizonyíték -- lehet, hogy csak a szülő
      // állapot (pl. egy imént megnyitott korábbi eredmény) nem kapta meg
      // helyesen -- ezért ez a fail-closed alapeset.
      setPackageError({ kind: 'degradable', message: 'Nincs elérhető szerveroldali bizonyíték ehhez az ajánláshoz.' })
      return
    }
    setPackageLoading(true)
    try {
      const res = await fetch('/api/opportunity/evidence-snapshot', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paid_result_id: paidResultId, topic_id: topic.id }),
      })
      if (res.ok) {
        const data = await res.json()
        window.location.href = `/dashboard/video-package?video_idea_id=${encodeURIComponent(data.video_idea_id)}&topic=${encodeURIComponent(displayTitle)}&keyword=${encodeURIComponent(topic.keyword || '')}&source_context=opportunity_engine`
        return
      }
      if (classifyEvidenceSnapshotFailure(res.status) === 'blocked') {
        setPackageError({ kind: 'blocked', message: 'A bizonyíték mentése nem sikerült (bejelentkezés vagy jogosultság). Frissítsd az oldalt és próbáld újra.' })
        return
      }
      setPackageError({ kind: 'degradable', message: 'A bizonyíték mentése sikertelen volt.' })
    } catch {
      setPackageError({ kind: 'degradable', message: 'Kapcsolati hiba a bizonyíték mentésekor.' })
    } finally {
      setPackageLoading(false)
    }
  }

  function continueWithoutEvidence() {
    storeOpportunityPackageContext(topic, displayTitle)
    window.location.href = packageUrl
  }

  // Kizárólag explicit user-kattintásból hívódik (a gomb onClick-jéből) — sose
  // mountkor vagy más effektusból. Pontosan egy POST /api/memory hívást indít
  // (a body-t és a hibaüzenet-leképezést a lib/creator-lane/memory-save-client
  // tesztelt, tiszta függvényei adják). A mentendő téma pontos identitását
  // (topicKey = normalizeTopicKey(displayTitle), UGYANAZ a függvény, mint a
  // szülő lookup-ja és a szerver btrim()-je) a hívás INDULÁSAKOR rögzítjük —
  // minden ezt követő state-frissítés kizárólag EHHEZ az identitáshoz kötött,
  // függetlenül attól, hogy a kártyán közben megváltozik-e a megjelenített
  // cím (confirmShowSimilar). saveGateReady === false alatt (a szülő
  // "korábban elmentve" lookupja még fut vagy hibázott) a mentés nem
  // indulhat el — sose engedjük POST-olni egy olyan témát, aminek a
  // "már mentve" állapotát még nem ismerjük biztosan.
  async function handleSave() {
    const topicKey = normalizeTopicKey(displayTitle)
    if (!saveGateReady || !topicKey || saveInFlightKeysRef.current.has(topicKey) || alreadySavedTopics.has(topicKey)) return
    saveInFlightKeysRef.current.add(topicKey)
    setSavingTopicKey(topicKey)
    setSaveError(prev => (prev && prev.topicKey === topicKey ? null : prev))
    try {
      const result = await saveTopicToMemory({
        topic: topicKey,
        searchKeyword: topic.keyword,
        opportunityScore: topic.opportunity_score,
        platform: topic.platform,
        paidResultId,
        topicId: topic.id,
      })
      if (result.status === 'error') {
        setSaveError({ topicKey, message: result.message })
        return
      }
      if (result.status === 'skipped') {
        // A szerver ({skipped:true}) NEM hozott létre/frissített Memory-
        // rekordot (pl. túl hosszú, "#" jelet tartalmazó cím) — ez NEM siker,
        // a gomb marad "nincs mentve", nincs "Mentve" állapot és nincs
        // /api/feedback hívás sem (az csak valódi mentés után indulhat).
        setSaveError({ topicKey, message: 'Ez a téma nem menthető el ebben a formában.' })
        return
      }
      // Csak valódi, szerver által visszaigazolt mentés után jelöljük "már
      // elmentve"-nek — a szülő komponens Set-jét frissítjük (NEM helyi
      // state-et), hogy minden ugyanezt a témát mutató (akár duplikált)
      // kártya azonnal ugyanazt az állapotot lássa.
      onTopicSaved(topicKey)
      // A feedback-naplózás másodlagos telemetria — a mentés sikerét/UI
      // "Mentve" állapotát sose blokkolja vagy buktassa el, ha ez elhasal, és
      // KIZÁRÓLAG a fenti valódi 'saved' ágból indulhat (skipped/error esetén
      // sose fut le).
      fetch('/api/feedback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: topicKey, feedback_type: 'save', opportunity_score: topic.opportunity_score, niche_cluster: topic.niche_cluster }),
      }).catch(() => {})
    } finally {
      saveInFlightKeysRef.current.delete(topicKey)
      setSavingTopicKey(prev => (prev === topicKey ? null : prev))
    }
  }

  async function submitReject(reason: RejectReason) {
    setShowReasonModal(false)
    await fetch('/api/memory', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: displayTitle, search_keyword: topic.keyword, state: 'rejected',
        opportunity_score: topic.opportunity_score, platform: topic.platform,
      }),
    })
    await fetch('/api/feedback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: displayTitle, feedback_type: 'reject', reason,
        opportunity_score: topic.opportunity_score, niche_cluster: topic.niche_cluster,
        source_videos: topic.evidence_videos?.map(v => v.video_id) || [],
      }),
    })
    setStatus('rejected')
  }

  // Előbb megnézzük a kreditegyenleget és megerősítést kérünk — a tényleges
  // hívás (confirmShowSimilar) csak jóváhagyás után indul. A szerver ettől
  // függetlenül input_hash alapján úgyis ingyenesen visszaadja, ha a user
  // ugyanerre a témára korábban már fizetett — ez csak a UI-oldali
  // visszaigazolás, amit eddig teljesen hiányzott.
  async function handleShowSimilar() {
    if (similarInFlightRef.current) return
    similarInFlightRef.current = true
    setSimilarError(null)
    try {
      const credits = await refreshCredits()
      if (!credits) throw new Error('credit_balance_unavailable')
      const balance = credits.balance
      const cost = 1
      setSimilarCreditCheck({
        feature: 'Mutass hasonlót',
        cost,
        currency: 'credit',
        currentCredits: balance,
        remainingCreditsAfterRun: balance - cost,
        requiresConfirmation: true,
        canRun: balance >= cost,
        reason: balance >= cost ? undefined : 'insufficient_credits',
        message: balance >= cost
          ? 'Egy másik feldolgozási szöget kérünk ugyanerre a témára. Ha korábban már lekérted ugyanezt, nem vonunk le új kreditet.'
          : 'Ehhez nincs elég kredited.',
      })
    } catch {
      setSimilarError('Kapcsolati hiba — próbáld újra.')
      similarInFlightRef.current = false
    }
  }

  async function confirmShowSimilar() {
    setSimilarCreditCheck(null)
    setSimilarLoading(true)
    setSimilarError(null)
    try {
      const res = await fetch('/api/opportunity-similar', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          original_title: displayTitle, keyword: topic.keyword, niche: topic.niche,
          score_breakdown: topic.score_breakdown, evidence_videos: topic.evidence_videos,
        }),
      })
      const data = await res.json()
      if (res.ok) {
        publishCreditMutationCompleted('/api/opportunity-similar', data)
        setDisplayTitle(data.title)
        setDisplayDescription(cleanText(data.description))
        onSimilarResult(index, { title: data.title, description: data.description })
        await fetch('/api/feedback', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ topic: displayTitle, feedback_type: 'request_similar', opportunity_score: topic.opportunity_score, niche_cluster: topic.niche_cluster }),
        })
      } else {
        setSimilarError(res.status === 402 ? (data.error || 'Nincs elegendő kredited ehhez a művelethez.') : 'Nem sikerült alternatív szöget találni — próbáld újra.')
      }
    } catch {
      setSimilarError('Kapcsolati hiba — próbáld újra.')
    } finally {
      setSimilarLoading(false)
      similarInFlightRef.current = false
    }
  }

  async function handleShowDifferent() {
    await fetch('/api/feedback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: displayTitle, feedback_type: 'request_different', opportunity_score: topic.opportunity_score, niche_cluster: topic.niche_cluster }),
    })
    if (hasPool) {
      onReplace(index)
    } else {
      setNoMorePool(true)
    }
  }

  if (status === 'rejected') {
    return (
      <div className="card text-center py-3 text-sm" style={{ color: '#94A3B8' }}>
        Elutasítva — a jövőbeli ajánlások figyelembe veszik ezt.
      </div>
    )
  }

  return (
    <>
      {showReasonModal && <RejectReasonModal onSelect={submitReject} onClose={() => setShowReasonModal(false)} />}
      {similarCreditCheck && (
        <CreditConfirmModal
          check={similarCreditCheck}
          onConfirm={confirmShowSimilar}
          onCancel={() => { setSimilarCreditCheck(null); similarInFlightRef.current = false }}
          loading={similarLoading}
        />
      )}
      <div className="card-hover">
        <div className="flex items-start gap-4">
          <span className="text-xs font-mono text-text-muted w-6 flex-shrink-0 mt-1">{String(index + 1).padStart(2, '0')}</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <h3 className="font-semibold text-text-primary leading-snug">{displayTitle}</h3>
              <TrendSourceBadge sourceType={topic.trend_source_type} />
              {topic.confidence && confidenceLabelMap[topic.confidence] && (
                <span className="text-xs px-2 py-0.5 rounded-full flex-shrink-0"
                  style={{ background: `${confidenceLabelMap[topic.confidence].color}15`, color: confidenceLabelMap[topic.confidence].color }}>
                  {confidenceLabelMap[topic.confidence].label}
                </span>
              )}
              <span className="text-xs px-2 py-0.5 rounded-full flex-shrink-0 font-semibold"
                style={{ background: readyStatus.bg, color: readyStatus.color, border: `1px solid ${readyStatus.color}30` }}>
                {readyStatus.label}
              </span>
            </div>
            <p className="text-sm leading-relaxed" style={{ color: '#94A3B8' }}>{displayDescription}</p>

            {/* Market type label */}
            {topic.market_type_label && (
              <p className="text-xs mt-1" style={{ color: '#94A3B8' }}>{topic.market_type_label}</p>
            )}

            {/* Validation Summary Panel — user-facing */}
            {topic.validation_summary && (
              <div className="mt-3 rounded-lg px-3 py-2.5" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <div className="flex items-center justify-between gap-3 mb-1.5">
                  <span className="text-xs font-semibold" style={{ color: topic.validation_summary.validation_type === 'hybrid_validated_trend' ? '#22C55E' : topic.validation_summary.validation_type === 'web_validated_opportunity' ? '#3B82F6' : (topic.validation_summary.validation_type === 'video_validated_trend' || topic.validation_summary.validation_type === 'video_inspiration') ? '#F59E0B' : '#94A3B8' }}>
                    {topic.validation_summary.label}
                  </span>
                </div>
                <p className="text-xs mb-2" style={{ color: '#CBD5E1' }}>{cleanText(topic.validation_summary.explanation)}</p>
                {(() => {
                  const strength = topic.evidence_strength || topic.validation_summary.evidence_strength
                  const meta = evidenceStrengthMeta(strength)
                  const reason = cleanText(topic.validation_reason || topic.validation_summary.validation_reason)
                  const action = topic.recommended_next_action || topic.validation_summary.recommended_next_action
                  const limitations = cleanTextList(topic.data_limitations || topic.validation_summary.data_limitations || [])
                  return (
                    <div className="mb-2 rounded-lg px-2.5 py-2" style={{ background: 'rgba(8,13,24,0.5)', border: `1px solid ${meta.color}22` }}>
                      <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
                        <span className="text-xs px-2 py-0.5 rounded-full font-semibold" style={{ color: meta.color, background: meta.bg, border: `1px solid ${meta.color}30` }}>
                          {meta.label}
                        </span>
                        <span className="text-xs px-2 py-0.5 rounded-full" style={{ color: '#CBD5E1', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}>
                          {nextActionLabel(action)}
                        </span>
                      </div>
                      {reason && <p className="text-xs leading-relaxed" style={{ color: '#CBD5E1' }}>{reason}</p>}
                      {limitations.length > 0 && (
                        <p className="text-[11px] mt-1" style={{ color: '#94A3B8' }}>
                          Korlát: {limitations.slice(0, 2).join(' · ')}
                        </p>
                      )}
                    </div>
                  )
                })()}
                <div className="flex flex-wrap gap-1.5 text-xs">
                  <span className="px-2 py-0.5 rounded-full" style={{
                    background: topic.validation_summary.web_validation_score >= 70 ? 'rgba(34,197,94,0.08)' : topic.validation_summary.web_validation_score >= 35 ? 'rgba(59,130,246,0.08)' : 'rgba(255,255,255,0.04)',
                    color: topic.validation_summary.web_validation_score >= 70 ? '#22C55E' : topic.validation_summary.web_validation_score >= 35 ? '#3B82F6' : '#94A3B8',
                    border: `1px solid ${topic.validation_summary.web_validation_score >= 70 ? 'rgba(34,197,94,0.15)' : topic.validation_summary.web_validation_score >= 35 ? 'rgba(59,130,246,0.15)' : 'rgba(255,255,255,0.06)'}`,
                  }}>
                    {topic.validation_summary.web_validation_score >= 70
                      ? `${Math.round(topic.validation_summary.web_validation_score / 35)} webes forrás — erős`
                      : topic.validation_summary.web_validation_score >= 35
                      ? `${Math.round(topic.validation_summary.web_validation_score / 35)} webes forrás`
                      : 'Nincs webes forrás'}
                  </span>
                  <span className="px-2 py-0.5 rounded-full" style={{
                    background: topic.validation_summary.video_validation_score >= 50 ? 'rgba(34,197,94,0.08)' : 'rgba(255,255,255,0.04)',
                    color: topic.validation_summary.video_validation_score >= 50 ? '#22C55E' : '#94A3B8',
                    border: `1px solid ${topic.validation_summary.video_validation_score >= 50 ? 'rgba(34,197,94,0.15)' : 'rgba(255,255,255,0.06)'}`,
                  }}>
                    {topic.validation_summary.video_validation_score >= 50
                      ? 'Van videós aktivitás'
                      : 'Nincs erős videós bizonyíték'}
                  </span>
                  <span className="px-2 py-0.5 rounded-full" style={{
                    background: topic.validation_summary.content_gap_score >= 70 ? 'rgba(59,130,246,0.08)' : topic.validation_summary.content_gap_score >= 40 ? 'rgba(245,158,11,0.08)' : 'rgba(255,255,255,0.04)',
                    color: topic.validation_summary.content_gap_score >= 70 ? '#3B82F6' : topic.validation_summary.content_gap_score >= 40 ? '#F59E0B' : '#94A3B8',
                    border: `1px solid ${topic.validation_summary.content_gap_score >= 70 ? 'rgba(59,130,246,0.15)' : topic.validation_summary.content_gap_score >= 40 ? 'rgba(245,158,11,0.15)' : 'rgba(255,255,255,0.06)'}`,
                  }}>
                    {topic.validation_summary.content_gap_score >= 70
                      ? 'Magas tartalmi rés'
                      : topic.validation_summary.content_gap_score >= 40
                      ? 'Közepes tartalmi rés'
                      : 'Alacsony tartalmi rés'}
                  </span>
                </div>
              </div>
            )}

            {/* Fallback döntés ha nincs validation_summary */}
            {!topic.validation_summary && (
            <div className="mt-3 rounded-lg px-3 py-2"
              style={{ background: readyStatus.bg, border: `1px solid ${readyStatus.color}30` }}>
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-semibold" style={{ color: readyStatus.color }}>
                  WillViral döntés: {readyStatus.label}
                </p>
                {decisionScore !== undefined && (
                  <span className="text-xs font-mono" style={{ color: readyStatus.color }}>
                    {decisionScore}/100
                  </span>
                )}
              </div>
              {readyStatus.status === 'ready' && (
                <p className="text-xs mt-1" style={{ color: '#CBD5E1' }}>
                  Van elég jel ahhoz, hogy ebből közvetlenül videócsomag készüljön.
                </p>
              )}
              {readyStatus.status === 'watch' && (
                <p className="text-xs mt-1" style={{ color: '#CBD5E1' }}>
                  Ígéretes korai lehetőség.
                </p>
              )}
              {(readyStatus.status === 'research' || readyStatus.status === 'rejected') && (
                <p className="text-xs mt-1" style={{ color: '#CBD5E1' }}>
                  Ez még nem kész gyártási ajánlás. Előbb pontosítsd vagy keress hozzá erősebb bizonyítékot.
                </p>
              )}
            </div>
            )}

            {expanded && (
              <div className="mt-4 space-y-4 pt-4 border-t border-border">

                {topic.risk_flags && topic.risk_flags.length > 0 && (
                  <div className="rounded-lg px-3 py-2 text-xs"
                    style={{ background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.16)', color: '#CBD5E1' }}>
                    <p className="font-semibold mb-1" style={{ color: '#F59E0B' }}>Miért óvatos a rendszer?</p>
                    <div className="flex flex-wrap gap-1.5">
                      {topic.risk_flags.map((flag, i) => (
                        <span key={i} className="px-2 py-0.5 rounded-full"
                          style={{ background: 'rgba(245,158,11,0.08)', color: '#F59E0B', border: '1px solid rgba(245,158,11,0.15)' }}>
                          {flag}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Hook ötlet */}
                {topic.hook_suggestion && (
                  <div className="rounded-lg px-3 py-2 text-xs"
                    style={{ background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.15)', color: '#CBD5E1' }}>
                    <span style={{ color: '#3B82F6' }} className="font-semibold">Hook ötlet: </span>
                    {topic.hook_suggestion}
                  </div>
                )}

                {/* Webes források */}
                {hasWebSources && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: '#94A3B8' }}>
                      🌐 Webes források ({topic.web_sources!.length})
                    </p>
                    <div className="space-y-1.5">
                      {topic.web_sources!.map((s, i) => (
                        <WebSourceItem key={i} source={s} />
                      ))}
                    </div>
                  </div>
                )}

                {/* YouTube bizonyíték videók */}
                {hasVideos && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: '#94A3B8' }}>
                      📺 Bizonyíték videók ({topic.evidence_videos!.length})
                    </p>
                    <div className="space-y-1.5">
                      {topic.evidence_videos!.map(v => <EvidenceVideo key={v.video_id} video={v} />)}
                    </div>
                  </div>
                )}

                {/* Ha nincs sem videó sem web forrás */}
                {!hasVideos && !hasWebSources && (
                  <p className="text-xs" style={{ color: '#94A3B8' }}>
                    Nincs elérhető bizonyíték forrás ehhez a témához.
                  </p>
                )}

                {/* Részletes pontszámok — haladó nézet */}
                <details className="group">
                  <summary className="text-xs font-semibold uppercase tracking-widest cursor-pointer select-none flex items-center gap-1.5"
                    style={{ color: '#64748B' }}>
                    <span className="transition-transform group-open:rotate-90" style={{ fontSize: '10px' }}>▶</span>
                    Részletes pontszámok
                  </summary>
                  <div className="mt-2 space-y-2">
                    <ScoreBar label="Webes validáció" value={topic.score_breakdown.trend_momentum} weight={30} />
                    <ScoreBar label={SCORE_LABELS.niche_match} value={topic.score_breakdown.niche_match} weight={20} />
                    <ScoreBar label={SCORE_LABELS.content_gap} value={topic.score_breakdown.content_gap} weight={20} />
                    <CompetitionScoreBar value={topic.score_breakdown.competition} weight={15} />
                    <ScoreBar label={SCORE_LABELS.freshness} value={topic.score_breakdown.freshness} weight={15} />
                  </div>
                </details>

              </div>
            )}

            {/* Action gombok */}
            <div className="flex gap-2 mt-3 flex-wrap">
              <a href={`/dashboard/similar-videos?topic=${encodeURIComponent(topic.keyword || displayTitle)}`}
                className="text-xs px-3 py-1.5 rounded-lg bg-surface-2 border border-border text-text-secondary hover:text-violet hover:border-violet/40 transition-all">
                🎬 Piaci bizonyítékok
              </a>
              <a href={`/dashboard/viral-score?topic=${encodeURIComponent(topic.keyword || displayTitle)}`}
                className="text-xs px-3 py-1.5 rounded-lg bg-surface-2 border border-border text-text-secondary hover:text-violet hover:border-violet/40 transition-all">
                📈 Virális esély
              </a>
              {topic.validation_summary ? (
                <>
                  {topic.validation_summary.cta_primary.action === 'video_package' ? (
                    <a href={packageUrl} onClick={handleCreatePackageClick} aria-busy={packageLoading}
                      className="text-xs px-3 py-1.5 rounded-lg font-medium transition-all"
                      style={{ background: 'linear-gradient(135deg, rgba(59,130,246,0.15), rgba(139,92,246,0.1))', border: '1px solid rgba(59,130,246,0.3)', color: '#3B82F6' }}>
                      {packageLoading ? 'Bizonyíték mentése…' : topic.validation_summary.cta_primary.text}
                    </a>
                  ) : topic.validation_summary.cta_primary.action === 'similar_videos' ? (
                    <a href={`/dashboard/similar-videos?topic=${encodeURIComponent(topic.keyword || displayTitle)}`}
                      className="text-xs px-3 py-1.5 rounded-lg font-medium transition-all"
                      style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)', color: '#3B82F6' }}>
                      {topic.validation_summary.cta_primary.text}
                    </a>
                  ) : (
                    <button onClick={() => handleShowDifferent()}
                      className="text-xs px-3 py-1.5 rounded-lg font-medium transition-all"
                      style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: '#CBD5E1' }}>
                      {topic.validation_summary.cta_primary.text}
                    </button>
                  )}
                  {topic.validation_summary.cta_secondary && (
                    <a href={topic.validation_summary.cta_secondary.action === 'similar_videos'
                      ? `/dashboard/similar-videos?topic=${encodeURIComponent(topic.keyword || displayTitle)}`
                      : `/dashboard/viral-score?topic=${encodeURIComponent(topic.keyword || displayTitle)}`}
                      className="text-xs px-3 py-1.5 rounded-lg transition-all"
                      style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', color: '#94A3B8' }}>
                      {topic.validation_summary.cta_secondary.text}
                    </a>
                  )}
                </>
              ) : canCreatePackage ? (
                <a href={packageUrl} onClick={handleCreatePackageClick} aria-busy={packageLoading}
                  className="text-xs px-3 py-1.5 rounded-lg font-medium transition-all"
                  style={{ background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.3)', color: '#3B82F6' }}>
                  {packageLoading ? 'Bizonyíték mentése…' : 'Videócsomag'}
                </a>
              ) : (
                <a href={`/dashboard/similar-videos?topic=${encodeURIComponent(topic.keyword || displayTitle)}`}
                  className="text-xs px-3 py-1.5 rounded-lg font-medium transition-all"
                  style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', color: '#F59E0B' }}>
                  Validáció megnyitása
                </a>
              )}
              <button onClick={handleShowSimilar} disabled={similarLoading}
                className="text-xs px-3 py-1.5 rounded-lg bg-surface-2 border border-border text-text-secondary hover:text-amber hover:border-amber/40 transition-all disabled:opacity-50">
                {similarLoading ? '...' : '🔄 Mutass hasonlót'}
              </button>
              <button onClick={handleShowDifferent} disabled={replacing}
                className="text-xs px-3 py-1.5 rounded-lg bg-surface-2 border border-border text-text-secondary hover:text-text-primary transition-all disabled:opacity-50">
                {replacing ? '...' : '🔀 Mutass mást'}
              </button>
            </div>
            {packageError && (
              <div role="alert" className="mt-2 text-xs rounded-lg px-3 py-2"
                style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', color: '#FCA5A5' }}>
                <p className="mb-1.5">{packageError.message}</p>
                {packageError.kind === 'degradable' ? (
                  <button onClick={continueWithoutEvidence}
                    className="text-xs px-2.5 py-1 rounded-md font-medium"
                    style={{ background: 'rgba(255,255,255,0.06)', color: '#F8FAFC' }}>
                    Folytatás bizonyíték nélkül
                  </button>
                ) : null}
              </div>
            )}

            {noMorePool && (
              <p className="text-xs mt-2" style={{ color: '#F59E0B' }}>
                Nincs több tartalék javaslat ebben a keresésben. Kérj friss adatokat, vagy módosítsd a régiót / platformot a profilban.
              </p>
            )}
            {similarError && (
              <p className="text-xs mt-2" style={{ color: '#EF4444' }}>{similarError}</p>
            )}
          </div>

          {/* Jobb oldal: score */}
          <div className="flex flex-col items-end gap-2 flex-shrink-0">
            <div className="text-right">
              <span className="text-2xl font-bold" style={{ color: scoreColorVal }}>{topic.opportunity_score}</span>
              <div className="text-xs font-medium mt-0.5" style={{ color: scoreLabelColor(topic.opportunity_score) }}>
                {scoreLabel(topic.opportunity_score)}
              </div>
            </div>
            <div className="flex gap-1.5">
              <button onClick={() => setExpanded(!expanded)}
                className="text-xs text-text-muted hover:text-text-secondary px-2 py-1 rounded hover:bg-surface-2">
                {expanded ? '▲' : '▼'}
              </button>
              <button type="button" onClick={handleSave} disabled={isSaved || isSavingCurrent || !saveGateReady}
                aria-label={isSaved ? 'Elmentve a memóriába' : 'Mentés a memóriába'}
                title={isSaved ? 'Elmentve a memóriába' : !saveGateReady ? 'A mentett állapot ellenőrzése folyamatban…' : 'Mentés a memóriába'}
                className={`text-xs px-2.5 py-1 rounded transition-all disabled:opacity-70 ${isSaved ? 'text-emerald bg-emerald/10' : 'text-text-muted hover:text-violet hover:bg-violet/10'}`}>
                {isSavingCurrent ? '⏳' : isSaved ? '✓ Mentve' : '🔖'}
              </button>
              <button onClick={() => setShowReasonModal(true)}
                className="text-xs px-2.5 py-1 rounded text-text-muted hover:text-rose hover:bg-rose/10 transition-all">
                ✕
              </button>
            </div>
            {currentSaveError && (
              <p className="text-xs text-right max-w-[140px]" style={{ color: '#EF4444' }}>{currentSaveError}</p>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

// ── Discovery Lane helper ────────────────────────────────────

export function isDiscoveryLane(topic: ExtendedTopic): boolean {
  const hasWebSources = !!topic.web_sources?.length
  const hasEvidenceVideos = !!topic.evidence_videos?.length
  const hasEvidence = hasWebSources || hasEvidenceVideos
  const readyStatus = getReadyStatus(topic).status
  const score = topic.opportunity_score || 0
  const lowConfidence = topic.confidence === 'alacsony' || topic.confidence === 'nagyon_alacsony'

  return (
    topic.trend_source_type === 'broad_niche_discovery' ||
    topic.trend_source_type === 'research_fallback' ||
    topic.ready_to_produce_status === 'research' ||
    (!hasEvidence && (score < 60 || readyStatus === 'research' || lowConfidence))
  )
}

// Exported for OpportunitiesPage's render tree AND for direct RTL
// component-interaction tests -- same note as TopicCard above.
export function DiscoveryLaneCard({ topic, onSearch, paidResultId }: {
  topic: ExtendedTopic
  onSearch: (keyword: string) => void
  // Same contract as TopicCard's identically-named prop -- see there for
  // the full rationale. Null when this candidate has no stored paid_results
  // row to resolve evidence from.
  paidResultId: string | null
}) {
  const [expanded, setExpanded] = useState(false)
  const [packageError, setPackageError] = useState<{ kind: 'blocked' | 'degradable'; message: string } | null>(null)
  const [packageLoading, setPackageLoading] = useState(false)
  const strength = topic.evidence_strength || topic.validation_summary?.evidence_strength
  const meta = evidenceStrengthMeta(strength)
  const reason = cleanText(topic.validation_reason || topic.validation_summary?.validation_reason)
  const limitations = cleanTextList(topic.data_limitations || topic.validation_summary?.data_limitations || [])
  const webSources = topic.web_sources || []
  const videos = topic.evidence_videos || []
  const hasDetails = webSources.length > 0 || videos.length > 0 || !!reason || limitations.length > 0
  const displayTitle = topic.title
  const packageUrl = buildOpportunityPackageUrl(topic, displayTitle)
  const decisionScore = topic.decision_score || topic.evidence_match_score || topic.opportunity_score || 0
  const scoreColorVal = getScoreColor(decisionScore)

  // Identical contract/failure-semantics to TopicCard.handleCreatePackageClick
  // -- see there for the full rationale (never auto-navigate with implied
  // evidence on auth/ownership failure; explicit "Folytatás bizonyíték
  // nélkül" choice otherwise).
  async function handleCreatePackageClick(event: React.MouseEvent) {
    event.preventDefault()
    setPackageError(null)
    if (!paidResultId) {
      // Sose navigáljunk csendben bizonyíték nélkül -- ez a döntés (2026-09-29
      // QA) kizárólag a "Folytatás bizonyíték nélkül" gombon, explicit
      // user-kattintásra hozható meg, ugyanúgy, mint egy sikertelen
      // evidence-snapshot POST után. Hiányzó paidResultId nem jelenti
      // automatikusan, hogy nincs bizonyíték -- lehet, hogy csak a szülő
      // állapot (pl. egy imént megnyitott korábbi eredmény) nem kapta meg
      // helyesen -- ezért ez a fail-closed alapeset.
      setPackageError({ kind: 'degradable', message: 'Nincs elérhető szerveroldali bizonyíték ehhez az ajánláshoz.' })
      return
    }
    setPackageLoading(true)
    try {
      const res = await fetch('/api/opportunity/evidence-snapshot', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paid_result_id: paidResultId, topic_id: topic.id }),
      })
      if (res.ok) {
        const data = await res.json()
        window.location.href = `/dashboard/video-package?video_idea_id=${encodeURIComponent(data.video_idea_id)}&topic=${encodeURIComponent(displayTitle)}&keyword=${encodeURIComponent(topic.keyword || '')}&source_context=opportunity_engine`
        return
      }
      if (classifyEvidenceSnapshotFailure(res.status) === 'blocked') {
        setPackageError({ kind: 'blocked', message: 'A bizonyíték mentése nem sikerült (bejelentkezés vagy jogosultság). Frissítsd az oldalt és próbáld újra.' })
        return
      }
      setPackageError({ kind: 'degradable', message: 'A bizonyíték mentése sikertelen volt.' })
    } catch {
      setPackageError({ kind: 'degradable', message: 'Kapcsolati hiba a bizonyíték mentésekor.' })
    } finally {
      setPackageLoading(false)
    }
  }

  function continueWithoutEvidence() {
    storeOpportunityPackageContext(topic, displayTitle)
    window.location.href = packageUrl
  }

  return (
    <div className="rounded-xl p-4" style={{ background: 'rgba(139,155,180,0.05)', border: '1px solid rgba(139,155,180,0.12)' }}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="text-sm" style={{ color: '#CBD5E1' }}>🔍</span>
            <h3 className="font-medium text-sm" style={{ color: '#F8FAFC' }}>{topic.title}</h3>
            <span className="text-xs px-2 py-0.5 rounded-full font-semibold" style={{ color: meta.color, background: meta.bg, border: `1px solid ${meta.color}30` }}>
              {meta.label}
            </span>
          </div>
          <p className="text-xs leading-relaxed mb-3" style={{ color: '#94A3B8' }}>{cleanText(topic.description)}</p>

          {(reason || limitations.length > 0) && (
            <div className="rounded-lg px-3 py-2 mb-3" style={{ background: 'rgba(8,13,24,0.45)', border: '1px solid rgba(255,255,255,0.06)' }}>
              {reason && <p className="text-xs leading-relaxed" style={{ color: '#CBD5E1' }}>{reason}</p>}
              {limitations.length > 0 && (
                <p className="text-[11px] mt-1" style={{ color: '#94A3B8' }}>
                  Korlát: {limitations.slice(0, 3).join(' · ')}
                </p>
              )}
            </div>
          )}

          {topic.risk_flags && topic.risk_flags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-3">
              {cleanTextList(topic.risk_flags).map((flag, i) => (
                <span key={i} className="text-xs px-2 py-0.5 rounded-full"
                  style={{ background: 'rgba(245,158,11,0.08)', color: '#F59E0B', border: '1px solid rgba(245,158,11,0.15)' }}>
                  {flag}
                </span>
              ))}
            </div>
          )}

          <div className="flex gap-2 flex-wrap">
            {hasDetails && (
              <button onClick={() => setExpanded(!expanded)}
                className="text-xs px-3 py-1.5 rounded-lg font-medium transition-all hover:opacity-80"
                style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: '#CBD5E1' }}>
                {expanded ? 'Részletek elrejtése' : `Részletek (${webSources.length} forrás · ${videos.length} videó)`}
              </button>
            )}
            <a href={`/dashboard/viral-score?topic=${encodeURIComponent(topic.keyword || displayTitle)}`}
              className="text-xs px-3 py-1.5 rounded-lg transition-all"
              style={{ background: 'rgba(139,92,246,0.1)', border: '1px solid rgba(139,92,246,0.25)', color: '#A78BFA' }}>
              Virális esély
            </a>
            <a href={packageUrl} onClick={handleCreatePackageClick} aria-busy={packageLoading}
              className="text-xs px-3 py-1.5 rounded-lg font-medium transition-all"
              style={{ background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.3)', color: '#3B82F6' }}>
              {packageLoading ? 'Bizonyíték mentése…' : 'Videócsomag'}
            </a>
            <button onClick={() => onSearch(topic.keyword || topic.title)}
              className="text-xs px-3 py-1.5 rounded-lg font-medium transition-all hover:opacity-80"
              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: '#CBD5E1' }}>
              Konkrétabb témák keresése
            </button>
            <a href={`/dashboard/similar-videos?topic=${encodeURIComponent(topic.keyword || topic.title)}`}
              className="text-xs px-3 py-1.5 rounded-lg transition-all"
              style={{ background: '#121826', border: '1px solid rgba(255,255,255,0.08)', color: '#CBD5E1' }}>
              Piaci bizonyítékok
            </a>
          </div>
          {packageError && (
            <div role="alert" className="mt-2 text-xs rounded-lg px-3 py-2"
              style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', color: '#FCA5A5' }}>
              <p className="mb-1.5">{packageError.message}</p>
              {packageError.kind === 'degradable' ? (
                <button onClick={continueWithoutEvidence}
                  className="text-xs px-2.5 py-1 rounded-md font-medium"
                  style={{ background: 'rgba(255,255,255,0.06)', color: '#F8FAFC' }}>
                  Folytatás bizonyíték nélkül
                </button>
              ) : null}
            </div>
          )}

          {expanded && (
            <div className="mt-3 pt-3 space-y-3" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
              {webSources.length > 0 && (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-widest mb-1.5" style={{ color: '#64748B' }}>Webes források ({webSources.length})</p>
                  <div className="space-y-1.5">
                    {webSources.map((source, i) => <WebSourceItem key={`${source.url}-${i}`} source={source} />)}
                  </div>
                </div>
              )}
              {videos.length > 0 && (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-widest mb-1.5" style={{ color: '#64748B' }}>Videójelek ({videos.length})</p>
                  <div className="space-y-1.5">
                    {videos.map(video => <EvidenceVideo key={video.video_id} video={video} />)}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="text-right flex-shrink-0 min-w-[64px]">
          <span className="text-2xl font-bold" style={{ color: scoreColorVal }}>{decisionScore}</span>
          <div className="text-xs font-medium mt-0.5" style={{ color: scoreLabelColor(decisionScore) }}>
            {scoreLabel(decisionScore)}
          </div>
        </div>
      </div>
    </div>
  )
}
