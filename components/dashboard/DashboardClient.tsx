'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import type { CreatorProfile, CreatorMemoryItem, OpportunityTopic } from '@/types'

// ─── Score helpers ────────────────────────────────────────────
import { scoreColor, scoreLabel, scoreLabelColor } from '@/lib/score-utils'
import LoadingScreen, { LOADING_STEPS } from '@/components/ui/LoadingScreen'
import CreditConfirmModal from '@/components/CreditConfirmModal'
import type { UsageCheckResult } from '@/lib/usage-protection'
import TrendFeedHistory from '@/components/dashboard/TrendFeedHistory'
import CreatorIntelligenceSummary from '@/components/dashboard/CreatorIntelligenceSummary'
import { polishHungarianText } from '@/lib/hungarian-output-polish'

function getGreeting(): string {
  const hour = new Date().getHours()
  if (hour >= 5 && hour < 10) return 'Jó reggelt'
  if (hour >= 10 && hour < 18) return 'Szia'
  if (hour >= 18 && hour < 23) return 'Jó estét'
  return 'Szia'
}

function getTrendFeedWeekKey(): string {
  const now = new Date()
  const day = now.getDay() || 7
  const monday = new Date(now)
  monday.setHours(0, 0, 0, 0)
  monday.setDate(now.getDate() - day + 1)
  return monday.toISOString().slice(0, 10)
}

function cleanText(value: string | null | undefined): string {
  return value ? polishHungarianText(value) : ''
}

function ScoreBar({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs w-20 flex-shrink-0 truncate" style={{ color: '#CBD5E1' }}>{label}</span>
      <div className="flex-1 h-1 rounded-full" style={{ background: 'rgba(255,255,255,0.06)' }}>
        <div className="h-full rounded-full transition-all duration-500"
          style={{ width: `${value}%`, background: scoreColor(value) }} />
      </div>
      <span className="text-xs font-semibold w-6 text-right flex-shrink-0" style={{ color: scoreColor(value) }}>{value}</span>
    </div>
  )
}

// Verseny fordított logika — alacsony verseny = jó
function CompetitionBar({ value }: { value: number }) {
  const displayValue = 100 - value
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs w-20 flex-shrink-0 truncate" style={{ color: '#CBD5E1' }}>Szabad Piac</span>
      <div className="flex-1 h-1 rounded-full" style={{ background: 'rgba(255,255,255,0.06)' }}>
        <div className="h-full rounded-full transition-all duration-500"
          style={{ width: `${displayValue}%`, background: scoreColor(displayValue) }} />
      </div>
      <span className="text-xs font-semibold w-6 text-right flex-shrink-0" style={{ color: scoreColor(displayValue) }}>{displayValue}</span>
    </div>
  )
}

// ─── Dashboard Stats típus ────────────────────────────────────
interface DashboardStats {
  balance: number
  total_used: number
  plan: string
  today_credits_used: number
  today_generations: number
  last_activity: string | null
  saved_topics: number
  in_progress_topics: number
  completed_topics: number
  total_packages: number
  total_audits: number
  total_script_extracts: number
  opportunity_requests: number
  avg_audit_score: number | null
  daily_usage: { day: string; credits: number; count: number }[]
  platform_stats: { label: string; pct: number }[]
  has_data: boolean
}

type DashboardActivityType = 'video_package' | 'video_audit' | 'memory' | 'opportunity' | 'similar_videos' | 'script_extract' | 'transcript_extract' | 'viral_score'

interface DashboardSummaryLite {
  has_data: boolean
  command_center?: {
    has_video_ideas: boolean
    top_idea: {
      id: string
      title: string
      topic: string
      platform: string
      workflow_status: string
      opportunity_score: number | null
      viral_score: number | null
      proof_summary: string | null
      video_package_id: string | null
      href: string
      next_action: {
        label: string
        reason: string
        href: string
        tone: string
      } | null
    } | null
    ready_to_create: Array<{
      id: string
      title: string
      topic: string
      href: string
      video_package_id: string | null
      opportunity_score: number | null
      viral_score: number | null
      updated_at: string
    }>
    pipeline: {
      total: number
      new_idea: number
      validating: number
      validated: number
      ready_to_produce: number
      scheduled: number
      published: number
      rejected: number
    }
    next_best_action: {
      label: string
      reason: string
      href: string
      tone: string
    }
  }
  recent_activity: Array<{
    type: DashboardActivityType
    title: string
    topic: string
    href: string
    date: string
  }>
}

function normalizeTopicKey(value: string | null | undefined): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function activityMatchesTopic(activityTopic: string | null | undefined, topic: DashboardOpportunityTopic | null): boolean {
  if (!topic) return false
  const activityKey = normalizeTopicKey(activityTopic)
  const titleKey = normalizeTopicKey(topic.title)
  const keywordKey = normalizeTopicKey(topic.keyword)
  if (!activityKey) return false
  return (
    (!!titleKey && (activityKey.includes(titleKey) || titleKey.includes(activityKey))) ||
    (!!keywordKey && (activityKey.includes(keywordKey) || keywordKey.includes(activityKey)))
  )
}

// ─── Entry Points ─────────────────────────────────────────────
function EntryPointCards({ stats }: { stats: DashboardStats | null }) {
  const entryPoints = [
    {
      icon: 'ti-trending-up', title: 'Mit csináljak ma?', sub: 'Trendi témák a niche-edben',
      stat: stats ? `${stats.opportunity_requests || 0}` : '—',
      statLabel: stats?.opportunity_requests ? 'Téma lekérés' : 'Még nincs lekérés',
      cta: 'Témák felfedezése', href: '/dashboard/opportunities',
      color: '#3B82F6', gradient: 'rgba(59,130,246,0.08)',
    },
    {
      icon: 'ti-chart-bar', title: 'Megéri ez a téma?', sub: 'Virális esély elemzés',
      stat: stats?.avg_audit_score != null ? `${stats.avg_audit_score}` : '—',
      statLabel: stats?.avg_audit_score != null ? 'Átlagos Audit Score' : 'Még nincs audit',
      cta: 'Új elemzés indítása', href: '/dashboard/viral-score',
      color: '#8B5CF6', gradient: 'rgba(124,58,237,0.08)',
    },
    {
      icon: 'ti-stethoscope', title: 'Miért nem megy a videóm?', sub: 'Videódiagnózis elemzés',
      stat: stats ? `${stats.total_audits}` : '—',
      statLabel: stats?.total_audits ? `${stats.total_audits} elvégzett audit` : 'Még nincs audit',
      cta: 'Videó elemzése', href: '/dashboard/video-audit',
      color: '#22C55E', gradient: 'rgba(34,197,94,0.08)',
    },
    {
      icon: 'ti-file-text', title: 'YouTube videó elemzése', sub: 'Script kinyerése és elemzése',
      stat: stats ? `${stats.total_script_extracts || 0}` : '—',
      statLabel: stats?.total_script_extracts ? `${stats.total_script_extracts} script kinyerve` : 'Még nincs kinyerés',
      cta: 'Script kinyerése', href: '/dashboard/script-extractor',
      color: '#F59E0B', gradient: 'rgba(245,158,11,0.08)',
    },
  ]

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
      {entryPoints.map(ep => (
        <Link key={ep.href} href={ep.href}
          className="rounded-xl p-4 transition-all duration-200 hover:-translate-y-0.5 group"
          style={{ background: ep.gradient, border: `1px solid ${ep.color}22` }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = ep.color + '44'; (e.currentTarget as HTMLElement).style.boxShadow = `0 4px 20px ${ep.color}15` }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = ep.color + '22'; (e.currentTarget as HTMLElement).style.boxShadow = 'none' }}>
          <div className="w-10 h-10 rounded-full flex items-center justify-center mb-2" style={{ background: `${ep.color}26` }}>
            <i className={`ti ${ep.icon} text-lg`} style={{ color: ep.color }} />
          </div>
          <div className="text-2xl font-black mb-0.5" style={{ color: ep.stat === '—' ? '#94A3B8' : ep.color }}>{ep.stat}</div>
          <div className="text-xs mb-2" style={{ color: '#CBD5E1' }}>{ep.statLabel}</div>
          <div className="text-sm font-semibold text-text-primary mb-1">{ep.title}</div>
          <div className="text-xs" style={{ color: '#CBD5E1' }}>{ep.sub}</div>
          <div className="mt-3 text-xs font-semibold flex items-center gap-1 transition-all" style={{ color: ep.color }}>
            {ep.cta} →
          </div>
        </Link>
      ))}
    </div>
  )
}

// ─── Quick Actions ────────────────────────────────────────────
const quickActions = [
  { icon: 'ti-chart-bar', label: 'Virális esély', sub: 'Elemzés', href: '/dashboard/viral-score', color: '#8B5CF6' },
  { icon: 'ti-stethoscope', label: 'Videódiagnózis', sub: 'Elemzés', href: '/dashboard/video-audit', color: '#22C55E' },
  { icon: 'ti-file-text', label: 'Script', sub: 'Kinyerés', href: '/dashboard/script-extractor', color: '#F59E0B' },
  { icon: 'ti-player-play', label: 'Piaci bizonyítékok', sub: 'Keresés', href: '/dashboard/similar-videos', color: '#3B82F6' },
  { icon: 'ti-package', label: 'Videócsomag', sub: 'Generálás', href: '/dashboard/video-package', color: '#EC4899' },
]

// ─── Trend Row ───────────────────────────────────────────────
function TrendRow({ topic, index }: { topic: DashboardOpportunityTopic; index: number }) {
  const ready = getReadyMeta(topic)
  const thumbUrl = topic.evidence_videos?.[0]?.thumbnail_url || null

  return (
    <Link href={`/dashboard/opportunities`}
      className="flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-150 hover:-translate-y-0.5"
      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = 'rgba(59,130,246,0.2)'; (e.currentTarget as HTMLElement).style.boxShadow = '0 4px 20px rgba(0,0,0,0.3)' }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'rgba(255,255,255,0.06)'; (e.currentTarget as HTMLElement).style.boxShadow = 'none' }}>

      <span className="text-xs font-mono w-5 text-center flex-shrink-0" style={{ color: '#94A3B8' }}>{index + 1}</span>

      <div className="w-12 h-8 rounded-lg overflow-hidden flex-shrink-0" style={{ background: '#121826' }}>
        {thumbUrl ? <img src={thumbUrl} alt="" className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center"><i className="ti ti-player-play text-xs" style={{ color: '#94A3B8' }} /></div>}
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate" style={{ color: '#F8FAFC' }}>{topic.title}</p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs px-1.5 py-0.5 rounded-full" style={{ background: ready.bg, color: ready.color, fontSize: '10px' }}>{ready.label}</span>
        </div>
      </div>

      <div className="text-right flex-shrink-0">
        <div className="text-lg font-bold" style={{ color: scoreColor(topic.opportunity_score) }}>{topic.opportunity_score}</div>
        <div className="text-xs" style={{ color: '#94A3B8' }}>{scoreLabel(topic.opportunity_score)}</div>
      </div>
    </Link>
  )
}

type DashboardOpportunityTopic = OpportunityTopic

function isProductionCandidate(topic: DashboardOpportunityTopic) {
  return topic.ready_to_produce_status === 'ready' || topic.ready_to_produce_status === 'watch'
}

function isDiscoveryOrResearch(topic: DashboardOpportunityTopic) {
  return (
    topic.ready_to_produce_status === 'research' ||
    topic.ready_to_produce_status === 'rejected' ||
    topic.trend_source_type === 'broad_niche_discovery' ||
    topic.trend_source_type === 'research_fallback' ||
    (!topic.web_sources?.length && !topic.evidence_videos?.length)
  )
}

function getReadyMeta(topic: DashboardOpportunityTopic) {
  if (topic.ready_to_produce_status === 'ready') {
    return { label: cleanText(topic.ready_to_produce_label) || 'Gyártható', color: '#22C55E', bg: 'rgba(34,197,94,0.1)' }
  }
  if (topic.ready_to_produce_status === 'watch') {
    return { label: cleanText(topic.ready_to_produce_label) || 'Korai lehetőség', color: '#F59E0B', bg: 'rgba(245,158,11,0.1)' }
  }
  if (topic.ready_to_produce_status === 'rejected') {
    return { label: cleanText(topic.ready_to_produce_label) || 'Nem ajánlott', color: '#EF4444', bg: 'rgba(239,68,68,0.1)' }
  }
  return { label: cleanText(topic.ready_to_produce_label) || 'Kutatás kell', color: '#CBD5E1', bg: 'rgba(139,155,180,0.08)' }
}

function buildPackageUrl(topic: DashboardOpportunityTopic) {
  const params = new URLSearchParams({
    topic: topic.title,
    keyword: topic.keyword || '',
    opportunity_id: topic.id,
    source_context: 'opportunity_engine',
  })
  return `/dashboard/video-package?${params.toString()}`
}

function storePackageContext(topic: DashboardOpportunityTopic) {
  const payload = {
    id: topic.id,
    title: topic.title,
    keyword: topic.keyword || '',
    description: topic.description,
    confidence: topic.confidence,
    trend_source_type: topic.trend_source_type,
    trend_source_label: topic.trend_source_label,
    ready_to_produce_status: topic.ready_to_produce_status,
    ready_to_produce_label: topic.ready_to_produce_label,
    opportunity_score: topic.opportunity_score,
    evidence_match_score: topic.evidence_match_score || null,
    risk_flags: topic.risk_flags || [],
    score_breakdown: topic.score_breakdown,
    hook_suggestion: topic.hook_suggestion,
    web_sources: topic.web_sources || [],
    evidence_videos: topic.evidence_videos || [],
  }
  sessionStorage.setItem(`willviral_opportunity_package_${topic.id}`, JSON.stringify(payload))
}

function topicDashboardWeight(topic: DashboardOpportunityTopic) {
  if (topic.ready_to_produce_status === 'ready') return 4000
  if (topic.ready_to_produce_status === 'watch') return 3000
  if (topic.ready_to_produce_status === 'research') return 1500
  if (topic.trend_source_type === 'broad_niche_discovery' || topic.trend_source_type === 'research_fallback') return 800
  return 0
}

function topicDashboardScore(topic: DashboardOpportunityTopic) {
  return topicDashboardWeight(topic) + (topic.decision_score || topic.evidence_match_score || topic.opportunity_score || 0)
}

function pickBestTopic(topics: DashboardOpportunityTopic[]) {
  return [...topics]
    .filter(topic => topic.ready_to_produce_status !== 'rejected')
    .sort((a, b) => topicDashboardScore(b) - topicDashboardScore(a))[0] || null
}

function getTodayActionMeta(topic: DashboardOpportunityTopic) {
  if (topic.ready_to_produce_status === 'ready') {
    return {
      title: 'Ma ezt gyártsd le',
      body: 'Van elég erős jel ahhoz, hogy ebből videócsomag készüljön. Ne új ötletet keress, ezt vidd végig gyártásig.',
      outcome: 'Kész hook, narráció, címek és gyártási terv.',
      icon: 'ti-package',
      color: '#22C55E',
    }
  }
  if (topic.ready_to_produce_status === 'watch') {
    return {
      title: 'Ma ezt validáld, utána gyárts',
      body: 'A téma ígéretes, de előbb nézd meg a hasonló videókat vagy futtass Virális esély elemzést, hogy ne gyenge jelre építs.',
      outcome: 'Döntés: mehet videócsomagba vagy új téma kell.',
      icon: 'ti-shield-check',
      color: '#F59E0B',
    }
  }
  return {
    title: 'Ma ebből keress erősebb bizonyítékot',
    body: 'Ez még kutatási nyom, nem gyártási ajánlás. A cél most nem a csomagkészítés, hanem piaci bizonyíték gyűjtése.',
    outcome: 'Erősebb Piaci bizonyíték lista vagy elvetett téma.',
    icon: 'ti-search',
    color: '#F59E0B',
  }
}

// ─── Opportunity Card ─────────────────────────────────────────
function OpportunityCard({ topic }: { topic: DashboardOpportunityTopic }) {
  const [saved, setSaved] = useState(false)
  const thumbUrl = topic.evidence_videos?.[0]?.thumbnail_url || null
  const ready = getReadyMeta(topic)
  const canCreatePackage = isProductionCandidate(topic)
  const validationHref = `/dashboard/similar-videos?topic=${encodeURIComponent(topic.keyword || topic.title)}`

  async function handleSave(e: React.MouseEvent) {
    e.preventDefault()
    await fetch('/api/memory', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: topic.title, search_keyword: topic.keyword,
        state: 'saved', opportunity_score: topic.opportunity_score,
      }),
    })
    setSaved(true)
  }

  return (
    <div className="rounded-xl overflow-hidden transition-all duration-200 hover:-translate-y-0.5"
      style={{ background: '#0F1420', border: '1px solid rgba(255,255,255,0.08)' }}
      onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(59,130,246,0.2)')}
      onMouseLeave={e => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)')}>
      <div className="flex gap-4 p-4">
        <div className="w-24 h-16 rounded-lg overflow-hidden flex-shrink-0 relative"
          style={{ background: 'linear-gradient(135deg, #121826, rgba(255,255,255,0.08))' }}>
          {thumbUrl ? (
            <img src={thumbUrl} alt="" className="w-full h-full object-cover" />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-2xl opacity-40">🎬</div>
          )}
          {topic.confidence && (
            <div className="absolute top-1 left-1 text-xs px-1 py-0.5 rounded font-semibold"
              style={{ background: topic.confidence === 'magas' ? 'rgba(34,197,94,0.9)' : 'rgba(245,158,11,0.9)', color: '#080B12', fontSize: '9px' }}>
              {topic.confidence === 'magas' ? '✓ Magas' : topic.confidence === 'közepes' ? '~ Közepes' : '! Alacsony'}
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-1 flex-wrap">
            <span className="text-xs px-2 py-0.5 rounded-full font-semibold"
              style={{ background: ready.bg, color: ready.color, border: `1px solid ${ready.color}30` }}>
              {ready.label}
            </span>
            {topic.evidence_match_score && (
              <span className="text-xs" style={{ color: '#94A3B8' }}>Bizonyíték erőssége: {topic.evidence_match_score}/100</span>
            )}
          </div>
          <h3 className="font-semibold text-sm leading-snug mb-1 line-clamp-2" style={{ color: '#F8FAFC' }}>{topic.title}</h3>
          <p className="text-xs leading-relaxed" style={{ color: '#CBD5E1' }}>{topic.description}</p>
        </div>

        <div className="flex-shrink-0 w-40">
          <div className="flex items-start justify-between mb-2">
            <div>
              <div className="text-xs mb-0.5" style={{ color: '#CBD5E1' }}>Score</div>
              <div className="text-2xl font-black leading-none" style={{ color: scoreColor(topic.opportunity_score) }}>
                {topic.opportunity_score}
              </div>
              <div className="text-xs mt-0.5 font-medium" style={{ color: scoreLabelColor(topic.opportunity_score) }}>
                {scoreLabel(topic.opportunity_score)}
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <button onClick={handleSave} title="Mentés"
                className="w-7 h-7 rounded-lg flex items-center justify-center transition-all text-sm"
                style={{ background: saved ? 'rgba(34,197,94,0.15)' : '#121826', border: '1px solid rgba(255,255,255,0.08)', color: saved ? '#22C55E' : '#CBD5E1' }}>
                {saved ? '✓' : '🔖'}
              </button>
              <Link href={`/dashboard/viral-score?topic=${encodeURIComponent(topic.keyword || topic.title)}`} title="Elemzés"
                className="w-7 h-7 rounded-lg flex items-center justify-center transition-all text-sm"
                style={{ background: '#121826', border: '1px solid rgba(255,255,255,0.08)', color: '#CBD5E1' }}>
                📊
              </Link>
            </div>
          </div>

          <div className="space-y-1.5">
            <ScoreBar label="Trend" value={topic.score_breakdown.trend_momentum} />
            <ScoreBar label="Niche" value={topic.score_breakdown.niche_match} />
            <ScoreBar label="Tartalmi rés" value={topic.score_breakdown.content_gap} />
            <CompetitionBar value={topic.score_breakdown.competition} />
          </div>

          {canCreatePackage ? (
            <Link href={buildPackageUrl(topic)}
              onClick={() => storePackageContext(topic)}
              className="mt-3 w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-semibold transition-all"
              style={{ background: 'linear-gradient(135deg, #3B82F6, #8B5CF6)', color: '#fff' }}>
              🎬 Videócsomag
            </Link>
          ) : (
            <Link href={validationHref}
              className="mt-3 w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-semibold transition-all"
              style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', color: '#F59E0B' }}>
              🔎 Előbb validálás
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}

function BestTopicToday({ topic, onLoad, loading, hasProfile }: {
  topic: DashboardOpportunityTopic | null
  onLoad: () => void
  loading: boolean
  hasProfile: boolean
}) {
  if (!topic) {
    return (
      <div className="rounded-xl p-5 mb-5" style={{ background: 'linear-gradient(135deg, rgba(59,130,246,0.1), rgba(139,92,246,0.08))', border: '1px solid rgba(59,130,246,0.15)' }}>
        <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: '#3B82F6' }}>HETI TOP OPPORTUNITY</p>
        <h2 className="text-xl font-bold text-text-primary mb-2">Heti Top Opportunity</h2>
        <p className="text-sm mb-4" style={{ color: '#CBD5E1' }}>
          {hasProfile ? 'Betöltjük a heti validált ajánlást, és megmutatjuk a következő legjobb lépést.' : 'A profil kitöltése után tudunk személyre szabott témát ajánlani.'}
        </p>
        {hasProfile ? (
          <button onClick={onLoad} disabled={loading} className="btn-primary">
            {loading ? 'Keresés...' : 'Heti ajánlás betöltése'}
          </button>
        ) : (
          <Link href="/dashboard/profile" className="btn-primary">Profil kitöltése</Link>
        )}
      </div>
    )
  }

  const ready = getReadyMeta(topic)
  const isResearchTopic = !isProductionCandidate(topic)
  const heroEyebrow = isResearchTopic ? 'ELLENŐRIZENDŐ LEHETŐSÉG' : 'HETI TOP OPPORTUNITY'
  const packageLabel = isResearchTopic ? 'Videócsomag előkészítése' : 'Videócsomag készítése'
  const webCount = topic.web_sources?.length || 0
  const videoCount = topic.evidence_videos?.length || 0

  return (
    <div className="rounded-xl p-5 mb-5" style={{ background: 'linear-gradient(135deg, rgba(59,130,246,0.1), rgba(139,92,246,0.08))', border: '1px solid rgba(59,130,246,0.15)' }}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: '#3B82F6' }}>{heroEyebrow}</p>
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <span className="text-xs px-2 py-0.5 rounded-full font-semibold" style={{ background: ready.bg, color: ready.color, border: `1px solid ${ready.color}30` }}>{ready.label}</span>
            <span className="text-xs" style={{ color: '#CBD5E1' }}>{webCount} webes forrás · {videoCount} bizonyíték videó</span>
            {topic.evidence_match_score && <span className="text-xs" style={{ color: '#CBD5E1' }}>Bizonyíték: {topic.evidence_match_score}/100</span>}
          </div>
          <h2 className="text-xl font-bold leading-snug mb-2" style={{ color: '#F8FAFC' }}>{topic.title}</h2>
          <p className="text-sm leading-relaxed mb-3" style={{ color: '#CBD5E1' }}>{topic.description}</p>
          {topic.hook_suggestion && (
            <p className="text-xs rounded-lg px-3 py-2" style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.15)', color: '#CBD5E1' }}>
              <span style={{ color: '#3B82F6' }} className="font-semibold">Hook: </span>{topic.hook_suggestion}
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-2 flex-shrink-0">
          <div className="text-right">
            <div className="text-xs mb-0.5" style={{ color: '#CBD5E1' }}>Opportunity</div>
            <div className="font-black leading-none" style={{ fontSize: '32px', color: scoreColor(topic.opportunity_score) }}>{topic.opportunity_score}</div>
            <div className="text-xs mt-1 font-medium" style={{ color: scoreLabelColor(topic.opportunity_score) }}>{scoreLabel(topic.opportunity_score)}</div>
          </div>
          <Link href={buildPackageUrl(topic)}
            onClick={() => storePackageContext(topic)}
            className="px-4 py-2 rounded-lg text-sm font-semibold transition-all"
            style={{ background: 'linear-gradient(135deg, #3B82F6, #8B5CF6)', color: '#fff' }}>
            {packageLabel}
          </Link>
          {isResearchTopic && (
            <Link href={`/dashboard/similar-videos?topic=${encodeURIComponent(topic.keyword || topic.title)}`}
              className="px-4 py-2 rounded-lg text-sm font-semibold transition-all"
              style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', color: '#F59E0B' }}>
              Validálás Piaci bizonyítékokkal
            </Link>
          )}
          <Link href="/dashboard/opportunities" className="text-xs" style={{ color: '#CBD5E1' }}>Részletek megnyitása</Link>
        </div>
      </div>
    </div>
  )
}

// ─── Right Panel ──────────────────────────────────────────────
function CreatorPipelineStrip() {
  const steps = [
    { icon: 'ti-bulb', label: 'Heti téma', sub: 'Top Opportunity', color: '#3B82F6' },
    { icon: 'ti-shield-check', label: 'Validálás', sub: 'Forrás + videójel', color: '#F59E0B' },
    { icon: 'ti-package', label: 'Videócsomag', sub: 'Gyártásra kész', color: '#22C55E' },
  ]

  return (
    <div className="grid grid-cols-3 gap-3 mb-5">
      {steps.map((step, index) => (
        <div key={step.label} className="rounded-xl px-4 py-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="flex items-center gap-2">
            <span className="w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold" style={{ background: `${step.color}18`, color: step.color }}>
              {index + 1}
            </span>
            <i className={`ti ${step.icon}`} style={{ color: step.color }} />
            <div className="min-w-0">
              <p className="text-sm font-semibold truncate" style={{ color: '#F8FAFC' }}>{step.label}</p>
              <p className="text-xs truncate" style={{ color: '#94A3B8' }}>{step.sub}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function CreatorCommandCenter({ summary }: { summary: DashboardSummaryLite | null }) {
  const command = summary?.command_center
  if (!command) return null

  const topIdea = command.top_idea
  const action = command.next_best_action
  const pipeline = command.pipeline
  const actionColor = action.tone === 'ready' ? '#22C55E' : action.tone === 'package' ? '#3B82F6' : action.tone === 'validate' ? '#F59E0B' : '#8B5CF6'

  return (
    <div className="rounded-2xl p-5 mb-6" style={{ background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.08)', boxShadow: '0 18px 50px rgba(0,0,0,0.30)' }}>
      <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4 mb-5">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: '#22D3EE' }}>Creator központ</p>
          <h2 className="text-lg font-bold" style={{ color: '#F8FAFC' }}>
            {topIdea ? 'A következő legjobb gyártási döntésed' : 'Építsünk központi ötletpipeline-t'}
          </h2>
          <p className="text-sm mt-1 max-w-2xl" style={{ color: '#CBD5E1' }}>
            {topIdea
              ? 'A WillViral most már Video Idea-ként kezeli az ötleteket, így a validálás, csomag és memória egy folyamatba kerül.'
              : 'Még nincs Video Idea adat. Indíts egy témakeresést vagy ments egy ötletet, és innen fog összeállni a creator OS pipeline.'}
          </p>
        </div>
        <Link href={action.href} className="px-4 py-2.5 rounded-xl text-sm font-semibold text-center flex-shrink-0"
          style={{ background: `${actionColor}1A`, border: `1px solid ${actionColor}40`, color: actionColor }}>
          {action.label}
        </Link>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1.25fr_0.75fr] gap-4">
        <div className="rounded-xl p-4" style={{ background: 'rgba(8,13,24,0.55)', border: `1px solid ${actionColor}26` }}>
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: `${actionColor}18`, color: actionColor }}>
              <i className={`ti ${topIdea?.video_package_id ? 'ti-package' : action.tone === 'validate' ? 'ti-shield-check' : 'ti-bulb'}`} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold mb-1" style={{ color: actionColor }}>{action.label}</p>
              <h3 className="text-base font-semibold leading-snug" style={{ color: '#F8FAFC' }}>
                {topIdea?.title || 'Keress egy validálható videólehetőséget'}
              </h3>
              <p className="text-xs leading-relaxed mt-2" style={{ color: '#CBD5E1' }}>{action.reason}</p>
              {topIdea?.proof_summary && (
                <p className="text-xs leading-relaxed mt-2" style={{ color: '#94A3B8' }}>{topIdea.proof_summary}</p>
              )}
            </div>
            {topIdea && (
              <div className="flex gap-2 flex-shrink-0">
                {topIdea.opportunity_score != null && (
                  <div className="text-center">
                    <div className="text-lg font-bold" style={{ color: scoreColor(topIdea.opportunity_score) }}>{topIdea.opportunity_score}</div>
                    <div className="text-[10px]" style={{ color: '#94A3B8' }}>Opp</div>
                  </div>
                )}
                {topIdea.viral_score != null && (
                  <div className="text-center">
                    <div className="text-lg font-bold" style={{ color: scoreColor(topIdea.viral_score) }}>{topIdea.viral_score}</div>
                    <div className="text-[10px]" style={{ color: '#94A3B8' }}>Viral</div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-4 lg:grid-cols-2 gap-2">
          {[
            { label: 'Ötlet', value: pipeline.total, color: '#3B82F6' },
            { label: 'Validálás', value: pipeline.validating + pipeline.validated, color: '#F59E0B' },
            { label: 'Gyártható', value: pipeline.ready_to_produce, color: '#22C55E' },
            { label: 'Publikált', value: pipeline.published, color: '#8B5CF6' },
          ].map(item => (
            <div key={item.label} className="rounded-xl p-3" style={{ background: `${item.color}0D`, border: `1px solid ${item.color}22` }}>
              <div className="text-xl font-black" style={{ color: item.color }}>{item.value}</div>
              <div className="text-xs" style={{ color: '#CBD5E1' }}>{item.label}</div>
            </div>
          ))}
        </div>
      </div>

      {command.ready_to_create.length > 0 && (
        <div className="mt-4 pt-4" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <p className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: '#94A3B8' }}>Gyártásra vár</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {command.ready_to_create.slice(0, 2).map(idea => (
              <Link key={idea.id} href={idea.href} className="rounded-xl px-3 py-2 flex items-center justify-between gap-3 transition-all hover:bg-white/[0.03]" style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <span className="text-sm truncate" style={{ color: '#F8FAFC' }}>{idea.title}</span>
                <i className="ti ti-arrow-up-right flex-shrink-0" style={{ color: '#22C55E' }} />
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function FirstRunLaunchPad({
  profile,
  loading,
  hasTopic,
  hasData,
}: {
  profile: CreatorProfile | null
  loading: boolean
  hasTopic: boolean
  hasData: boolean
}) {
  if (!profile?.niche) return null

  const steps = [
    {
      label: 'Téma kiválasztása',
      body: hasTopic ? 'Megvan az első ajánlott irány.' : loading ? 'Most keresünk validálható témát.' : 'Indítsd el az első keresést.',
      state: hasTopic ? 'done' : loading ? 'active' : 'next',
    },
    {
      label: 'Bizonyíték ellenőrzése',
      body: 'Piaci bizonyítékok és Virális esély segít eldönteni, érdemes-e gyártani.',
      state: hasTopic ? 'next' : 'locked',
    },
    {
      label: 'Videócsomag készítése',
      body: 'Hook, narráció, címek, leírás és gyártási brief egy helyen.',
      state: hasTopic ? 'next' : 'locked',
    },
  ] as const

  return (
    <div className="rounded-2xl p-5 mb-6" style={{ background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.18)' }}>
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 mb-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: '#3B82F6' }}>
            {hasData ? 'Mai gyártási útvonal' : 'Első 5 perces indulás'}
          </p>
          <h2 className="text-lg font-bold" style={{ color: '#F8FAFC' }}>
            {hasData ? 'Folytasd ott, ahol érték keletkezik' : 'Építsük fel az első gyártható videódat'}
          </h2>
          <p className="text-sm mt-1" style={{ color: '#CBD5E1' }}>
            Profil: <span style={{ color: '#F8FAFC', fontWeight: 600 }}>{profile.niche}</span>. A cél nem több menüpont kipróbálása, hanem egy döntés: gyártható-e ma ebből videó.
          </p>
        </div>
        <Link href="/dashboard/opportunities" className="px-4 py-2 rounded-xl text-sm font-semibold text-center"
          style={{ background: 'linear-gradient(135deg, #3B82F6, #8B5CF6)', color: '#fff' }}>
          Videólehetőségek
        </Link>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {steps.map((step, index) => {
          const color = step.state === 'done' ? '#22C55E' : step.state === 'active' ? '#3B82F6' : step.state === 'next' ? '#F59E0B' : '#64748B'
          return (
            <div key={step.label} className="rounded-xl px-4 py-3" style={{ background: 'rgba(8,13,24,0.45)', border: `1px solid ${color}22` }}>
              <div className="flex items-center gap-2 mb-2">
                <span className="w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold" style={{ background: `${color}1A`, color }}>
                  {step.state === 'done' ? '✓' : index + 1}
                </span>
                <p className="text-sm font-semibold" style={{ color: '#F8FAFC' }}>{step.label}</p>
              </div>
              <p className="text-xs leading-relaxed" style={{ color: '#CBD5E1' }}>{step.body}</p>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function FirstVideoFlow({
  profile,
  topic,
  stats,
  summary,
  loading,
}: {
  profile: CreatorProfile | null
  topic: DashboardOpportunityTopic | null
  stats: DashboardStats | null
  summary: DashboardSummaryLite | null
  loading: boolean
}) {
  if (!profile?.niche) return null

  const topicActivities = summary?.recent_activity?.filter(activity => activityMatchesTopic(activity.topic, topic)) || []
  const hasSimilarForTopic = topicActivities.some(activity => activity.type === 'similar_videos')
  const hasViralForTopic = topicActivities.some(activity => activity.type === 'viral_score')
  const hasPackageForTopic = topicActivities.some(activity => activity.type === 'video_package')
  const hasAnyPackage = (stats?.total_packages || 0) > 0
  const validationDone = hasSimilarForTopic || hasViralForTopic
  const topicReady = topic ? isProductionCandidate(topic) : false
  const topicNeedsValidation = !!topic && !topicReady
  const topicText = topic ? cleanText(topic.title) : profile.niche
  const similarHref = topic ? `/dashboard/similar-videos?topic=${encodeURIComponent(topic.keyword || topic.title)}` : '/dashboard/opportunities'
  const viralHref = topic ? `/dashboard/viral-score?topic=${encodeURIComponent(topic.keyword || topic.title)}` : '/dashboard/viral-score'
  const packageHref = topic ? buildPackageUrl(topic) : '/dashboard/video-package'

  const steps = [
    {
      label: '1. Találj témát',
      body: topic
        ? 'Van egy kiinduló téma, amit tovább lehet vinni.'
        : loading
          ? 'Most keressük az első validálható témát.'
          : 'Kezdj egy Opportunity kereséssel a profilod alapján.',
      state: topic ? 'done' : loading ? 'active' : 'next',
      href: '/dashboard/opportunities',
      cta: topic ? 'Téma részletei' : 'Téma keresése',
      color: '#3B82F6',
    },
    {
      label: '2. Validáld',
      body: validationDone
        ? 'Ehhez a témához már van validációs jel. Innen dönthető el, mehet-e gyártásba.'
        : topicReady
        ? 'A jel elég erős, de a Piaci bizonyítékok tovább erősítik a döntést.'
        : topicNeedsValidation
          ? 'Ez még kutatási irány. Előbb nézd meg, vannak-e erős hasonló videók.'
          : 'A téma után jön a Piaci bizonyítékok és Virális esély ellenőrzés.',
      state: validationDone ? 'done' : topic ? 'active' : 'locked',
      href: similarHref,
      cta: hasViralForTopic && !hasSimilarForTopic ? 'Piaci bizonyítékok' : 'Piaci bizonyítékok',
      color: '#F59E0B',
    },
    {
      label: '3. Készíts csomagot',
      body: hasPackageForTopic
        ? 'Ehhez a témához már készült videócsomag. Következőnek új témát vihetsz végig.'
        : topicReady || validationDone
          ? 'Most ebből már készülhet hook, narráció, cím és gyártási brief.'
          : hasAnyPackage
            ? 'Van már korábbi videócsomagod, de ennél a témánál előbb validálj.'
          : 'A videócsomag akkor legyen a következő lépés, ha a validáció átment.',
      state: hasPackageForTopic ? 'done' : (topicReady || validationDone) ? 'active' : 'locked',
      href: packageHref,
      cta: hasPackageForTopic ? 'Új téma' : 'Videócsomag',
      color: '#22C55E',
    },
  ] as const

  const flowComplete = !!topic && hasPackageForTopic
  const primaryStep = steps.find(step => step.state === 'active') || steps.find(step => step.state === 'next') || steps[2]
  const primaryHref = flowComplete ? '/dashboard/opportunities' : primaryStep.label.startsWith('3.') ? packageHref : primaryStep.href
  const primaryLabel = flowComplete ? 'Új téma keresése' : 'Következő lépés'

  return (
    <section className="mb-6 rounded-2xl overflow-hidden" style={{ background: '#0E1422', border: '1px solid rgba(255,255,255,0.08)' }}>
      <div className="px-5 py-4 border-b border-white/10 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: '#22C55E' }}>Első videó elkészítése</p>
          <h2 className="text-lg font-bold truncate" style={{ color: '#F8FAFC' }}>{topicText}</h2>
          <p className="text-sm mt-1" style={{ color: '#CBD5E1' }}>
            Egy útvonal, nem menülista: téma, bizonyíték, majd gyártható videócsomag.
          </p>
          {topic && (
            <div className="flex flex-wrap gap-2 mt-3">
              {[
                { label: 'Piaci bizonyítékok', done: hasSimilarForTopic },
                { label: 'Virális esély', done: hasViralForTopic },
                { label: 'Videócsomag', done: hasPackageForTopic },
              ].map(item => (
                <span key={item.label} className="text-xs px-2 py-1 rounded-full"
                  style={{ background: item.done ? 'rgba(34,197,94,0.12)' : 'rgba(255,255,255,0.04)', color: item.done ? '#22C55E' : '#94A3B8', border: `1px solid ${item.done ? 'rgba(34,197,94,0.25)' : 'rgba(255,255,255,0.08)'}` }}>
                  {item.done ? '✓' : '–'} {item.label}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex gap-2 flex-wrap">
          <Link href={primaryHref}
            onClick={() => { if (topic && !flowComplete && primaryStep.label.startsWith('3.')) storePackageContext(topic) }}
            className="px-4 py-2 rounded-xl text-sm font-semibold"
            style={{ background: 'linear-gradient(135deg, #22C55E, #3B82F6)', color: '#fff' }}>
            {primaryLabel}
          </Link>
          {topic && (
            <Link href={viralHref} className="px-4 py-2 rounded-xl text-sm"
              style={{ background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.25)', color: '#A78BFA' }}>
              Virális esély
            </Link>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-0">
        {steps.map(step => {
          const isLocked = step.state === 'locked'
          const activeBorder = step.state === 'active' ? step.color : 'rgba(255,255,255,0.06)'
          return (
            <Link key={step.label}
              href={isLocked ? '#' : hasPackageForTopic && step.label.startsWith('3.') ? '/dashboard/opportunities' : step.href}
              onClick={e => {
                if (isLocked) e.preventDefault()
                if (!isLocked && topic && !hasPackageForTopic && step.label.startsWith('3.')) storePackageContext(topic)
              }}
              className="p-5 transition-all"
              style={{ borderRight: '1px solid rgba(255,255,255,0.06)', borderTop: `2px solid ${activeBorder}`, opacity: isLocked ? 0.55 : 1 }}>
              <div className="flex items-center gap-2 mb-2">
                <span className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold"
                  style={{ background: `${step.color}1A`, color: step.color }}>
                  {step.state === 'done' ? '✓' : step.state === 'locked' ? '-' : '→'}
                </span>
                <p className="text-sm font-semibold" style={{ color: '#F8FAFC' }}>{step.label}</p>
              </div>
              <p className="text-xs leading-relaxed mb-3" style={{ color: '#CBD5E1' }}>{step.body}</p>
              <span className="text-xs font-semibold" style={{ color: isLocked ? '#64748B' : step.color }}>
                {isLocked ? 'Előbb az előző lépés' : step.cta}
              </span>
            </Link>
          )
        })}
      </div>
    </section>
  )
}

function RightPanel({ memoryItems, stats, bestTopic }: { memoryItems: CreatorMemoryItem[]; stats: DashboardStats | null; bestTopic: DashboardOpportunityTopic | null }) {
  const saved = memoryItems.filter(i => i.state === 'saved').length
  const inProgress = memoryItems.filter(i => i.state === 'in_progress').length
  const completed = memoryItems.filter(i => i.state === 'completed').length
  const maxCredits = Math.max(...(stats?.daily_usage.map(d => d.credits) || [1]), 1)
  const bestScore = bestTopic?.opportunity_score || 0

  return (
    <div className="space-y-4">
      {/* Opportunity Engine Widget */}
      <div className="rounded-2xl p-5" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-sm" style={{ color: '#F8FAFC' }}>
            <i className="ti ti-bulb mr-1.5" style={{ color: '#3B82F6' }} />Videólehetőségek
          </h3>
          <Link href="/dashboard/opportunities" className="text-xs" style={{ color: '#3B82F6' }}>Megnyitás →</Link>
        </div>
        <div className="flex items-center justify-center py-3">
          <div className="relative w-24 h-24">
            <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
              <circle cx="50" cy="50" r="42" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="8" />
              <circle cx="50" cy="50" r="42" fill="none" stroke={scoreColor(bestScore)} strokeWidth="8"
                strokeDasharray={`${bestScore * 2.64} 264`} strokeLinecap="round"
                style={{ transition: 'stroke-dasharray 1s ease' }} />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-2xl font-bold" style={{ color: scoreColor(bestScore) }}>{bestScore}</span>
            </div>
          </div>
        </div>
        <div className="text-center">
          <p className="text-sm font-medium" style={{ color: scoreLabelColor(bestScore) }}>{bestScore > 0 ? scoreLabel(bestScore) : 'Nincs adat'}</p>
          <p className="text-xs mt-1" style={{ color: '#94A3B8' }}>{bestScore > 0 ? 'Legjobb téma pontszáma' : 'Kattints a keresésre'}</p>
        </div>
        <Link href="/dashboard/opportunities" className="mt-3 w-full flex items-center justify-center gap-2 py-2 rounded-xl text-xs font-semibold transition-all"
          style={{ background: 'linear-gradient(135deg, #3B82F6, #8B5CF6)', color: '#fff', boxShadow: '0 0 15px rgba(59,130,246,0.2)' }}>
          <i className="ti ti-sparkles text-sm" /> Elemzés most
        </Link>
      </div>

      {/* Viral Score Quick */}
      <div className="rounded-2xl p-5" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-sm" style={{ color: '#F8FAFC' }}>
            <i className="ti ti-chart-bar mr-1.5" style={{ color: '#8B5CF6' }} />Virális esély
          </h3>
        </div>
        <p className="text-xs mb-3" style={{ color: '#94A3B8' }}>Írd be a videó ötleted, adj kulcsszavakat</p>
        <Link href="/dashboard/viral-score" className="w-full flex items-center justify-center gap-2 py-2 rounded-xl text-xs font-medium transition-all"
          style={{ background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.2)', color: '#8B5CF6' }}>
          Elemzés most →
        </Link>
      </div>

      {/* Video Audit - Last */}
      {stats?.total_audits && stats.total_audits > 0 ? (
        <div className="rounded-2xl p-5" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-sm" style={{ color: '#F8FAFC' }}>
              <i className="ti ti-stethoscope mr-1.5" style={{ color: '#22C55E' }} />Videódiagnózis
            </h3>
            <Link href="/dashboard/video-audit" className="text-xs" style={{ color: '#3B82F6' }}>Részletek →</Link>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-3xl font-bold" style={{ color: scoreColor(stats.avg_audit_score || 0) }}>{stats.avg_audit_score || 0}</div>
            <div>
              <p className="text-xs font-medium" style={{ color: '#F8FAFC' }}>/100 {scoreLabel(stats.avg_audit_score || 0)}</p>
              <p className="text-xs" style={{ color: '#94A3B8' }}>{stats.total_audits} audit elvégezve</p>
            </div>
          </div>
        </div>
      ) : null}

      {/* Creator Memory */}
      <div className="rounded-2xl p-5" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-sm" style={{ color: '#F8FAFC' }}>
            <i className="ti ti-brain mr-1.5" style={{ color: '#F59E0B' }} />Tartalommemória
          </h3>
          <Link href="/dashboard/memory" className="text-xs" style={{ color: '#3B82F6' }}>Összes →</Link>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: 'Mentett', count: saved, color: '#3B82F6', icon: 'ti-bookmark' },
            { label: 'Folyamat', count: inProgress, color: '#F59E0B', icon: 'ti-clock' },
            { label: 'Kész', count: completed, color: '#22C55E', icon: 'ti-check' },
          ].map(stat => (
            <div key={stat.label} className="text-center py-3 rounded-xl" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <i className={`ti ${stat.icon}`} style={{ color: stat.color, fontSize: '16px' }} />
              <p className="text-xl font-bold mt-1" style={{ color: stat.color }}>{stat.count}</p>
              <p className="text-xs mt-0.5" style={{ color: '#94A3B8' }}>{stat.label}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Credit Usage Chart */}
      <div className="rounded-2xl p-5" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <h3 className="font-semibold text-sm mb-1" style={{ color: '#F8FAFC' }}>
          <i className="ti ti-bolt mr-1.5" style={{ color: '#3B82F6' }} />Kredit felhasználás
        </h3>
        <p className="text-xs mb-4" style={{ color: '#94A3B8' }}>Elmúlt 7 nap</p>
        {!stats?.has_data ? (
          <p className="text-xs text-center py-4" style={{ color: '#94A3B8' }}>Még nincs elég aktivitás.</p>
        ) : (
          <>
            <div className="flex items-end gap-1 h-16 mb-2">
              {(stats?.daily_usage || []).map((d, i) => {
                const h = maxCredits > 0 ? Math.max(4, Math.round((d.credits / maxCredits) * 64)) : 4
                const isToday = i === (stats.daily_usage.length - 1)
                return (
                  <div key={d.day} className="flex-1 flex flex-col items-center">
                    <div className="w-full rounded-sm" title={`${d.credits} kredit`}
                      style={{ height: `${h}px`, background: isToday ? 'linear-gradient(180deg, #3B82F6, #8B5CF6)' : 'rgba(59,130,246,0.2)' }} />
                  </div>
                )
              })}
            </div>
            <div className="flex justify-between">
              {(stats?.daily_usage || []).map(d => (
                <span key={d.day} className="text-xs flex-1 text-center" style={{ color: '#64748B' }}>{d.day}</span>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Summary */}
      {stats?.has_data && (
        <div className="rounded-2xl p-5" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <h3 className="font-semibold text-sm mb-3" style={{ color: '#F8FAFC' }}>Összesítő</h3>
          <div className="space-y-2.5">
            {[
              { label: 'Téma lekérések', value: stats.opportunity_requests, icon: 'ti-trending-up' },
              { label: 'Videócsomagok', value: stats.total_packages, icon: 'ti-package' },
              { label: 'Video Auditok', value: stats.total_audits, icon: 'ti-stethoscope' },
              { label: 'Felhasznált kredit', value: stats.total_used.toFixed(1), icon: 'ti-bolt' },
            ].map(item => (
              <div key={item.label} className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-xs" style={{ color: '#94A3B8' }}>
                  <i className={`ti ${item.icon}`} style={{ fontSize: '14px' }} />{item.label}
                </span>
                <span className="text-xs font-semibold" style={{ color: '#F8FAFC' }}>{item.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main Dashboard ───────────────────────────────────────────
interface Props {
  profile: CreatorProfile | null
  memoryItems: CreatorMemoryItem[]
  displayName: string
}

export default function DashboardClient({ profile, memoryItems, displayName }: Props) {
  const searchParams = useSearchParams()
  const [topics, setTopics] = useState<DashboardOpportunityTopic[]>([])
  const [loading, setLoading] = useState(false)
  const [generated, setGenerated] = useState(false)
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [summary, setSummary] = useState<DashboardSummaryLite | null>(null)
  const [opportunityMessage, setOpportunityMessage] = useState<string | null>(null)
  const [opportunityError, setOpportunityError] = useState<string | null>(null)
  const [researchCount, setResearchCount] = useState(0)
  const [creditCheck, setCreditCheck] = useState<UsageCheckResult | null>(null)

  useEffect(() => {
    fetch('/api/dashboard-stats').then(r => r.json()).then(setStats).catch(() => {})
    fetch('/api/dashboard/summary').then(r => r.json()).then(setSummary).catch(() => {})
    if (profile?.niche && !generated) {
      // Először sessionStorage-ból próbálunk (force_refresh eredménye)
      const savedTopics = sessionStorage.getItem('willviral_dashboard_topics')
      if (savedTopics) {
        try {
          const parsed = JSON.parse(savedTopics)
          if (parsed.niche === profile.niche && parsed.topics?.length > 0 && parsed.weekKey === getTrendFeedWeekKey()) {
            setTopics(parsed.topics)
            setGenerated(true)
            return
          }
        } catch {}
      }

      // Heti 1 ingyenes Top Opportunity. Eloszor mindig a heti mentett/cached ajanlast kerjuk vissza.
      const weekKey = getTrendFeedWeekKey()
      const lastRefresh = sessionStorage.getItem('willviral_trend_feed_week_key')
      if (lastRefresh === weekKey) {
        loadOpportunities(true)
      } else {
        loadOpportunities(true)
      }
    }
  }, [])

  async function handleManualRefresh() {
    // Dashboard kézi frissítés MINDIG 2 kreditbe kerül
    const cost = 2
    try {
      const res = await fetch('/api/credits')
      const credits = await res.json()
      const balance = credits.balance ?? 0

      if (balance < cost) {
        setCreditCheck({
          feature: 'Trend Feed frissítés',
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

      setCreditCheck({
        feature: 'Trend Feed frissítés',
        cost,
        currency: 'credit',
        currentCredits: Math.round(balance),
        remainingCreditsAfterRun: Math.round(balance - cost),
        requiresConfirmation: true,
        canRun: true,
        message: `Új trendtémák keresése ${cost} kreditbe kerül. A heti Top Opportunity ajánlás ingyenes, az extra keresés kredites.`,
      })
    } catch {
      loadOpportunities(false, true)
    }
  }

  async function loadOpportunities(cacheOnly = false, forceRefresh = false) {
    if (!profile?.niche) { console.log('[Dashboard] No niche, skipping'); return }
    console.log(`[Dashboard] loadOpportunities cacheOnly=${cacheOnly} forceRefresh=${forceRefresh} niche="${profile.niche}"`)
    setLoading(true)
    setOpportunityMessage(null)
    setOpportunityError(null)

    try {
      const res = await fetch('/api/opportunity', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          niche: profile.niche, platform: profile.platform,
          language: profile.language, region: profile.region,
          creator_level: profile.creator_level,
          main_category: profile.main_category,
          specific_focus: profile.specific_focus,
          audience: profile.audience,
          avoid_topics: profile.avoid_topics,
          cache_only: cacheOnly,
          force_refresh: forceRefresh,
          // Force refresh-nél kizárjuk a jelenleg látott témákat, hogy ne fizess
          // kreditet ugyanannak a témának a visszakapásáért.
          exclude_titles: forceRefresh ? topics.map(t => t.title) : [],
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setOpportunityError(data.error || 'Nem sikerült betölteni a lehetőségeket.')
        setTopics([])
        setGenerated(true)
        return
      }

      // A heti ingyenes Opportunity Engine keret elfogyott — a szerver NEM vont le
      // kreditet, megerősítést kér. Soha nem töltünk le automatikusan kreditet
      // felugró jóváhagyás nélkül, ezért itt megmutatjuk a modalt és megállunk.
      if (data.needs_confirmation) {
        setLoading(false)
        setCreditCheck({
          feature: 'Trend Feed frissítés',
          cost: data.confirmation_cost || 2,
          currency: 'credit',
          currentCredits: 0,
          remainingCreditsAfterRun: 0,
          requiresConfirmation: true,
          canRun: true,
          message: data.message || 'A heti ingyenes Top Opportunity ajánlásod már megvan. Ez az extra keresés kreditbe kerül.',
        })
        setGenerated(true)
        return
      }

      const allTopics = (data.topics || []) as DashboardOpportunityTopic[]
      console.log(`[Dashboard] API response: ${allTopics.length} topics, cached: ${data.cached}, charged: ${data.charged}, credits: ${data.credits_charged}`)

      if (cacheOnly && allTopics.length === 0 && !forceRefresh) {
        console.log('[Dashboard] Cache empty (possible engine version change), retrying with fresh search')
        loadOpportunities(false, false)
        return
      }

      // Ha force_refresh és nem vonódott le kredit, jelezzük
      if (forceRefresh && data.charged === false) {
        setOpportunityMessage(data.message || 'Kreditet nem vontunk le.')
      }
      const productionTopics = allTopics.filter(topic => isProductionCandidate(topic) && !isDiscoveryOrResearch(topic))
      const researchTopics = allTopics.filter(topic => !productionTopics.includes(topic))
      setResearchCount(researchTopics.length)
      setOpportunityMessage(
        productionTopics.length > 0
          ? data.message || null
          : cacheOnly && allTopics.length === 0
          ? null
          : data.message || (researchTopics.length > 0
              ? 'Találtunk kutatási irányokat, de ezen a héten nincs elég erős gyártható téma. Nyisd meg a Videólehetőségeket a továbbszűkítéshez.'
              : null)
      )
      // Ha nincs production topic, mutassuk a legjobb nem-discovery témákat is
      const displayTopics = productionTopics.length > 0
        ? productionTopics.slice(0, 5)
        : allTopics.filter(t => !isDiscoveryOrResearch(t)).slice(0, 5)
      const sortedFallbackTopics = [...allTopics]
        .filter(t => t.ready_to_produce_status !== 'rejected')
        .sort((a, b) => topicDashboardScore(b) - topicDashboardScore(a))
      const finalTopics = displayTopics.length > 0 ? displayTopics : sortedFallbackTopics.slice(0, 3)
      setTopics(finalTopics)
      setGenerated(true)

      // SessionStorage frissítés — hogy refresh után is az új adatokat lássa
      if (finalTopics.length > 0) {
        sessionStorage.setItem('willviral_dashboard_topics', JSON.stringify({
          topics: finalTopics,
          message: opportunityMessage,
          timestamp: Date.now(),
          niche: profile?.niche,
          weekKey: getTrendFeedWeekKey(),
        }))
        if (!forceRefresh) {
          sessionStorage.setItem('willviral_trend_feed_week_key', getTrendFeedWeekKey())
        }
      }
    } catch (e) {
      console.error(e)
      if (!cacheOnly) {
        setOpportunityError('Kapcsolati hiba a lehetőségek betöltésekor.')
      }
      setTopics([])
      setGenerated(true)
    }
    finally { setLoading(false) }
  }

  const bestTopic = pickBestTopic(topics)
  const showFirstRunLaunchPad = searchParams.get('setup') === 'complete' || stats?.has_data === false
  const showFirstVideoFlow = !!profile?.niche && (showFirstRunLaunchPad || (stats?.total_packages || 0) === 0)

  return (
    <div className="max-w-5xl mx-auto animate-fade-in">
      {creditCheck && (
        <CreditConfirmModal
          check={creditCheck}
          onConfirm={() => { setCreditCheck(null); loadOpportunities(false, true) }}
          onCancel={() => setCreditCheck(null)}
          loading={loading}
        />
      )}

      {/* 1. Greeting */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold" style={{ color: '#F8FAFC' }}>{getGreeting()}, {displayName}!</h1>
        <p className="text-sm" style={{ color: '#94A3B8' }}>Heti validált téma, gyors validálás, kész videócsomag.</p>
      </div>

      {showFirstRunLaunchPad && (
        <FirstRunLaunchPad
          profile={profile}
          loading={loading}
          hasTopic={!!bestTopic}
          hasData={!!stats?.has_data}
        />
      )}

      {showFirstVideoFlow && (
        <FirstVideoFlow
          profile={profile}
          topic={bestTopic}
          stats={stats}
          summary={summary}
          loading={loading}
        />
      )}

      <TrendFeedHistory />
      <CreatorPipelineStrip />
      <CreatorCommandCenter summary={summary} />

      {/* 2. Main Recommendation Card */}
      {loading && (
        <div className="card mb-6">
          <LoadingScreen steps={LOADING_STEPS.opportunity} message="Valós YouTube adatok alapján dolgozunk" />
        </div>
      )}
      {!loading && bestTopic && (() => {
        const rm = getReadyMeta(bestTopic)
        const webCount = bestTopic.web_sources?.length || 0
        const videoCount = bestTopic.evidence_videos?.length || 0
        const evScore = bestTopic.evidence_match_score || 0
        const oppScore = bestTopic.opportunity_score
        const consistencyLabel = (bestTopic as unknown as Record<string, unknown>).topic_consistency_status as string | undefined
        const isResearchTopic = !isProductionCandidate(bestTopic)
        const heroEyebrow = isResearchTopic ? 'MAI KÖVETKEZŐ LÉPÉS' : 'MAI GYÁRTHATÓ AJÁNLÁS'
        const primaryHref = isResearchTopic ? `/dashboard/similar-videos?topic=${encodeURIComponent(bestTopic.keyword || bestTopic.title)}` : buildPackageUrl(bestTopic)
        const primaryLabel = isResearchTopic ? 'Validálás indítása' : 'Videócsomag készítése'
        const todayAction = getTodayActionMeta(bestTopic)
        return (
        <div className="relative rounded-2xl mb-6 overflow-hidden" style={{ background: '#0E1422', border: '1px solid rgba(59,130,246,0.2)', boxShadow: '0 0 40px rgba(59,130,246,0.08), 0 20px 60px rgba(0,0,0,0.4)' }}>
          {/* Gradient top accent */}
          <div className="h-1 w-full" style={{ background: 'linear-gradient(90deg, #3B82F6, #8B5CF6, #3B82F6)' }} />

          <div className="p-6 lg:p-8">
            <div className="flex flex-col lg:flex-row gap-6 lg:gap-8">
              {/* Left: Content */}
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: '#3B82F6' }}>{heroEyebrow}</p>

                <div className="flex items-center gap-2 mb-3 flex-wrap">
                  <span className="text-xs px-2.5 py-1 rounded-full font-medium" style={{ background: rm.bg, color: rm.color, border: `1px solid ${rm.color}30` }}>
                    {rm.label}
                  </span>
                  {consistencyLabel && consistencyLabel !== 'polluted' && (
                    <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(59,130,246,0.08)', color: '#3B82F6' }}>
                      {consistencyLabel === 'consistent' ? 'Konzisztens források' : consistencyLabel === 'acceptable' ? 'Elfogadható források' : 'Vegyes források'}
                    </span>
                  )}
                </div>

                <h2 className="text-xl lg:text-2xl font-bold leading-snug mb-3" style={{ color: '#F8FAFC' }}>{bestTopic.title}</h2>
                <p className="text-sm leading-relaxed mb-4" style={{ color: '#CBD5E1' }}>{bestTopic.description}</p>

                <div className="mb-4 rounded-xl px-4 py-3" style={{ background: `${todayAction.color}0F`, border: `1px solid ${todayAction.color}28` }}>
                  <div className="flex items-start gap-3">
                    <span className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: `${todayAction.color}1F`, color: todayAction.color }}>
                      <i className={`ti ${todayAction.icon}`} />
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold mb-1" style={{ color: '#F8FAFC' }}>{todayAction.title}</p>
                      <p className="text-xs leading-relaxed" style={{ color: '#CBD5E1' }}>{todayAction.body}</p>
                      <p className="text-xs mt-2" style={{ color: todayAction.color }}>
                        Várható eredmény: {todayAction.outcome}
                      </p>
                    </div>
                  </div>
                </div>

                {bestTopic.hook_suggestion && (
                  <div className="rounded-xl px-4 py-3 mb-4" style={{ background: 'rgba(59,130,246,0.04)', border: '1px solid rgba(59,130,246,0.1)' }}>
                    <span className="text-xs font-semibold" style={{ color: '#3B82F6' }}>Hook ötlet</span>
                    <p className="text-sm mt-1" style={{ color: '#CBD5E1' }}>{bestTopic.hook_suggestion}</p>
                  </div>
                )}

                {/* CTAs */}
                <div className="flex gap-2 flex-wrap">
                  <Link href={primaryHref} onClick={() => storePackageContext(bestTopic)}
                    className="px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:-translate-y-0.5"
                    style={{ background: 'linear-gradient(135deg, #3B82F6, #8B5CF6)', color: '#fff', boxShadow: '0 0 24px rgba(59,130,246,0.3)' }}>
                    {primaryLabel}
                  </Link>
                  {isResearchTopic && (
                    <Link href={`/dashboard/viral-score?topic=${encodeURIComponent(bestTopic.keyword || bestTopic.title)}`}
                      className="px-4 py-2.5 rounded-xl text-sm transition-all"
                      style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', color: '#F59E0B' }}>
                      Virális esély ellenőrzés
                    </Link>
                  )}
                  <Link href={`/dashboard/opportunities?highlight=${encodeURIComponent(bestTopic.id)}`}
                    onClick={() => sessionStorage.setItem('willviral_highlight_candidate', JSON.stringify(bestTopic))}
                    className="px-4 py-2.5 rounded-xl text-sm transition-all"
                    style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: '#CBD5E1' }}>
                    Részletek
                  </Link>
                  <button onClick={handleManualRefresh} disabled={loading} className="px-4 py-2.5 rounded-xl text-sm transition-all"
                    style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: '#94A3B8' }}>
                    Extra keresés - 2 kredit
                  </button>
                </div>
              </div>

              {/* Right: Evidence Panel */}
              <div className="flex-shrink-0 w-full lg:w-52">
                <div className="flex flex-row lg:flex-col items-center lg:items-center gap-4 lg:gap-0">
                  {/* Score Ring */}
                  <div className="relative w-28 h-28 lg:mb-4">
                    <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
                      <circle cx="50" cy="50" r="42" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="6" />
                      <circle cx="50" cy="50" r="42" fill="none" stroke={scoreColor(oppScore)} strokeWidth="6"
                        strokeDasharray={`${oppScore * 2.64} 264`} strokeLinecap="round"
                        style={{ transition: 'stroke-dasharray 1s ease' }} />
                    </svg>
                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                      <span className="text-2xl font-bold" style={{ color: scoreColor(oppScore) }}>{oppScore}</span>
                      <span className="text-xs" style={{ color: '#94A3B8' }}>/100</span>
                    </div>
                  </div>

                  {/* Evidence Stats */}
                  <div className="flex-1 lg:w-full space-y-2">
                    <div className="flex items-center justify-between text-xs px-3 py-2 rounded-lg" style={{ background: 'rgba(255,255,255,0.03)' }}>
                      <span style={{ color: '#94A3B8' }}><i className="ti ti-world mr-1" style={{ fontSize: '12px' }} />Web</span>
                      <span className="font-semibold" style={{ color: webCount > 0 ? '#22C55E' : '#64748B' }}>{webCount} forrás</span>
                    </div>
                    <div className="flex items-center justify-between text-xs px-3 py-2 rounded-lg" style={{ background: 'rgba(255,255,255,0.03)' }}>
                      <span style={{ color: '#94A3B8' }}><i className="ti ti-player-play mr-1" style={{ fontSize: '12px' }} />Videó</span>
                      <span className="font-semibold" style={{ color: videoCount > 0 ? '#22C55E' : '#64748B' }}>{videoCount} db</span>
                    </div>
                    {evScore > 0 && (
                      <div className="flex items-center justify-between text-xs px-3 py-2 rounded-lg" style={{ background: 'rgba(255,255,255,0.03)' }}>
                        <span style={{ color: '#94A3B8' }}><i className="ti ti-shield-check mr-1" style={{ fontSize: '12px' }} />Bizonyíték</span>
                        <span className="font-semibold" style={{ color: scoreColor(evScore) }}>{evScore}/100</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        )
      })()}
      {!loading && !bestTopic && generated && (
        <div className="card text-center py-10 mb-6">
          <h3 className="font-semibold mb-2" style={{ color: '#F8FAFC' }}>Ezen a héten nincs elég erős kész téma</h3>
          <p className="text-sm mb-4" style={{ color: '#94A3B8' }}>
            {opportunityMessage || opportunityError || 'Kérhetsz extra keresést, vagy pontosíthatod a niche-edet a Profil oldalon.'}
          </p>
          <div className="flex gap-3 justify-center">
            <button onClick={handleManualRefresh} disabled={loading} className="btn-primary text-sm">
              Extra keresés - 2 kredit
            </button>
            <Link href="/dashboard/opportunities" className="btn-secondary text-sm">Videólehetőségek</Link>
          </div>
        </div>
      )}
      {!loading && !bestTopic && !generated && !profile?.niche && (
        <div className="card text-center py-10 mb-6">
          <h3 className="font-semibold mb-2" style={{ color: '#F8FAFC' }}>Töltsd ki a profilodat</h3>
          <p className="text-sm mb-4" style={{ color: '#94A3B8' }}>A niche megadása után személyre szabott ajánlások jelennek meg.</p>
          <Link href="/dashboard/profile" className="btn-primary">Profil kitöltése</Link>
        </div>
      )}

      <CreatorIntelligenceSummary />
    </div>
  )
}
