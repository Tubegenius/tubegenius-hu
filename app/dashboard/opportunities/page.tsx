'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase'
import { useSearchParams } from 'next/navigation'
import { SCORE_LABELS, REJECT_REASONS } from '@/types'
import type { OpportunityTopic, CreatorProfile, SimilarVideo, RejectReason } from '@/types'
import { scoreColor as getScoreColor, scoreLabel, scoreLabelColor, regionLabel, platformLabel } from '@/lib/score-utils'
import CreditConfirmModal from '@/components/CreditConfirmModal'
import type { UsageCheckResult } from '@/lib/usage-protection'
import LoadingScreen, { LOADING_STEPS } from '@/components/ui/LoadingScreen'

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
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(8,11,18,0.7)' }} onClick={onClose}>
      <div className="rounded-2xl p-5 max-w-sm w-full" style={{ background: '#0F1420', border: '1px solid rgba(255,255,255,0.08)' }} onClick={e => e.stopPropagation()}>
        <h3 className="font-semibold mb-1" style={{ color: '#F8FAFC' }}>Miért nem jó ez a téma?</h3>
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

type ExtendedTopic = OpportunityTopic & {
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

function TopicCard({ topic, index, onReplace, hasPool }: {
  topic: ExtendedTopic
  index: number
  onReplace: (index: number) => void
  hasPool: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const [saved, setSaved] = useState(false)
  const [status, setStatus] = useState<'active' | 'rejected'>('active')
  const [noMorePool, setNoMorePool] = useState(false)
  const [showReasonModal, setShowReasonModal] = useState(false)
  const [similarLoading, setSimilarLoading] = useState(false)
  const [similarError, setSimilarError] = useState<string | null>(null)
  const [displayTitle, setDisplayTitle] = useState(topic.title)
  const [displayDescription, setDisplayDescription] = useState(topic.description)
  const scoreColorVal = getScoreColor(topic.opportunity_score)

  const hasVideos = topic.evidence_videos && topic.evidence_videos.length > 0
  const hasWebSources = topic.web_sources && topic.web_sources.length > 0
  const readyStatus = getReadyStatus(topic)
  const packageUrl = buildOpportunityPackageUrl(topic, displayTitle)
  const canCreatePackage = readyStatus.status === 'ready' || readyStatus.status === 'watch'
  const decisionScore = topic.decision_score || topic.evidence_match_score

  async function handleSave() {
    await fetch('/api/memory', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: displayTitle, search_keyword: topic.keyword, state: 'saved',
        opportunity_score: topic.opportunity_score, platform: topic.platform,
      }),
    })
    await fetch('/api/feedback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: displayTitle, feedback_type: 'save', opportunity_score: topic.opportunity_score, niche_cluster: topic.niche_cluster }),
    })
    setSaved(true)
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

  async function handleShowSimilar() {
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
        setDisplayTitle(data.title)
        setDisplayDescription(data.description)
        await fetch('/api/feedback', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ topic: displayTitle, feedback_type: 'request_similar', opportunity_score: topic.opportunity_score, niche_cluster: topic.niche_cluster }),
        })
      } else {
        setSimilarError('Nem sikerült alternatív szöget találni — próbáld újra.')
      }
    } catch {
      setSimilarError('Kapcsolati hiba — próbáld újra.')
    } finally {
      setSimilarLoading(false)
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
                <p className="text-xs mb-2" style={{ color: '#CBD5E1' }}>{topic.validation_summary.explanation}</p>
                {(() => {
                  const strength = topic.evidence_strength || topic.validation_summary.evidence_strength
                  const meta = evidenceStrengthMeta(strength)
                  const reason = topic.validation_reason || topic.validation_summary.validation_reason
                  const action = topic.recommended_next_action || topic.validation_summary.recommended_next_action
                  const limitations = topic.data_limitations || topic.validation_summary.data_limitations || []
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
                🎬 Similar Videos
              </a>
              <a href={`/dashboard/viral-score?topic=${encodeURIComponent(topic.keyword || displayTitle)}`}
                className="text-xs px-3 py-1.5 rounded-lg bg-surface-2 border border-border text-text-secondary hover:text-violet hover:border-violet/40 transition-all">
                📈 Viral Score
              </a>
              {topic.validation_summary ? (
                <>
                  {topic.validation_summary.cta_primary.action === 'video_package' ? (
                    <a href={packageUrl} onClick={() => storeOpportunityPackageContext(topic, displayTitle)}
                      className="text-xs px-3 py-1.5 rounded-lg font-medium transition-all"
                      style={{ background: 'linear-gradient(135deg, rgba(59,130,246,0.15), rgba(139,92,246,0.1))', border: '1px solid rgba(59,130,246,0.3)', color: '#3B82F6' }}>
                      {topic.validation_summary.cta_primary.text}
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
                <a href={packageUrl} onClick={() => storeOpportunityPackageContext(topic, displayTitle)}
                  className="text-xs px-3 py-1.5 rounded-lg font-medium transition-all"
                  style={{ background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.3)', color: '#3B82F6' }}>
                  Videócsomag
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
              <button onClick={handleShowDifferent}
                className="text-xs px-3 py-1.5 rounded-lg bg-surface-2 border border-border text-text-secondary hover:text-text-primary transition-all">
                🔀 Mutass mást
              </button>
            </div>

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
              <button onClick={handleSave} disabled={saved}
                className={`text-xs px-2.5 py-1 rounded transition-all ${saved ? 'text-emerald bg-emerald/10' : 'text-text-muted hover:text-violet hover:bg-violet/10'}`}>
                {saved ? '✓' : '🔖'}
              </button>
              <button onClick={() => setShowReasonModal(true)}
                className="text-xs px-2.5 py-1 rounded text-text-muted hover:text-rose hover:bg-rose/10 transition-all">
                ✕
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

// ── Discovery Lane helper ────────────────────────────────────

function isDiscoveryLane(topic: ExtendedTopic): boolean {
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

function DiscoveryLaneCard({ topic, onSearch }: {
  topic: ExtendedTopic
  onSearch: (keyword: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const strength = topic.evidence_strength || topic.validation_summary?.evidence_strength
  const meta = evidenceStrengthMeta(strength)
  const reason = topic.validation_reason || topic.validation_summary?.validation_reason
  const limitations = topic.data_limitations || topic.validation_summary?.data_limitations || []
  const webSources = topic.web_sources || []
  const videos = topic.evidence_videos || []
  const hasDetails = webSources.length > 0 || videos.length > 0 || !!reason || limitations.length > 0
  const displayTitle = topic.title
  const packageUrl = buildOpportunityPackageUrl(topic, displayTitle)
  const decisionScore = topic.decision_score || topic.evidence_match_score || topic.opportunity_score || 0
  const scoreColorVal = getScoreColor(decisionScore)

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
          <p className="text-xs leading-relaxed mb-3" style={{ color: '#94A3B8' }}>{topic.description}</p>

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
              {topic.risk_flags.map((flag, i) => (
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
              Viral Score
            </a>
            <a href={packageUrl} onClick={() => storeOpportunityPackageContext(topic, displayTitle)}
              className="text-xs px-3 py-1.5 rounded-lg font-medium transition-all"
              style={{ background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.3)', color: '#3B82F6' }}>
              Videócsomag
            </a>
            <button onClick={() => onSearch(topic.keyword || topic.title)}
              className="text-xs px-3 py-1.5 rounded-lg font-medium transition-all hover:opacity-80"
              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: '#CBD5E1' }}>
              Konkrétabb témák keresése
            </button>
            <a href={`/dashboard/similar-videos?topic=${encodeURIComponent(topic.keyword || topic.title)}`}
              className="text-xs px-3 py-1.5 rounded-lg transition-all"
              style={{ background: '#121826', border: '1px solid rgba(255,255,255,0.08)', color: '#CBD5E1' }}>
              Similar Videos
            </a>
          </div>

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
// ── Fő oldal ──────────────────────────────────────────────────

export default function OpportunitiesPage() {
  const supabase = createClient()
  const searchParams = useSearchParams()
  const highlightId = searchParams.get('highlight')
  const nicheParam = searchParams.get('niche')
  const paidResultId = searchParams.get('paidResultId') || ''
  const [profile, setProfile] = useState<CreatorProfile | null>(null)
  const [highlightTopic, setHighlightTopic] = useState<ExtendedTopic | null>(null)
  const [niche, setNiche] = useState('')
  const [loading, setLoading] = useState(false)
  const [topics, setTopics] = useState<ExtendedTopic[]>([])
  const [poolTopics, setPoolTopics] = useState<ExtendedTopic[]>([])
  const [cached, setCached] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [activeDrilldown, setActiveDrilldown] = useState<string | null>(null)
  const [creditCheck, setCreditCheck] = useState<UsageCheckResult | null>(null)
  const [pendingGenerate, setPendingGenerate] = useState<{ profile?: CreatorProfile; options?: Record<string, unknown> } | null>(null)

  // Keresési előzmény visszaállítása — de ha a profil niche változott, újra keresünk
  useEffect(() => {
    async function init() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const { data: prof } = await supabase.from('profiles').select('*').eq('user_id', user.id).single()
      if (prof) {
        setProfile(prof)
        setNiche(prof.niche || '')
      }

      // Ha highlight candidateId jött a dashboardról, azt mutassuk elsőnek
      if (highlightId) {
        try {
          const raw = sessionStorage.getItem('willviral_highlight_candidate')
          if (raw) {
            const candidate = JSON.parse(raw) as ExtendedTopic
            setHighlightTopic(candidate)
            setTopics([candidate])
            setNiche(prof?.niche || '')
            return
          }
        } catch {}
      }

      // Ha a "Legutóbbi történeted" panelről érkezünk egy korábbi niche-szel,
      // előbb ingyenesen megnézzük, van-e még érvényes mentett eredmény —
      // ha van, azt mutatjuk kredit-ellenőrzés és megerősítő modal nélkül.
      // Csak akkor megy a normál, kredit-gated útra, ha nincs cache.
      if (nicheParam) {
        setNiche(nicheParam)
        try {
          const cacheRes = await fetch('/api/opportunity', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              niche: nicheParam, platform: prof?.platform || 'youtube',
              language: prof?.language || 'hu', region: prof?.region || 'HU',
              main_category: prof?.main_category, specific_focus: prof?.specific_focus,
              cache_only: true,
              paidResultId: paidResultId || undefined,
            }),
          })
          const cacheData = await cacheRes.json()
          if (cacheRes.ok && (cacheData.cached || cacheData.from_paid_result) && (cacheData.topics?.length > 0 || cacheData.pool_topics?.length > 0)) {
            setTopics(cacheData.topics || [])
            setPoolTopics(cacheData.pool_topics || [])
            setCached(true)
            return
          }
        } catch {}
        if (prof) await handleGenerateWithCreditCheck({ ...prof, niche: nicheParam })
        return
      }

      const saved = sessionStorage.getItem('willviral_opportunities_state')
      if (saved) {
        try {
          const state = JSON.parse(saved)
          // Ha a profil niche megváltozott, a cache érvénytelen
          if (state.niche && prof?.niche && state.niche.toLowerCase() !== prof.niche.toLowerCase()) {
            sessionStorage.removeItem('willviral_opportunities_state')
          } else if (state.topics?.length > 0) {
            setNiche(state.niche || prof?.niche || '')
            setTopics(state.topics)
            setPoolTopics(state.poolTopics || [])
            if (state.message) setMessage(state.message)
            if (state.activeDrilldown) setActiveDrilldown(state.activeDrilldown)
            return
          }
        } catch {}
      }

      if (prof?.niche) {
        // Mindig a kredit-ellenőrzésen (handleGenerateWithCreditCheck) keresztül —
        // soha ne induljon automatikus generálás, ami esetleg kreditbe kerülne,
        // felugró megerősítés nélkül.
        await handleGenerateWithCreditCheck(prof)
      }
    }
    init()
  }, [])

  function getCacheKey(nicheVal: string, platform: string, region: string) {
    return `willviral_opportunities_v10_consistency_${nicheVal}_${platform}_${region}`.toLowerCase().replace(/\s+/g, '_')
  }

  async function handleGenerateWithCreditCheck(p?: CreatorProfile, options?: { discoveryMode?: 'drilldown'; parentNiche?: string; skipCache?: boolean }) {
    try {
      const checkRes = await fetch('/api/credit-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feature: 'opportunity_engine' }),
      })
      const check = await checkRes.json() as UsageCheckResult

      if (!check.canRun) {
        setCreditCheck(check)
        return
      }
      if (check.requiresConfirmation) {
        setPendingGenerate({ profile: p || undefined, options: { ...options, confirmed: true } })
        setCreditCheck(check)
        return
      }
    } catch {}

    generate(p, options)
  }

  async function generate(p?: CreatorProfile, options?: { discoveryMode?: 'drilldown'; parentNiche?: string; skipCache?: boolean; confirmed?: boolean }) {
    const prof = p || profile
    const nicheToUse = p?.niche || niche
    if (!nicheToUse.trim()) return

    setLoading(true)
    setError(null)
    setMessage(null)

    try {
      const res = await fetch('/api/opportunity', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          niche: nicheToUse, platform: prof?.platform || 'youtube',
          language: prof?.language || 'hu', region: prof?.region || 'HU',
          creator_level: prof?.creator_level || 'growing',
          discovery_mode: options?.discoveryMode,
          parent_niche: options?.parentNiche,
          // A user már jóváhagyta a levonást a CreditConfirmModalban — csak ekkor
          // szabad a szervernek ténylegesen kreditet vonnia (force_refresh jelzi ezt).
          force_refresh: options?.confirmed === true,
          paidResultId: paidResultId || undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error); return }

      // Van elég kredit, de a user MÉG NEM erősítette meg — mutassuk a modalt,
      // ne induljon el semmi kreditlevonás felugró jóváhagyás nélkül.
      if (data.needs_confirmation) {
        setLoading(false)
        setPendingGenerate({ profile: prof || undefined, options: { ...options, confirmed: true } })
        setCreditCheck({
          feature: 'Opportunity Engine',
          cost: data.confirmation_cost || 2,
          currency: 'credit',
          currentCredits: 0,
          remainingCreditsAfterRun: 0,
          requiresConfirmation: true,
          canRun: true,
          message: data.message || 'A heti ingyenes Top Opportunity ajánlásod már megvan. Ez az extra keresés kreditbe kerül.',
        })
        return
      }
      setMessage(data.message || null)
      setTopics(data.topics || [])
      setPoolTopics(data.pool_topics || [])
      setCached(data.cached || false)

      // Mentés sessionStorage-ba — böngésző vissza gomb támogatás
      sessionStorage.setItem('willviral_opportunities_state', JSON.stringify({
        niche: nicheToUse,
        topics: data.topics || [],
        poolTopics: data.pool_topics || [],
        message: data.message || null,
        activeDrilldown: options?.discoveryMode === 'drilldown' ? nicheToUse : null,
        parentNiche: options?.parentNiche || null,
      }))

      if (!options?.skipCache && data.topics && data.topics.length > 0) {
        const cacheKey = getCacheKey(nicheToUse, prof?.platform || 'youtube', prof?.region || 'HU')
        sessionStorage.setItem(cacheKey, JSON.stringify({
          topics: data.topics,
          pool_topics: data.pool_topics || [],
          timestamp: Date.now(),
        }))
      }
    } catch {
      setError('Kapcsolati hiba.')
    } finally {
      setLoading(false)
    }
  }

  async function handleReplace(index: number) {
    if (poolTopics.length === 0) return
    const next = poolTopics[0]
    const remainingPool = poolTopics.slice(1)
    let finalTopic = next
    if (next.needs_explanation) {
      try {
        const res = await fetch('/api/opportunity-explain', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            keyword: next.keyword, niche: next.niche,
            score_breakdown: next.score_breakdown, evidence_videos: next.evidence_videos,
          }),
        })
        const data = await res.json()
        if (res.ok) {
          finalTopic = { ...next, title: data.title, description: data.description, needs_explanation: false }
        }
      } catch {}
    }
    setTopics(prev => {
      const updated = [...prev]
      updated[index] = finalTopic
      return updated
    })
    setPoolTopics(remainingPool)
  }

  return (
    <div className="max-w-3xl mx-auto">
      {creditCheck && (
        <CreditConfirmModal
          check={creditCheck}
          onConfirm={() => {
            setCreditCheck(null)
            if (pendingGenerate) {
              generate(pendingGenerate.profile, pendingGenerate.options as { discoveryMode?: 'drilldown'; parentNiche?: string; skipCache?: boolean })
              setPendingGenerate(null)
            }
          }}
          onCancel={() => { setCreditCheck(null); setPendingGenerate(null) }}
          loading={loading}
        />
      )}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-text-primary mb-1">Opportunity Engine</h1>
        <p className="text-text-secondary text-sm">Forrásokkal és YouTube-jelekkel validált creator témaajánlások.</p>
      </div>

      {profile && (
        <div className="card mb-4" style={{ background: 'rgba(59,130,246,0.05)', border: '1px solid rgba(59,130,246,0.15)' }}>
          <div className="flex items-center justify-between">
            <div className="flex gap-4 text-sm">
              <span className="text-text-muted">Niche: <span className="text-text-primary font-medium">{profile.niche || '—'}</span></span>
              <span className="text-text-muted">Platform: <span className="text-text-primary font-medium">{platformLabel(profile.platform)}</span></span>
              <span className="text-text-muted">Régió: <span className="text-text-primary font-medium">{regionLabel(profile.region)}</span></span>
            </div>
            <a href="/dashboard/profile" className="text-xs" style={{ color: '#3B82F6' }}>Szerkesztés →</a>
          </div>
        </div>
      )}

      <div className="card mb-6">
        <div className="flex gap-3">
          <input value={niche} onChange={e => setNiche(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleGenerateWithCreditCheck()}
            placeholder="pl. egészség, tech, pénzügy, sport..." className="input flex-1" />
          <button onClick={() => handleGenerateWithCreditCheck()} disabled={loading || !niche.trim()} className="btn-primary px-6 whitespace-nowrap">
            {loading ? 'Keresés...' : 'Témák keresése'}
          </button>
        </div>
        {cached && (
          <div className="flex items-center justify-between mt-2">
            <p className="text-text-muted text-xs flex items-center gap-1">
              <span>⚡</span> Mentett eredmény betöltve
            </p>
            <button onClick={() => {
              Object.keys(sessionStorage)
                .filter(key => key.startsWith('willviral_opportunities_'))
                .forEach(key => sessionStorage.removeItem(key))
              setCached(false)
              handleGenerateWithCreditCheck()
            }} className="text-xs" style={{ color: '#3B82F6' }}>
              ↻ Extra friss keresés
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="bg-rose/10 border border-rose/20 rounded-xl px-5 py-4 text-rose text-sm mb-6">{error}</div>
      )}
      {message && (
        <div className="rounded-xl px-5 py-4 mb-6 text-sm"
          style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.2)', color: '#F59E0B' }}>
          {message}
        </div>
      )}

      {loading && (
        <div className="card">
          <LoadingScreen steps={LOADING_STEPS.opportunity} message="Forrásokat, YouTube-jeleket és piaci rést ellenőrzünk" />
        </div>
      )}

      {!loading && topics.length > 0 && (() => {
        const validatedTopics = topics.filter(t => !isDiscoveryLane(t))
        const discoveryTopics = topics.filter(t => isDiscoveryLane(t))

        function handleDiscoverySearch(keyword: string) {
          setNiche(keyword)
          setActiveDrilldown(keyword)
          handleGenerateWithCreditCheck(
            { ...profile!, niche: keyword },
            { discoveryMode: 'drilldown', parentNiche: profile?.niche || niche, skipCache: true },
          )
        }

        return (
          <div className="space-y-6">
            {activeDrilldown && (
              <div className="rounded-xl px-4 py-3 text-sm flex items-center justify-between gap-3"
                style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)', color: '#BFDBFE' }}>
                <span>Konkrét témakeresés ebben az irányban: <strong>{activeDrilldown}</strong></span>
                <button onClick={() => { setActiveDrilldown(null); if (profile?.niche) { setNiche(profile.niche); handleGenerateWithCreditCheck(profile, { skipCache: true }) } }}
                  className="text-xs px-3 py-1 rounded-lg"
                  style={{ background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.25)', color: '#3B82F6' }}>
                  Vissza a niche-hez
                </button>
              </div>
            )}

            {validatedTopics.length > 0 && (
              <div>
                <p className="section-label mb-4">{validatedTopics.length} gyártható vagy korai lehetőség - WillViral sorrendben</p>
                {validatedTopics.every(t => t.confidence === 'alacsony' || t.confidence === 'nagyon_alacsony') && (
                  <div className="rounded-xl px-4 py-3 mb-4 text-sm"
                    style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', color: '#F59E0B' }}>
                    Kevés friss adat alapján számolva. Extra kereséssel vagy pontosabb niche-sel erősebb validáció kérhető.
                  </div>
                )}
                <div className="space-y-3">
                  {validatedTopics.map((topic, i) => (
                    <TopicCard key={topic.id} topic={topic} index={i} onReplace={handleReplace} hasPool={poolTopics.length > 0} />
                  ))}
                </div>
              </div>
            )}

            {discoveryTopics.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-sm" style={{ color: '#CBD5E1' }}>🧭</span>
                  <p className="section-label">Validálásra váró kutatási irányok</p>
                </div>
                <p className="text-xs mb-4" style={{ color: '#94A3B8' }}>
                  Ezek még nem kész gyártási ajánlások. A rendszer azért mutatja őket, mert a niche-en belül van témairány, de előbb konkrétabb forrásos témát kell keresni belőle.
                </p>
                <div className="space-y-2">
                  {discoveryTopics.map(topic => (
                    <DiscoveryLaneCard key={topic.id} topic={topic} onSearch={handleDiscoverySearch} />
                  ))}
                </div>
              </div>
            )}

            {validatedTopics.length === 0 && discoveryTopics.length > 0 && (
              <div className="rounded-xl px-4 py-3 text-sm"
                style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', color: '#F59E0B' }}>
                Ezen a keresésen most nincs elég erős gyártható téma. A kutatási irányokból egy kattintással konkrétabb, validálható témákat kereshetsz.
              </div>
            )}
          </div>
        )
      })()}
    </div>
  )
}
