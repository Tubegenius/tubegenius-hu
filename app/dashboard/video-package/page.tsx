'use client'

import { useState, useEffect, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import type { CreatorProfile } from '@/types'
import CreditConfirmModal from '@/components/CreditConfirmModal'
import type { UsageCheckResult } from '@/lib/usage-protection'
import LoadingScreen, { LOADING_STEPS } from '@/components/ui/LoadingScreen'
import { publishCreditBalance } from '@/lib/credit-balance-events'

// ─── Types ────────────────────────────────────────────────────
type PlatformChecklist =
  | {
      type: 'youtube'
      title: string
      description: string
      tags: string[]
      category: string
      language: string
      captions_note: string
      comments_setting: string
      made_for_kids: boolean
      made_for_kids_reason: string
      age_restriction: boolean
      age_restriction_reason: string
      license: string
      paid_promotion_disclosure: boolean
      paid_promotion_disclosure_note: string
      visibility_schedule_advice: string
      playlist_suggestion: string
      end_screens_plan: string | null
      cards_plan: string | null
    }
  | {
      type: 'tiktok'
      caption: string
      hashtags: string[]
      cover_image_guidance: string
      sound_note: string
      privacy_setting: string
      duet_stitch_comments_settings: string
      branded_content_disclosure: string
    }
  | {
      type: 'instagram_reels'
      caption: string
      hashtags: string[]
      cover_image: string
      audio_note: string
      alt_text: string
      share_to_feed_toggle: string
      collab_tag_guidance: string
      branded_content_disclosure: string
    }
  | {
      type: 'facebook_reels'
      caption: string
      cross_post_to_feed: string
      audience_visibility: string
      music_note: string
    }

interface VideoPackageResult {
  paid_result_id?: string
  topic: string
  platform: string
  video_length: string
  narration_style: string
  intensity: string
  goal: string
  hook: string
  hook_variations?: string[]
  narration: string
  scene_structure: Scene[]
  broll_ideas: string[]
  thumbnail_texts: string[]
  thumbnail_concept?: string | null
  title_variations: string[]
  caption: string
  description: string
  hashtags: { viral: string[]; niche: string[]; general: string[] }
  pinned_comment?: string | null
  why_it_works?: string | null
  risks?: string[]
  production_checklist?: string[]
  upload_times: { primary: string; secondary: string; reason: string }
  platform_checklist?: PlatformChecklist | null
  cta: string
  timestamps?: string[]
  sources_used?: { title: string; url: string }[]
  estimated_word_count?: string
  estimated_duration?: string
  content_type?: string
  strict_fact_mode?: boolean
  fact_strictness_level?: string | null
  quality_status?: string
  forbidden_claims?: string[]
  verified_fact_block?: unknown
  intensity_original?: string
  intensity_final?: string
  intensity_downgraded?: boolean
  intensity_downgrade_reason?: string
  opportunity_context?: {
    ready_to_produce_status?: string
    ready_to_produce_label?: string
    confidence?: string
    opportunity_score?: number
    evidence_match_score?: number | null
    risk_flags?: string[]
    preparation_mode?: boolean
  } | null
  _credits_remaining?: number
  from_paid_result?: boolean
  requires_credit?: boolean
}

interface Scene {
  number: number
  title: string
  duration: string
  visual: string
  narration: string
}

interface OpportunityPackageContext {
  id: string
  title: string
  keyword?: string
  description?: string
  confidence?: string
  trend_source_type?: string
  trend_source_label?: string
  ready_to_produce_status?: 'ready' | 'watch' | 'research' | 'rejected'
  ready_to_produce_label?: string
  opportunity_score?: number
  evidence_match_score?: number | null
  risk_flags?: string[]
  preparation_mode?: boolean
  hook_suggestion?: string
  web_sources?: Array<{ title: string; url: string; snippet?: string; date?: string; source?: string }>
  evidence_videos?: Array<{ video_id: string; title: string; url: string; channel_title: string; thumbnail_url?: string; view_count: number; like_count: number; comment_count: number; published_at: string }>
  score_breakdown?: Record<string, number>
}

interface SourceVideoExtractResult {
  video_id: string
  title: string
  channel: string
  hook: string
  structure: Array<{ timestamp: string; label: string; content: string; type: string }>
  key_points: string[]
  success_factors: string
  estimated_duration: string
  word_count: number
  transcript_available?: boolean
  transcript_source?: 'transcript' | 'metadata'
  raw_transcript?: string | null
}

// ─── Constants ────────────────────────────────────────────────
const PLATFORMS = [
  { value: 'youtube_shorts', label: 'YouTube Shorts', icon: '📱' },
  { value: 'tiktok', label: 'TikTok', icon: '🎵' },
  { value: 'instagram_reels', label: 'Instagram Reels', icon: '📸' },
  { value: 'youtube_long', label: 'YouTube Long', icon: '▶️' },
  { value: 'facebook_reels', label: 'Facebook Reels', icon: '👥' },
]

const VIDEO_LENGTHS = {
  shorts: [
    { value: '30sec', label: '30 mp' },
    { value: '45sec', label: '45 mp' },
    { value: '60sec', label: '60 mp' },
  ],
  long: [
    { value: '3-5min', label: '3–5 perc' },
    { value: '6-10min', label: '6–10 perc' },
    { value: 'custom', label: 'Egyéni' },
  ],
}

const NARRATION_STYLES = [
  { value: 'mrbeast', label: 'MrBeast' },
  { value: 'bright_side', label: 'Bright Side' },
  { value: 'dylan_page', label: 'Dylan Page' },
  { value: 'dokumentarista', label: 'Dokumentarista' },
  { value: 'tenyfeltaro', label: 'Tényfeltáró' },
  { value: 'tudomanyos', label: 'Tudományos' },
  { value: 'storytelling', label: 'Storytelling' },
  { value: 'mrballen', label: 'MrBallen' },
  { value: 'magyar_tiktok', label: 'Magyar TikTok' },
  { value: 'sajat', label: 'Saját stílus' },
]

const INTENSITIES = [
  { value: 'light', label: 'Light', desc: 'Visszafogott' },
  { value: 'classic', label: 'Classic', desc: 'Kiegyensúlyozott' },
  { value: 'extreme', label: 'Extreme', desc: 'Maximum hatás' },
]

const GOALS = [
  { value: 'views', label: '👁 Nézettség' },
  { value: 'comments', label: '💬 Komment' },
  { value: 'shares', label: '🔗 Megosztás' },
  { value: 'saves', label: '📌 Mentés' },
  { value: 'subscribers', label: '🔔 Feliratkozás' },
  { value: 'affiliate', label: '💰 Affiliate' },
]

// ─── Helper components ────────────────────────────────────────
function CopyBtn({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
      className="text-xs px-3 py-1.5 rounded-lg border transition-all"
      style={{ background: copied ? 'rgba(34,197,94,0.1)' : '#121826', border: copied ? '1px solid rgba(34,197,94,0.3)' : '1px solid rgba(255,255,255,0.08)', color: copied ? '#22C55E' : '#CBD5E1' }}>
      {copied ? '✓ Másolva' : label}
    </button>
  )
}

function getQualityMeta(status?: string) {
  if (status === 'verified' || status === 'verified_with_limits') {
    return { label: status === 'verified' ? 'Ellenőrzött' : 'Ellenőrzött, korlátokkal', color: '#22C55E', bg: 'rgba(34,197,94,0.1)' }
  }
  if (status === 'limited') return { label: 'Korlátozott forrás', color: '#F59E0B', bg: 'rgba(245,158,11,0.1)' }
  if (status === 'insufficient_sources') return { label: 'Forrás hiányos', color: '#EF4444', bg: 'rgba(239,68,68,0.1)' }
  return { label: 'Általános csomag', color: '#CBD5E1', bg: 'rgba(139,155,180,0.08)' }
}

function isYouTubeSource(url: string) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '')
    return hostname === 'youtube.com' || hostname.endsWith('.youtube.com') || hostname === 'youtu.be'
  } catch {
    return false
  }
}

function getSourceCounts(pkg: VideoPackageResult, context: OpportunityPackageContext | null) {
  const videoEvidenceCount = context?.evidence_videos?.length
    ?? pkg.sources_used?.filter(source => isYouTubeSource(source.url)).length
    ?? 0
  const webSourceCount = context?.web_sources?.length
    ?? pkg.sources_used?.filter(source => !isYouTubeSource(source.url)).length
    ?? 0

  return { webSourceCount, videoEvidenceCount }
}

function getProductionBrief(pkg: VideoPackageResult, context: OpportunityPackageContext | null) {
  const { webSourceCount, videoEvidenceCount } = getSourceCounts(pkg, context)
  const readiness = pkg.opportunity_context?.ready_to_produce_label || context?.ready_to_produce_label || 'Kézi ellenőrzés javasolt'
  const risks = pkg.opportunity_context?.risk_flags || context?.risk_flags || []

  return [
    `TÉMA: ${pkg.topic}`,
    `GYÁRTÁSI STÁTUSZ: ${readiness}`,
    `MINŐSÉG: ${getQualityMeta(pkg.quality_status).label}`,
    `PLATFORM: ${pkg.platform}`,
    `HOSSZ: ${pkg.estimated_duration || pkg.video_length}`,
    `NARRÁCIÓ: ${pkg.estimated_word_count || ''}`,
    `FORRÁSOK: ${webSourceCount} webes forrás, ${videoEvidenceCount} bizonyíték videó`,
    risks.length ? `KOCKÁZATOK: ${risks.join(' | ')}` : 'KOCKÁZATOK: nincs kiemelt kockázat',
    '',
    `HOOK: ${pkg.hook}`,
    '',
    'GYÁRTÁSI CHECKLIST:',
    '- Források gyors ellenőrzése',
    '- Narráció felolvasási ritmus ellenőrzése',
    '- Thumbnail/overlay kiválasztása',
    '- B-roll lista összeszedése',
    '- CTA és leírás átnézése',
  ].join('\n')
}

function Block({ title, children, accent }: { title: string; children: React.ReactNode; accent?: string }) {
  return (
    <div className="rounded-xl p-5" style={{ background: '#0F1420', border: `1px solid ${accent || 'rgba(255,255,255,0.08)'}` }}>
      <p className="text-xs font-semibold uppercase tracking-widest mb-4" style={{ color: '#94A3B8' }}>{title}</p>
      {children}
    </div>
  )
}

function SelectGroup({ options, value, onChange }: { options: { value: string; label: string; desc?: string; icon?: string }[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map(opt => (
        <button key={opt.value} onClick={() => onChange(opt.value)}
          className="px-3 py-2 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5"
          style={{
            background: value === opt.value ? 'rgba(59,130,246,0.1)' : '#121826',
            border: value === opt.value ? '1px solid rgba(59,130,246,0.4)' : '1px solid rgba(255,255,255,0.08)',
            color: value === opt.value ? '#3B82F6' : '#CBD5E1',
          }}>
          {opt.icon && <span>{opt.icon}</span>}
          <span>{opt.label}</span>
          {opt.desc && <span style={{ color: '#94A3B8', fontSize: '10px' }}>— {opt.desc}</span>}
        </button>
      ))}
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────
export default function VideoPackagePage() {
  const searchParams = useSearchParams()
  const supabase = createClient()

  const [profile, setProfile] = useState<CreatorProfile | null>(null)
  const [topic, setTopic] = useState(searchParams.get('topic') || '')
  const [platform, setPlatform] = useState('youtube_long')
  const [videoLength, setVideoLength] = useState('6-10min')
  const [narrationStyle, setNarrationStyle] = useState('storytelling')
  const [intensity, setIntensity] = useState('classic')
  const [goal, setGoal] = useState('views')
  const [customPrompt, setCustomPrompt] = useState('')

  const [loading, setLoading] = useState(false)
  const [factsLoading, setFactsLoading] = useState(false)
  const [result, setResult] = useState<VideoPackageResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [savedPackageId, setSavedPackageId] = useState<string | null>(null)
  const [calendarStatus, setCalendarStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [factSources, setFactSources] = useState<{ title: string; snippet: string; url: string; source_type: string }[]>([])
  const [loadingSavedPackage, setLoadingSavedPackage] = useState(false)
  const searchKeyword = searchParams.get('keyword') || ''
  const sourceVideoId = searchParams.get('source_video_id') || null
  const sourceVideoUrl = searchParams.get('source_video_url') || null
  const sourceContext = searchParams.get('source_context') || null
  const opportunityId = searchParams.get('opportunity_id') || null
  const sourceMode = searchParams.get('mode') === 'source_video'
  const factBlockRef = useRef<string | null>(null)
  const sourceExtractRef = useRef<SourceVideoExtractResult | null>(null)
  const [sourceVideoInfo, setSourceVideoInfo] = useState<{ title: string; transcriptAvailable: boolean } | null>(null)
  const opportunityContextRef = useRef<OpportunityPackageContext | null>(null)
  const [opportunityContext, setOpportunityContext] = useState<OpportunityPackageContext | null>(null)
  const [allowWeakOpportunityGeneration, setAllowWeakOpportunityGeneration] = useState(false)
  const [creditCheck, setCreditCheck] = useState<UsageCheckResult | null>(null)
  const pendingActionRef = useRef<(() => void) | null>(null)
  // `saved`/`savedPackageId` azt jelzi, hogy a csomag be van irva a video_packages
  // tablaba — ez FRISS generalas utan is igaz (autoSavePackage mindig lefut), nem
  // csak visszanyitasnal. A "nem vontunk le kreditet" felirat ezert kulon jelzot
  // hasznal, amit csak a tenyleges (kredit nelkuli) visszanyitasi utak allitanak be.
  const [reopenedWithoutCharge, setReopenedWithoutCharge] = useState(false)

  const isShorts = ['youtube_shorts', 'tiktok', 'instagram_reels', 'facebook_reels'].includes(platform)
  const opportunityStatus = opportunityContext?.ready_to_produce_status
  const opportunityResearchMode = opportunityStatus === 'research'
  const opportunityHardBlocked = opportunityStatus === 'rejected'
  const opportunityNeedsValidation = opportunityResearchMode || opportunityHardBlocked
  const opportunityPreparationMode = opportunityResearchMode && allowWeakOpportunityGeneration
  const generationBlockedByOpportunity = !!(opportunityHardBlocked || (opportunityResearchMode && !allowWeakOpportunityGeneration))

  useEffect(() => {
    loadProfile()
    loadSourceVideoContext()
    loadOpportunityContext()
    const paidResultId = searchParams.get('paidResultId')
    if (paidResultId) {
      loadPaidResult(paidResultId)
      return
    }
    const packageId = searchParams.get('id')
    if (packageId) {
      loadSavedPackage(packageId)
      return
    }
    // Keresési előzmény visszaállítása böngésző vissza gombhoz
    const hasUrlParams = searchParams.get('topic') || searchParams.get('source_video_id') || searchParams.get('opportunity_id')
    if (!hasUrlParams) {
      const saved = sessionStorage.getItem('willviral_video_package_state')
      if (saved) {
        try {
          const state = JSON.parse(saved)
          if (state.topic) setTopic(state.topic)
          if (state.result) {
            setResult(state.result)
            setSaved(true)
            setReopenedWithoutCharge(true)
          }
          if (state.platform) setPlatform(state.platform)
          if (state.videoLength) setVideoLength(state.videoLength)
          if (state.narrationStyle) setNarrationStyle(state.narrationStyle)
          if (state.intensity) setIntensity(state.intensity)
          if (state.goal) setGoal(state.goal)
        } catch {}
      }
    }
  }, [])

  function loadSourceVideoContext() {
    if (!sourceVideoUrl && !sourceVideoId) return
    try {
      // Új quick-extract formátum (source_video_id alapján)
      if (sourceVideoId) {
        const quickRaw = sessionStorage.getItem(`willviral_source_video_${sourceVideoId}`)
        if (quickRaw) {
          const quick = JSON.parse(quickRaw)
          sourceExtractRef.current = {
            video_id: quick.video_id,
            title: quick.title,
            channel: quick.channel,
            hook: quick.hook || '',
            structure: [],
            key_points: quick.key_points || [],
            success_factors: '',
            estimated_duration: '',
            word_count: quick.raw_transcript ? quick.raw_transcript.split(/\s+/).length : 0,
            raw_transcript: quick.raw_transcript,
            transcript_available: quick.transcript_available,
            transcript_source: quick.transcript_source,
          }
          setSourceVideoInfo({ title: quick.title, transcriptAvailable: !!quick.transcript_available })
          return
        }
      }
      // Régi script-extract formátum (URL alapján)
      if (sourceVideoUrl) {
        const cachedRaw = sessionStorage.getItem('willviral_script_extract_' + sourceVideoUrl)
        if (!cachedRaw) return
        const parsed = JSON.parse(cachedRaw)
        sourceExtractRef.current = parsed
        setSourceVideoInfo({ title: parsed.title, transcriptAvailable: !!parsed.transcript_available })
      }
    } catch (e) {
      console.error('Source video context load error:', e)
    }
  }

  function loadOpportunityContext() {
    if (!opportunityId) return
    try {
      const cachedRaw = sessionStorage.getItem('willviral_opportunity_package_' + opportunityId)
      if (!cachedRaw) return
      const parsed = JSON.parse(cachedRaw) as OpportunityPackageContext
      opportunityContextRef.current = parsed
      setOpportunityContext(parsed)
      setAllowWeakOpportunityGeneration(false)
    } catch (e) {
      console.error('Opportunity context load error:', e)
    }
  }

  function buildOpportunityFactBlock(context: OpportunityPackageContext) {
    const webSources = context.web_sources || []
    const videos = context.evidence_videos || []
    const lines = [
      'OPPORTUNITY VERIFIED EVIDENCE PACK',
      `Opportunity title: ${context.title}`,
      context.keyword ? `Original keyword: ${context.keyword}` : '',
      context.trend_source_label ? `Trend source: ${context.trend_source_label}` : '',
      context.ready_to_produce_label ? `Production status: ${context.ready_to_produce_label}` : '',
      context.opportunity_score ? `Opportunity score: ${context.opportunity_score}/100` : '',
      context.hook_suggestion ? `Suggested hook: ${context.hook_suggestion}` : '',
      '',
      'Web sources:',
      ...webSources.map((s, i) => `[${i + 1}] ${s.title}\n${s.snippet || ''}\nURL: ${s.url}`),
      '',
      'YouTube evidence videos:',
      ...videos.map((v, i) => `[${i + 1}] ${v.title} — ${v.channel_title} — ${v.view_count} views\nURL: ${v.url}`),
    ].filter(Boolean)

    return lines.join('\n')
  }

  function buildSourceVideoFactBlock(source: SourceVideoExtractResult) {
    const transcript = source.raw_transcript?.trim()
    const structure = source.structure?.map(s => `${s.timestamp} ${s.label}: ${s.content}`).join(' | ') || ''
    const keyPoints = source.key_points?.join(' | ') || ''

    if (source.transcript_available && transcript) {
      return [
        `SOURCE VIDEO VERIFIED TRANSCRIPT`,
        `Title: ${source.title}`,
        `Channel: ${source.channel}`,
        `Duration: ${source.estimated_duration}`,
        `Hook analysis: ${source.hook}`,
        `Key points: ${keyPoints}`,
        `Structure: ${structure}`,
        `Transcript excerpt: ${transcript.slice(0, 8000)}`,
      ].join('\n')
    }

    return null
  }

  async function loadPaidResult(paidResultId: string) {
    setLoadingSavedPackage(true)
    try {
      const res = await fetch(`/api/video-package?paidResultId=${paidResultId}`)
      const data = await res.json()
      if (res.ok && !data.error) {
        setTopic(data.topic)
        setPlatform(data.platform)
        setVideoLength(data.video_length)
        if (data.narration_style) setNarrationStyle(data.narration_style)
        setResult(data)
        setSaved(true)
        setReopenedWithoutCharge(true)
      } else {
        setError(data.error || 'A videócsomag nem található')
      }
    } catch (e) {
      console.error('Load paid result error:', e)
      setError('Hiba a betöltés során')
    } finally {
      setLoadingSavedPackage(false)
    }
  }

  async function loadSavedPackage(id: string) {
    setLoadingSavedPackage(true)
    try {
      const res = await fetch(`/api/video-packages?id=${id}`)
      const data = await res.json()
      if (res.ok && data.package) {
        const pkg = data.package
        setTopic(pkg.topic)
        setPlatform(pkg.platform)
        setVideoLength(pkg.video_length)
        if (pkg.narration_style) setNarrationStyle(pkg.narration_style)
        if (pkg.intensity) setIntensity(pkg.intensity)
        if (pkg.goal) setGoal(pkg.goal)
        setResult({
          topic: pkg.topic, platform: pkg.platform, video_length: pkg.video_length,
          narration_style: pkg.narration_style, intensity: pkg.intensity, goal: pkg.goal,
          hook: pkg.hook, narration: pkg.narration, scene_structure: pkg.scene_structure,
          broll_ideas: pkg.broll_ideas, thumbnail_texts: pkg.thumbnail_texts,
          title_variations: pkg.title_variations, caption: pkg.caption || '', description: pkg.description || '',
          hashtags: pkg.hashtags, upload_times: pkg.upload_times, cta: pkg.cta,
          timestamps: pkg.timestamps, sources_used: pkg.sources,
          estimated_word_count: pkg.estimated_word_count, estimated_duration: pkg.estimated_duration,
        })
        setSaved(true)
        setSavedPackageId(pkg.id)
        setReopenedWithoutCharge(true)
      }
    } catch (e) {
      console.error('Load saved package error:', e)
    } finally {
      setLoadingSavedPackage(false)
    }
  }

  useEffect(() => {
    // Platform váltásnál automatikus hossz beállítás
    if (isShorts) {
      setVideoLength('60sec')
    } else {
      setVideoLength('6-10min')
    }
  }, [platform])

  // Saját keresési input auto-mentése — vissza-navigáláskor a beírt téma és beállítások
  // se vesszenek el akkor sem, ha a user még nem generált (generálás előtti állapot).
  useEffect(() => {
    if (!topic.trim()) return
    try {
      const existingRaw = sessionStorage.getItem('willviral_video_package_state')
      const existing = existingRaw ? JSON.parse(existingRaw) : {}
      sessionStorage.setItem('willviral_video_package_state', JSON.stringify({
        ...existing,
        topic,
        platform,
        videoLength,
        narrationStyle,
        intensity,
        goal,
      }))
    } catch {}
  }, [topic, platform, videoLength, narrationStyle, intensity, goal])

  async function loadProfile() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    const { data } = await supabase.from('profiles').select('*').eq('user_id', user.id).single()
    if (data) {
      setProfile(data)
      // Profil alapértelmezések betöltése
      if (data.narration_style) setNarrationStyle(data.narration_style)
      if (data.custom_prompt) setCustomPrompt(data.custom_prompt)
      if (data.platform) {
        const platformMap: Record<string, string> = {
          youtube: 'youtube_long', tiktok: 'tiktok',
          instagram: 'instagram_reels', facebook: 'facebook_reels',
        }
        setPlatform(platformMap[data.platform] || 'youtube_long')
      }
      if (data.video_length) {
        const lengthMap: Record<string, string> = {
          short: '60sec', medium: '6-10min', long: '6-10min',
        }
        setVideoLength(lengthMap[data.video_length] || '6-10min')
      }
    }
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
      // Ha nem sikerül a credit check, engedjük tovább
      onConfirm()
    }
  }

  function handleGenerate() {
    const cost = isShorts ? 2 : 6
    const featureName = isShorts ? 'Video Package (Shorts)' : 'Video Package (Long)'
    checkCreditsBeforeAction(cost, featureName, generate)
  }

  async function generate() {
    if (!topic.trim()) return
    if (generationBlockedByOpportunity) {
      setError(opportunityHardBlocked
        ? 'Ez a téma nem ajánlott gyártásra. Előbb válassz másik Videólehetőség témát vagy validáld újra.'
        : 'Ez a téma kutatási státuszú. Készíthetsz előkészítő csomagot, de publikálás előtt validáld Piaci bizonyítékok vagy Virális esély alapján.'
      )
      return
    }
    setLoading(true)
    setFactsLoading(true)
    setError(null)
    setResult(null)
    setFactSources([])
    setSaved(false)
    setSavedPackageId(null)
    setReopenedWithoutCharge(false)

    let factBlock: string | null = null
    let sources: { title: string; snippet: string; url: string; source_type: string }[] = []
    factBlockRef.current = null

    // 1. Tényadatok lekérése — Wikipedia + Serper
    const sourceExtract = sourceExtractRef.current
    const sourceVideoFactBlock = sourceExtract ? buildSourceVideoFactBlock(sourceExtract) : null

    const opportunityContextData = opportunityContextRef.current
    const opportunityFactBlock = opportunityContextData ? buildOpportunityFactBlock(opportunityContextData) : null

    if (sourceMode && sourceVideoFactBlock) {
      factBlock = sourceVideoFactBlock
      sources = [{
        title: sourceExtract?.title || topic,
        snippet: sourceVideoFactBlock.slice(0, 500),
        url: sourceVideoUrl || '',
        source_type: 'source_video_transcript',
      }]
      setFactSources(sources)
      factBlockRef.current = factBlock
      setFactsLoading(false)
    } else if (opportunityContextData && opportunityFactBlock) {
      factBlock = opportunityFactBlock
      sources = [
        ...(opportunityContextData.web_sources || []).map(s => ({
          title: s.title,
          snippet: s.snippet || '',
          url: s.url,
          source_type: 'opportunity_web',
        })),
        ...(opportunityContextData.evidence_videos || []).map(v => ({
          title: v.title,
          snippet: `${v.channel_title} - ${v.view_count} views`,
          url: v.url,
          source_type: 'opportunity_youtube',
        })),
      ]
      setFactSources(sources)
      factBlockRef.current = factBlock
      setFactsLoading(false)
    } else {
      try {
        const factsRes = await fetch('/api/facts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ topic: searchKeyword || topic, language: profile?.language || 'hu' }),
        })
        const factsData = await factsRes.json()
        if (factsData.has_data) {
          factBlock = factsData.fact_block
          sources = factsData.sources
          setFactSources(sources)
          factBlockRef.current = factBlock
        }
      } catch (e) {
        console.error('Facts fetch error:', e)
      } finally {
        setFactsLoading(false)
      }
    }

    // 2. Videócsomag generálás a fact_block alapján
    try {
      const res = await fetch('/api/video-package', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic, platform, video_length: videoLength,
          narration_style: narrationStyle, intensity, goal,
          custom_prompt: narrationStyle === 'sajat' ? customPrompt : null,
          niche: '',
          channel_context: profile?.niche || '',
          language: profile?.language || 'hu',
          fact_block: factBlock,
          sources: sources.map(s => ({ title: s.title, url: s.url, snippet: s.snippet, source_type: s.source_type })),
          web_sources: opportunityContextData?.web_sources || [],
          youtube_sources: opportunityContextData?.evidence_videos || [],
          opportunity_context: opportunityContextData ? {
            id: opportunityContextData.id,
            title: opportunityContextData.title,
            confidence: opportunityContextData.confidence,
            trend_source_type: opportunityContextData.trend_source_type,
            ready_to_produce_status: opportunityContextData.ready_to_produce_status,
            ready_to_produce_label: opportunityContextData.ready_to_produce_label,
            opportunity_score: opportunityContextData.opportunity_score,
            evidence_match_score: opportunityContextData.evidence_match_score,
            risk_flags: opportunityContextData.risk_flags || [],
            preparation_mode: opportunityPreparationMode,
          } : null,
          source_video: sourceExtract ? {
            video_id: sourceExtract.video_id,
            url: sourceVideoUrl,
            title: sourceExtract.title,
            channel: sourceExtract.channel,
            transcript_available: !!sourceExtract.transcript_available,
            transcript_source: sourceExtract.transcript_source || 'metadata',
            raw_transcript: sourceExtract.raw_transcript || null,
            hook: sourceExtract.hook,
            structure: sourceExtract.structure || [],
            key_points: sourceExtract.key_points || [],
            success_factors: sourceExtract.success_factors,
          } : null,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        if (res.status === 402) {
          setError(`💳 ${data.error}`)
        } else {
          setError(data.error)
        }
        return
      }
      setResult(data)
      if (data._credits_remaining !== undefined) {
        publishCreditBalance(data._credits_remaining)
      }

      // Mentés sessionStorage-ba — böngésző vissza gomb támogatás
      sessionStorage.setItem('willviral_video_package_state', JSON.stringify({
        topic,
        result: data,
        platform,
        videoLength,
        narrationStyle,
        intensity,
        goal,
      }))

      // ─── Automatikus mentés — a kifizetett generálás eredménye nem veszhet el ───
      await autoSavePackage(data)
    } catch { setError('Kapcsolati hiba.') }
    finally { setLoading(false) }
  }

  async function saveToCalendar() {
    if (!result) return
    setCalendarStatus('saving')
    try {
      const ideaRes = await fetch('/api/video-ideas', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: result.topic, platform: result.platform, workflow_status: 'ready_to_produce' }),
      })
      const ideaData = await ideaRes.json()
      if (!ideaRes.ok || !ideaData.idea?.id) { setCalendarStatus('error'); return }

      const patchRes = await fetch('/api/video-ideas', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: ideaData.idea.id, calendar_status: 'scheduled' }),
      })
      setCalendarStatus(patchRes.ok ? 'saved' : 'error')
    } catch {
      setCalendarStatus('error')
    }
  }

  async function autoSavePackage(pkg: VideoPackageResult) {
    try {
      const res = await fetch('/api/video-packages', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paid_result_id: pkg.paid_result_id,
          topic: pkg.topic,
          search_keyword: searchKeyword || null,
          platform: pkg.platform,
          video_length: pkg.video_length,
          narration_style: pkg.narration_style,
          intensity: pkg.intensity,
          goal: pkg.goal,
          sources: pkg.sources_used || [],
          verified_fact_block: factBlockRef.current,
          verified_fact_block_json: pkg.verified_fact_block || null,
          forbidden_claims: pkg.forbidden_claims || [],
          sources_used: pkg.sources_used || [],
          quality_status: pkg.quality_status || null,
          content_type: pkg.content_type || null,
          strict_fact_mode: pkg.strict_fact_mode || false,
          fact_strictness_level: pkg.fact_strictness_level || null,
          intensity_original: pkg.intensity_original || null,
          intensity_final: pkg.intensity_final || null,
          hook: pkg.hook,
          narration: pkg.narration,
          scene_structure: pkg.scene_structure,
          broll_ideas: pkg.broll_ideas,
          timestamps: pkg.timestamps || [],
          title_variations: pkg.title_variations,
          thumbnail_texts: pkg.thumbnail_texts,
          caption: pkg.caption,
          description: pkg.description,
          hashtags: pkg.hashtags,
          upload_times: pkg.upload_times,
          cta: pkg.cta,
          estimated_word_count: pkg.estimated_word_count,
          estimated_duration: pkg.estimated_duration,
        }),
      })
      const data = await res.json()
      if (res.ok) {
        setSavedPackageId(data.id)
        setSaved(true)
        // Creator Memory-ban is megjelenik — video_package_id összekapcsolva
        await fetch('/api/memory', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            topic: pkg.topic, search_keyword: searchKeyword || null,
            state: 'in_progress', video_package_id: data.id,
          }),
        })

        // Ha "Saját verzió" workflow-ból jöttünk (volt forrásvideó), mentjük a kapcsolatot
        if (sourceVideoId && sourceVideoUrl) {
          await fetch('/api/source-video-analysis', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              source_video_id: sourceVideoId,
              source_video_url: sourceVideoUrl,
              source_video_title: pkg.topic,
              source_context: sourceContext || 'script_extractor',
              transcript_available: sourceExtractRef.current?.transcript_available || false,
              transcript_source: sourceExtractRef.current?.transcript_source || 'metadata',
              extracted_structure: sourceExtractRef.current ? {
                hook: sourceExtractRef.current.hook,
                structure: sourceExtractRef.current.structure || [],
                key_points: sourceExtractRef.current.key_points || [],
                success_factors: sourceExtractRef.current.success_factors,
                estimated_duration: sourceExtractRef.current.estimated_duration,
                word_count: sourceExtractRef.current.word_count,
                transcript_available: !!sourceExtractRef.current.transcript_available,
                transcript_source: sourceExtractRef.current.transcript_source || 'metadata',
              } : {},
              verified_fact_block: factBlockRef.current,
              sources: pkg.sources_used || [],
              generated_video_package_id: data.id,
            }),
          }).catch(() => {})
        }
      }
    } catch (e) {
      console.error('Auto-save error:', e)
    }
  }

  async function savePackage() {
    if (!result || saved) return

    // 1. Teljes csomag mentése video_packages táblába — 0 kredit, csak DB write
    const res = await fetch('/api/video-packages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paid_result_id: result.paid_result_id,
        topic: result.topic,
        search_keyword: searchKeyword || null,
        platform: result.platform,
        video_length: result.video_length,
        narration_style: result.narration_style,
        intensity: result.intensity,
        goal: result.goal,
        sources: result.sources_used || [],
        verified_fact_block: factBlockRef.current,
        verified_fact_block_json: result.verified_fact_block || null,
        forbidden_claims: result.forbidden_claims || [],
        sources_used: result.sources_used || [],
        quality_status: result.quality_status || null,
        content_type: result.content_type || null,
        strict_fact_mode: result.strict_fact_mode || false,
        fact_strictness_level: result.fact_strictness_level || null,
        intensity_original: result.intensity_original || null,
        intensity_final: result.intensity_final || null,
        hook: result.hook,
        narration: result.narration,
        scene_structure: result.scene_structure,
        broll_ideas: result.broll_ideas,
        timestamps: result.timestamps || [],
        title_variations: result.title_variations,
        thumbnail_texts: result.thumbnail_texts,
        caption: result.caption,
        description: result.description,
        hashtags: result.hashtags,
        upload_times: result.upload_times,
        cta: result.cta,
        estimated_word_count: result.estimated_word_count,
        estimated_duration: result.estimated_duration,
      }),
    })
    const data = await res.json()
    if (res.ok) setSavedPackageId(data.id)

    // 2. Creator Memory frissítés — folyamatban állapot
    await fetch('/api/memory', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: result.topic, search_keyword: searchKeyword || null, state: 'in_progress' }),
    })

    setSaved(true)
  }

  const producerBrief = result ? getProductionBrief(result, opportunityContext) : ''
  const fullText = result ? `${producerBrief}\n\n---\n\nTÉMA: ${result.topic}\nPLATFORM: ${result.platform}\nSTÍLUS: ${result.narration_style}\n\nHOOK:\n${result.hook}\n\nNARRÁCIÓ:\n${result.narration}\n\nCÍMEK:\n${result.title_variations.join('\n')}\n\nLEÍRÁS:\n${result.description}\n\nHASHTAGEK:\n${[...result.hashtags.viral, ...result.hashtags.niche, ...result.hashtags.general].join(' ')}\n\nCTA:\n${result.cta}` : ''

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-1" style={{ color: '#F8FAFC' }}>🎬 Gyártási csomag</h1>
        <p className="text-sm" style={{ color: '#CBD5E1' }}>Platformra szabott, teljes videócsomag — a Creator Profile alapján.</p>
      </div>

      {/* Profil badge — ez a csatorna ÁLLANDÓ alapbeállítása, NEM az aktuálisan
          gyártott téma kontextusa. A kettő eltérhet (pl. profil niche "AI és
          orvostudomány", de a most gyártott téma memória-pszichológia) — ez
          nem hiba, csak a profil egy háttér-beállítás, amit a csomag stílusa/
          hashtagjei figyelembe vesznek, nem a téma maga. */}
      {profile && (
        <div className="rounded-xl px-4 py-3 mb-4 flex items-center justify-between"
          style={{ background: 'rgba(59,130,246,0.05)', border: '1px solid rgba(59,130,246,0.15)' }}>
          <div className="flex gap-4 text-xs" style={{ color: '#CBD5E1' }}>
            <span>Profil: <span style={{ color: '#F8FAFC' }}>{profile.channel_name || '—'}</span></span>
            <span title="Ez a csatornád alapbeállítása a Profil oldalon — nem feltétlenül egyezik a most gyártott témával.">
              Profil niche (alapbeállítás): <span style={{ color: '#F8FAFC' }}>{profile.niche || '—'}</span>
            </span>
            <span>Stílus: <span style={{ color: '#F8FAFC' }}>{NARRATION_STYLES.find(s => s.value === profile.narration_style)?.label || '—'}</span></span>
          </div>
          <a href="/dashboard/profile" className="text-xs" style={{ color: '#3B82F6' }}>Szerkesztés →</a>
        </div>
      )}
      {topic.trim() && (
        <div className="rounded-xl px-4 py-2.5 mb-4 text-xs" style={{ background: 'rgba(139,92,246,0.05)', border: '1px solid rgba(139,92,246,0.15)', color: '#CBD5E1' }}>
          Aktuális téma kontextus (ez alapján gyártunk, nem a profil niche alapján): <span style={{ color: '#F8FAFC', fontWeight: 600 }}>{topic}</span>
        </div>
      )}

      {sourceVideoInfo && (
        <div className="rounded-xl px-4 py-3 mb-4 flex items-center justify-between gap-3"
          style={{ background: 'rgba(59,130,246,0.05)', border: '1px solid rgba(59,130,246,0.15)' }}>
          <div className="flex items-start gap-2 min-w-0">
            <span className="text-base flex-shrink-0">📝</span>
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-widest mb-0.5" style={{ color: '#3B82F6' }}>
                Forrásvideó feldolgozva
              </p>
              <p className="text-sm line-clamp-1" style={{ color: '#F8FAFC' }}>{sourceVideoInfo.title}</p>
              <p className="text-xs mt-0.5" style={{ color: '#94A3B8' }}>
                {sourceVideoInfo.transcriptAvailable ? 'Teljes transcript kinyerve' : 'Metaadatok alapján (transcript nem elérhető)'} — ingyenes, kreditet nem von le
              </p>
            </div>
          </div>
        </div>
      )}

      {opportunityContext && (
        <div className="rounded-xl px-4 py-3 mb-4"
          style={{
            background: opportunityNeedsValidation ? 'rgba(245,158,11,0.06)' : 'rgba(34,197,94,0.06)',
            border: opportunityNeedsValidation ? '1px solid rgba(245,158,11,0.22)' : '1px solid rgba(34,197,94,0.18)',
          }}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest mb-1"
                style={{ color: opportunityNeedsValidation ? '#F59E0B' : '#22C55E' }}>
                Opportunity evidence csomag aktív
              </p>
              <p className="text-sm" style={{ color: '#F8FAFC' }}>
                {opportunityContext.ready_to_produce_label || 'Validált téma'} · {opportunityContext.web_sources?.length || 0} webes forrás · {opportunityContext.evidence_videos?.length || 0} bizonyíték videó
              </p>
              {opportunityNeedsValidation && (
                <p className="text-xs mt-2" style={{ color: '#CBD5E1' }}>
                  Ez még nem elsődleges gyártási ajánlás. A prémium folyamat szerint előbb validáld a Piaci bizonyítékok vagy Virális esély oldalon.
                </p>
              )}
              {opportunityContext.risk_flags && opportunityContext.risk_flags.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {opportunityContext.risk_flags.map(flag => (
                    <span key={flag} className="text-xs px-2 py-0.5 rounded-full"
                      style={{ background: 'rgba(245,158,11,0.08)', color: '#F59E0B', border: '1px solid rgba(245,158,11,0.15)' }}>
                      {flag}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="flex flex-col items-end gap-2">
              {opportunityContext.opportunity_score && (
                <span className="text-xs px-2 py-1 rounded-lg"
                  style={{
                    background: opportunityNeedsValidation ? 'rgba(245,158,11,0.1)' : 'rgba(34,197,94,0.1)',
                    color: opportunityNeedsValidation ? '#F59E0B' : '#22C55E',
                    border: opportunityNeedsValidation ? '1px solid rgba(245,158,11,0.2)' : '1px solid rgba(34,197,94,0.2)',
                  }}>
                  Score {opportunityContext.opportunity_score}
                </span>
              )}
              {opportunityNeedsValidation && (
                <div className="flex gap-2 flex-wrap justify-end">
                  <a href={`/dashboard/similar-videos?topic=${encodeURIComponent(opportunityContext.keyword || topic)}`}
                    className="text-xs px-3 py-1.5 rounded-lg font-medium"
                    style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.22)', color: '#3B82F6' }}>
                    Validálás
                  </a>
                  {!opportunityHardBlocked && (
                    <>
                    <a href={`/dashboard/viral-score?topic=${encodeURIComponent(opportunityContext.keyword || topic)}`}
                      className="text-xs px-3 py-1.5 rounded-lg font-medium"
                      style={{ background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.22)', color: '#A78BFA' }}>
                      Virális esély
                    </a>
                    <button onClick={() => { setAllowWeakOpportunityGeneration(true); setError(null) }}
                      className="text-xs px-3 py-1.5 rounded-lg"
                      style={{ background: allowWeakOpportunityGeneration ? 'rgba(34,197,94,0.1)' : '#121826', border: '1px solid rgba(255,255,255,0.08)', color: allowWeakOpportunityGeneration ? '#22C55E' : '#CBD5E1' }}>
                      {allowWeakOpportunityGeneration ? 'Előkészítés engedélyezve' : 'Előkészítő csomag'}
                    </button>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Input form */}
      <div className="rounded-xl p-5 mb-6 space-y-5" style={{ background: '#0F1420', border: '1px solid rgba(255,255,255,0.08)' }}>
        {/* Téma */}
        <div>
          <label className="block text-sm font-medium mb-1.5" style={{ color: '#CBD5E1' }}>Videó témája</label>
          <input value={topic} onChange={e => setTopic(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleGenerate()}
            placeholder="pl. AI szemüveg — a jövő már itt van"
            className="w-full rounded-lg px-4 py-3 text-sm"
            style={{ background: '#121826', border: '1px solid rgba(255,255,255,0.08)', color: '#F8FAFC' }} />
        </div>

        {/* Platform */}
        <div>
          <label className="block text-sm font-medium mb-2" style={{ color: '#CBD5E1' }}>Platform</label>
          <SelectGroup options={PLATFORMS} value={platform} onChange={setPlatform} />
        </div>

        {/* Videóhossz */}
        <div>
          <label className="block text-sm font-medium mb-2" style={{ color: '#CBD5E1' }}>Videóhossz</label>
          <SelectGroup
            options={isShorts ? VIDEO_LENGTHS.shorts : VIDEO_LENGTHS.long}
            value={videoLength}
            onChange={setVideoLength}
          />
        </div>

        {/* Narrációs stílus */}
        <div>
          <label className="block text-sm font-medium mb-2" style={{ color: '#CBD5E1' }}>
            Narrációs stílus
            {profile?.narration_style && <span className="ml-2 text-xs" style={{ color: '#94A3B8' }}>(profil alapértelmezett)</span>}
          </label>
          <SelectGroup options={NARRATION_STYLES} value={narrationStyle} onChange={setNarrationStyle} />
          {narrationStyle === 'sajat' && (
            <textarea value={customPrompt} onChange={e => setCustomPrompt(e.target.value)}
              placeholder='pl. "Írj Dylan Page stílusú, laza, pletykás narrációt magyarul."'
              rows={2} className="mt-2 w-full rounded-lg px-4 py-3 text-sm resize-none"
              style={{ background: '#121826', border: '1px solid rgba(255,255,255,0.08)', color: '#F8FAFC' }} />
          )}
        </div>

        {/* Intenzitás + Cél */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-2" style={{ color: '#CBD5E1' }}>Intenzitás</label>
            <SelectGroup options={INTENSITIES} value={intensity} onChange={setIntensity} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-2" style={{ color: '#CBD5E1' }}>Cél</label>
            <SelectGroup options={GOALS} value={goal} onChange={setGoal} />
          </div>
        </div>

        {reopenedWithoutCharge ? (
          <div className="flex items-center gap-2 text-xs mb-1 px-3 py-2 rounded-lg" style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)', color: '#22C55E' }}>
            <span>✓</span>
            <span>Mentett csomag megnyitva — nem vontunk le új kreditet. Újragenerálás új kreditet fogyaszt.</span>
          </div>
        ) : saved ? (
          <div className="flex items-center gap-2 text-xs mb-1 px-3 py-2 rounded-lg" style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)', color: '#22C55E' }}>
            <span>✓</span>
            <span>Gyártási csomag elkészült és mentésre került. Újragenerálás új kreditet fogyaszt.</span>
          </div>
        ) : (
          <div className="flex items-center justify-between text-xs mb-1" style={{ color: '#94A3B8' }}>
            <span>Generálás ára: <span style={{ color: '#3B82F6' }}>{isShorts ? '2' : '6'} kredit</span></span>
          </div>
        )}
        <button onClick={handleGenerate} disabled={loading || !topic.trim() || generationBlockedByOpportunity}
          className="w-full py-3 rounded-lg font-semibold text-sm transition-all disabled:opacity-40"
          style={{ background: (loading || generationBlockedByOpportunity) ? '#121826' : 'linear-gradient(135deg, #3B82F6, #2563EB)', color: generationBlockedByOpportunity ? '#CBD5E1' : '#080B12' }}>
          {loading ? (
            <span className="flex items-center justify-center gap-2">
              <span className="inline-block w-4 h-4 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#3B82F6', borderTopColor: 'transparent' }} />
              {factsLoading ? 'Tényadatok keresése (Wikipedia, Google)...' : (isShorts ? 'Shorts csomag generálása...' : 'Long videó csomag generálása...')}
            </span>
          ) : generationBlockedByOpportunity ? 'Előbb validálás vagy előkészítés' : saved ? `🔄 Újragenerálás (${isShorts ? '2' : '6'} kredit)` : opportunityPreparationMode ? `🧭 ${isShorts ? 'Shorts' : 'Long videó'} előkészítő csomag` : `🎬 ${isShorts ? 'Shorts' : 'Long videó'} csomag generálása`}
        </button>
      </div>

      {loading && (
        <div className="rounded-xl p-5 mb-6" style={{ background: '#0F1420', border: '1px solid rgba(255,255,255,0.08)' }}>
          <LoadingScreen steps={LOADING_STEPS.videoPackage} message={factsLoading ? 'Tényadatok keresése (Wikipedia, Google)...' : undefined} />
        </div>
      )}

      {error && <div className="rounded-xl px-5 py-4 mb-6 text-sm" style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', color: '#EF4444' }}>{error}</div>}

      {result && (
        <div className="space-y-4">
          {/* Header */}
          <div className="rounded-xl p-5" style={{ background: 'linear-gradient(135deg, rgba(59,130,246,0.08), rgba(139,92,246,0.08))', border: '1px solid rgba(59,130,246,0.2)' }}>
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <h2 className="font-bold text-lg mb-2" style={{ color: '#F8FAFC' }}>{result.topic}</h2>
                <div className="flex gap-2 flex-wrap">
                  {[
                    PLATFORMS.find(p => p.value === result.platform)?.label,
                    result.video_length,
                    NARRATION_STYLES.find(s => s.value === result.narration_style)?.label,
                    result.intensity,
                  ].filter(Boolean).map((tag, i) => (
                    <span key={i} className="text-xs px-2.5 py-1 rounded-full font-medium"
                      style={{ background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)', color: '#3B82F6' }}>
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex flex-col items-end gap-2">
                {result.from_paid_result ? (
                  <span className="text-xs" style={{ color: '#22C55E' }}>
                    Mentett eredmény, kredit nélkül megnyitva
                  </span>
                ) : result._credits_remaining !== undefined && (
                  <span className="text-xs" style={{ color: '#94A3B8' }}>
                    Maradék kredit: <span style={{ color: '#3B82F6' }}>{result._credits_remaining.toFixed(1)}</span>
                  </span>
                )}
                <div className="flex gap-2 flex-wrap">
                <CopyBtn text={fullText} label="📋 Teljes csomag" />
                <button onClick={saveToCalendar} disabled={calendarStatus === 'saving' || calendarStatus === 'saved'}
                  className="text-xs px-3 py-1.5 rounded-lg border transition-all"
                  style={{
                    background: calendarStatus === 'saved' ? 'rgba(34,197,94,0.1)' : calendarStatus === 'error' ? 'rgba(239,68,68,0.1)' : '#121826',
                    border: calendarStatus === 'saved' ? '1px solid rgba(34,197,94,0.3)' : calendarStatus === 'error' ? '1px solid rgba(239,68,68,0.3)' : '1px solid rgba(255,255,255,0.08)',
                    color: calendarStatus === 'saved' ? '#22C55E' : calendarStatus === 'error' ? '#EF4444' : '#CBD5E1',
                  }}>
                  {calendarStatus === 'saved' ? '✓ Naptárba mentve' : calendarStatus === 'saving' ? 'Mentés...' : calendarStatus === 'error' ? 'Hiba, próbáld újra' : '📅 Naptárba mentés'}
                </button>
                <span className="text-xs px-3 py-1.5 rounded-lg border"
                  style={{ background: saved ? 'rgba(34,197,94,0.1)' : '#121826', border: saved ? '1px solid rgba(34,197,94,0.3)' : '1px solid rgba(255,255,255,0.08)', color: saved ? '#22C55E' : '#CBD5E1' }}>
                  {saved ? '✓ Automatikusan elmentve' : 'Mentés...'}
                </span>
                </div>
              </div>
            </div>
          </div>

          {/* Producer brief */}
          <Block title="🎛 Producer brief" accent="rgba(34,197,94,0.2)">
            {(() => {
              const quality = getQualityMeta(result.quality_status)
              const context = result.opportunity_context || opportunityContext
              const riskFlags = context?.risk_flags || []
              const { webSourceCount, videoEvidenceCount } = getSourceCounts(result, opportunityContext)
              return (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    <div className="rounded-lg p-3" style={{ background: quality.bg, border: `1px solid ${quality.color}30` }}>
                      <p className="text-xs mb-1" style={{ color: quality.color }}>Minőség</p>
                      <p className="text-sm font-bold" style={{ color: '#F8FAFC' }}>{quality.label}</p>
                    </div>
                    <div className="rounded-lg p-3" style={{ background: '#0A0E18', border: '1px solid rgba(255,255,255,0.06)' }}>
                      <p className="text-xs mb-1" style={{ color: '#CBD5E1' }}>Gyártási státusz</p>
                      <p className="text-sm font-bold" style={{ color: '#F8FAFC' }}>{context?.ready_to_produce_label || 'Kézi ellenőrzés'}</p>
                    </div>
                    <div className="rounded-lg p-3" style={{ background: '#0A0E18', border: '1px solid rgba(255,255,255,0.06)' }}>
                      <p className="text-xs mb-1" style={{ color: '#CBD5E1' }}>Források</p>
                      <p className="text-sm font-bold" style={{ color: '#F8FAFC' }}>{webSourceCount} web · {videoEvidenceCount} video</p>
                    </div>
                    <div className="rounded-lg p-3" style={{ background: '#0A0E18', border: '1px solid rgba(255,255,255,0.06)' }}>
                      <p className="text-xs mb-1" style={{ color: '#CBD5E1' }}>Célhossz</p>
                      <p className="text-sm font-bold" style={{ color: '#F8FAFC' }}>{result.estimated_duration || result.video_length}</p>
                    </div>
                  </div>
                  {context?.preparation_mode && (
                    <p className="text-xs rounded-lg px-3 py-2" style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.18)', color: '#93C5FD' }}>
                      Előkészítő csomag: a téma még validálást igényel, ezért publikálás előtt ellenőrizd a forrásokat és a videós jeleket.
                    </p>
                  )}
                  {result.intensity_downgraded && (
                    <p className="text-xs rounded-lg px-3 py-2" style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.18)', color: '#F59E0B' }}>
                      Intenzitás visszavéve: {result.intensity_downgrade_reason || 'factual téma miatt óvatosabb megfogalmazás szükséges.'}
                    </p>
                  )}
                  {riskFlags.length > 0 && (
                    <div className="rounded-lg px-3 py-2" style={{ background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.15)' }}>
                      <p className="text-xs font-semibold mb-1" style={{ color: '#F59E0B' }}>Figyelendő pontok</p>
                      <div className="flex flex-wrap gap-1.5">
                        {riskFlags.map(flag => (
                          <span key={flag} className="text-xs px-2 py-0.5 rounded-full" style={{ background: '#121826', color: '#CBD5E1', border: '1px solid rgba(255,255,255,0.08)' }}>{flag}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
                    {['Forrás check', 'Narráció próba', 'B-roll lista', 'Thumbnail', 'CTA'].map(item => (
                      <div key={item} className="rounded-lg px-3 py-2" style={{ background: '#0A0E18', border: '1px solid rgba(255,255,255,0.06)', color: '#CBD5E1' }}>
                        ✓ {item}
                      </div>
                    ))}
                  </div>
                  <CopyBtn text={producerBrief} label="📋 Producer brief másolása" />
                </div>
              )
            })()}
          </Block>

          {/* Feltöltési időszak */}
          {result.upload_times && (
            <Block title="⏰ Ajánlott feltöltési időszak" accent="rgba(245,158,11,0.2)">
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg p-3" style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)' }}>
                  <p className="text-xs mb-1" style={{ color: '#F59E0B' }}>🥇 Elsődleges</p>
                  <p className="font-bold" style={{ color: '#F8FAFC' }}>{result.upload_times.primary}</p>
                </div>
                <div className="rounded-lg p-3" style={{ background: '#0A0E18', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <p className="text-xs mb-1" style={{ color: '#CBD5E1' }}>🥈 Másodlagos</p>
                  <p className="font-bold" style={{ color: '#F8FAFC' }}>{result.upload_times.secondary}</p>
                </div>
              </div>
              <p className="text-xs mt-2" style={{ color: '#CBD5E1' }}>ℹ️ {result.upload_times.reason}</p>
            </Block>
          )}

          {/* Hook */}
          <Block title="🎣 Hook" accent="rgba(139,92,246,0.2)">
            <p className="text-sm leading-relaxed font-medium" style={{ color: '#F8FAFC' }}>{result.hook}</p>
            <div className="mt-3"><CopyBtn text={result.hook} label="📋 Hook másolása" /></div>
            {result.hook_variations && result.hook_variations.length > 0 && (
              <div className="mt-4 pt-4 space-y-2" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                <p className="text-xs" style={{ color: '#94A3B8' }}>Alternatív hook-ok, ha másik szöget akarsz</p>
                {result.hook_variations.map((variant, i) => (
                  <div key={i} className="flex items-center justify-between gap-3 rounded-lg px-3 py-2" style={{ background: '#0A0E18', border: '1px solid rgba(255,255,255,0.06)' }}>
                    <span className="text-sm" style={{ color: '#D1D9E6' }}>{variant}</span>
                    <CopyBtn text={variant} label="📋" />
                  </div>
                ))}
              </div>
            )}
          </Block>

          {/* Miért működhet + kockázatok */}
          {(result.why_it_works || (result.risks && result.risks.length > 0)) && (
            <Block title="🎯 Miért működhet ez" accent="rgba(34,197,94,0.2)">
              {result.why_it_works && (
                <p className="text-sm leading-relaxed mb-3" style={{ color: '#F8FAFC' }}>{result.why_it_works}</p>
              )}
              {result.risks && result.risks.length > 0 && (
                <div>
                  <p className="text-xs mb-2" style={{ color: '#F59E0B' }}>⚠️ Kockázatok, amikre figyelj</p>
                  <ul className="space-y-1">
                    {result.risks.map((risk, i) => (
                      <li key={i} className="text-xs flex items-start gap-2" style={{ color: '#CBD5E1' }}>
                        <span style={{ color: '#F59E0B' }}>•</span>{risk}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Block>
          )}

          {/* Narráció */}
          <Block title={isShorts ? '🎙 Narráció (shorts)' : '🎙 Teljes narráció'}>
            <p className="text-sm leading-relaxed whitespace-pre-wrap" style={{ color: '#D1D9E6' }}>{result.narration}</p>
            <div className="mt-3"><CopyBtn text={result.narration} label="📋 Narráció másolása" /></div>
          </Block>

          {/* Jelenetek */}
          <Block title="🎬 Jelenetstruktúra">
            <div className="space-y-3">
              {result.scene_structure.map(scene => (
                <div key={scene.number} className="rounded-lg p-4" style={{ background: '#0A0E18', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <div className="flex items-center gap-3 mb-2">
                    <span className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
                      style={{ background: 'rgba(59,130,246,0.15)', color: '#3B82F6' }}>{scene.number}</span>
                    <span className="font-semibold text-sm" style={{ color: '#F8FAFC' }}>{scene.title}</span>
                    <span className="text-xs ml-auto" style={{ color: '#94A3B8' }}>{scene.duration}</span>
                  </div>
                  <p className="text-xs mb-1" style={{ color: '#94A3B8' }}>📷 <span style={{ color: '#CBD5E1' }}>{scene.visual}</span></p>
                  <p className="text-xs" style={{ color: '#94A3B8' }}>🎙 <span style={{ color: '#CBD5E1' }}>{scene.narration}</span></p>
                </div>
              ))}
            </div>
          </Block>

          {/* Timestamps (csak long videónál) */}
          {!isShorts && result.timestamps && result.timestamps.length > 0 && (
            <Block title="⏱ Időbélyegek">
              <div className="space-y-1">
                {result.timestamps.map((ts, i) => (
                  <p key={i} className="text-sm font-mono" style={{ color: '#D1D9E6' }}>{ts}</p>
                ))}
              </div>
              <div className="mt-3"><CopyBtn text={result.timestamps.join('\n')} label="📋 Időbélyegek másolása" /></div>
            </Block>
          )}

          {/* B-roll */}
          <Block title="🎥 B-roll ötletek">
            <ul className="space-y-1.5">
              {result.broll_ideas.map((idea, i) => (
                <li key={i} className="flex items-start gap-2 text-sm" style={{ color: '#CBD5E1' }}>
                  <span style={{ color: '#3B82F6' }}>→</span>{idea}
                </li>
              ))}
            </ul>
          </Block>

          {/* Thumbnail / Overlay szövegek */}
          <Block title={isShorts ? '📱 Overlay / Caption szövegek' : '🖼 Thumbnail szövegek'}>
            {result.thumbnail_concept && (
              <p className="text-xs leading-relaxed mb-3" style={{ color: '#94A3B8' }}>💡 {result.thumbnail_concept}</p>
            )}
            <div className="grid grid-cols-2 gap-2">
              {result.thumbnail_texts.map((text, i) => (
                <div key={i} className="rounded-lg p-3 text-center font-bold text-sm" style={{ background: '#0A0E18', border: '1px solid rgba(255,255,255,0.06)', color: '#F8FAFC' }}>
                  {text}
                </div>
              ))}
            </div>
          </Block>

          {/* Cím variációk */}
          <Block title="✏️ 5 cím variáció">
            <div className="space-y-2">
              {result.title_variations.map((title, i) => (
                <div key={i} className="flex items-center justify-between gap-3 rounded-lg px-4 py-2.5" style={{ background: '#0A0E18', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <span className="text-sm" style={{ color: '#F8FAFC' }}>{i + 1}. {title}</span>
                  <CopyBtn text={title} label="📋" />
                </div>
              ))}
            </div>
          </Block>

          {/* Caption (shorts) vagy Leírás (long) */}
          {isShorts ? (
            <Block title="📝 Caption">
              <p className="text-sm leading-relaxed" style={{ color: '#D1D9E6' }}>{result.caption}</p>
              <div className="mt-3"><CopyBtn text={result.caption} label="📋 Caption másolása" /></div>
            </Block>
          ) : (
            <Block title="📝 Leírás">
              <p className="text-sm leading-relaxed whitespace-pre-wrap" style={{ color: '#D1D9E6' }}>{result.description}</p>
              <div className="mt-3"><CopyBtn text={result.description} label="📋 Leírás másolása" /></div>
            </Block>
          )}

          {/* Hashtag csomag */}
          <Block title="# Hashtag csomag">
            <div className="space-y-3">
              {[
                { label: '🔥 Viral potential', tags: result.hashtags.viral, color: '#EF4444' },
                { label: '🎯 Niche', tags: result.hashtags.niche, color: '#3B82F6' },
                { label: '✅ Általános', tags: result.hashtags.general, color: '#CBD5E1' },
              ].map(group => (
                <div key={group.label}>
                  <p className="text-xs mb-2" style={{ color: group.color }}>{group.label}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {group.tags.map((tag, i) => (
                      <span key={i} className="text-xs px-2.5 py-1 rounded-full font-medium"
                        style={{ background: 'rgba(139,92,246,0.1)', border: '1px solid rgba(139,92,246,0.2)', color: '#8B5CF6' }}>
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3">
              <CopyBtn text={[...result.hashtags.viral, ...result.hashtags.niche, ...result.hashtags.general].join(' ')} label="📋 Összes hashtag másolása" />
            </div>
          </Block>

          {/* CTA */}
          <Block title="📢 CTA" accent="rgba(34,197,94,0.2)">
            <p className="text-sm leading-relaxed" style={{ color: '#F8FAFC' }}>{result.cta}</p>
            <div className="mt-3"><CopyBtn text={result.cta} label="📋 CTA másolása" /></div>
          </Block>

          {/* Kitűzhető komment */}
          {result.pinned_comment && (
            <Block title="📌 Kitűzhető komment">
              <p className="text-sm leading-relaxed" style={{ color: '#D1D9E6' }}>{result.pinned_comment}</p>
              <div className="mt-3"><CopyBtn text={result.pinned_comment} label="📋 Komment másolása" /></div>
            </Block>
          )}

          {/* Platform-natív feltöltési checklist */}
          {result.platform_checklist && (
            <Block title="📤 Platform-natív feltöltési checklist" accent="rgba(59,130,246,0.2)">
              {result.platform_checklist.type === 'youtube' && (() => {
                const pc = result.platform_checklist as Extract<PlatformChecklist, { type: 'youtube' }>
                const rows: [string, string][] = [
                  ['Cím', pc.title],
                  ['Kategória', pc.category],
                  ['Nyelv', pc.language],
                  ['Feliratok', pc.captions_note],
                  ['Hozzászólások', pc.comments_setting],
                  ['Made for kids', pc.made_for_kids ? `Igen — ${pc.made_for_kids_reason}` : `Nem — ${pc.made_for_kids_reason}`],
                  ['Korhatár', pc.age_restriction ? `Igen — ${pc.age_restriction_reason}` : `Nem — ${pc.age_restriction_reason}`],
                  ['Licenc', pc.license],
                  ['Fizetett promóció', pc.paid_promotion_disclosure ? `Igen — ${pc.paid_promotion_disclosure_note}` : pc.paid_promotion_disclosure_note],
                  ['Láthatóság / ütemezés', pc.visibility_schedule_advice],
                  ['Lejátszási lista', pc.playlist_suggestion],
                  ...(pc.end_screens_plan ? [['Végképernyők', pc.end_screens_plan] as [string, string]] : []),
                  ...(pc.cards_plan ? [['Kártyák', pc.cards_plan] as [string, string]] : []),
                ]
                return (
                  <div className="space-y-2">
                    {rows.map(([label, value]) => (
                      <div key={label} className="rounded-lg px-3 py-2" style={{ background: '#0A0E18', border: '1px solid rgba(255,255,255,0.06)' }}>
                        <p className="text-xs mb-0.5" style={{ color: '#94A3B8' }}>{label}</p>
                        <p className="text-sm" style={{ color: '#F8FAFC' }}>{value}</p>
                      </div>
                    ))}
                    <div className="rounded-lg px-3 py-2" style={{ background: '#0A0E18', border: '1px solid rgba(255,255,255,0.06)' }}>
                      <p className="text-xs mb-1" style={{ color: '#94A3B8' }}>Leírás</p>
                      <p className="text-sm whitespace-pre-wrap" style={{ color: '#D1D9E6' }}>{pc.description}</p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {pc.tags.map((tag, i) => (
                        <span key={i} className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)', color: '#3B82F6' }}>{tag}</span>
                      ))}
                    </div>
                  </div>
                )
              })()}
              {result.platform_checklist.type === 'tiktok' && (() => {
                const pc = result.platform_checklist as Extract<PlatformChecklist, { type: 'tiktok' }>
                const rows: [string, string][] = [
                  ['Caption', pc.caption],
                  ['Borítókép', pc.cover_image_guidance],
                  ['Hang', pc.sound_note],
                  ['Láthatóság', pc.privacy_setting],
                  ['Duet / Stitch / Komment', pc.duet_stitch_comments_settings],
                  ['Branded content', pc.branded_content_disclosure],
                ]
                return (
                  <div className="space-y-2">
                    {rows.map(([label, value]) => (
                      <div key={label} className="rounded-lg px-3 py-2" style={{ background: '#0A0E18', border: '1px solid rgba(255,255,255,0.06)' }}>
                        <p className="text-xs mb-0.5" style={{ color: '#94A3B8' }}>{label}</p>
                        <p className="text-sm" style={{ color: '#F8FAFC' }}>{value}</p>
                      </div>
                    ))}
                    <div className="flex flex-wrap gap-1.5">
                      {pc.hashtags.map((tag, i) => (
                        <span key={i} className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)', color: '#3B82F6' }}>{tag}</span>
                      ))}
                    </div>
                  </div>
                )
              })()}
              {result.platform_checklist.type === 'instagram_reels' && (() => {
                const pc = result.platform_checklist as Extract<PlatformChecklist, { type: 'instagram_reels' }>
                const rows: [string, string][] = [
                  ['Caption', pc.caption],
                  ['Borítókép', pc.cover_image],
                  ['Hang', pc.audio_note],
                  ['Alt-text', pc.alt_text],
                  ['Megosztás a Feedre', pc.share_to_feed_toggle],
                  ['Collab tag', pc.collab_tag_guidance],
                  ['Branded content', pc.branded_content_disclosure],
                ]
                return (
                  <div className="space-y-2">
                    {rows.map(([label, value]) => (
                      <div key={label} className="rounded-lg px-3 py-2" style={{ background: '#0A0E18', border: '1px solid rgba(255,255,255,0.06)' }}>
                        <p className="text-xs mb-0.5" style={{ color: '#94A3B8' }}>{label}</p>
                        <p className="text-sm" style={{ color: '#F8FAFC' }}>{value}</p>
                      </div>
                    ))}
                    <div className="flex flex-wrap gap-1.5">
                      {pc.hashtags.map((tag, i) => (
                        <span key={i} className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)', color: '#3B82F6' }}>{tag}</span>
                      ))}
                    </div>
                  </div>
                )
              })()}
              {result.platform_checklist.type === 'facebook_reels' && (() => {
                const pc = result.platform_checklist as Extract<PlatformChecklist, { type: 'facebook_reels' }>
                const rows: [string, string][] = [
                  ['Caption', pc.caption],
                  ['Keresztposztolás a Feedre', pc.cross_post_to_feed],
                  ['Közönség / láthatóság', pc.audience_visibility],
                  ['Zene', pc.music_note],
                ]
                return (
                  <div className="space-y-2">
                    {rows.map(([label, value]) => (
                      <div key={label} className="rounded-lg px-3 py-2" style={{ background: '#0A0E18', border: '1px solid rgba(255,255,255,0.06)' }}>
                        <p className="text-xs mb-0.5" style={{ color: '#94A3B8' }}>{label}</p>
                        <p className="text-sm" style={{ color: '#F8FAFC' }}>{value}</p>
                      </div>
                    ))}
                  </div>
                )
              })()}
            </Block>
          )}

          {/* Gyártási checklist */}
          {result.production_checklist && result.production_checklist.length > 0 && (
            <Block title="✅ Gyártási checklist">
              <ul className="space-y-1.5">
                {result.production_checklist.map((step, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm" style={{ color: '#CBD5E1' }}>
                    <span style={{ color: '#22C55E' }}>☐</span>{step}
                  </li>
                ))}
              </ul>
            </Block>
          )}

          {/* Bizonyíték videók — a valós opportunityContext.evidence_videos tömbből,
              NEM az AI által szabadon generált sources_used-ból (az csak a
              webes forrásokat szokta megbízhatóan visszaadni, a videókat
              gyakran figyelmen kívül hagyja — ezért korábban a fenti "X web ·
              Y video" számláló Y-t mutatott, de sehol nem jelent meg a Y videó). */}
          {opportunityContext?.evidence_videos && opportunityContext.evidence_videos.length > 0 && (
            <Block title={`🎥 Bizonyíték videók (${opportunityContext.evidence_videos.length})`} accent="rgba(59,130,246,0.15)">
              <p className="text-xs mb-3" style={{ color: '#CBD5E1' }}>
                Ezek a YouTube-videók igazolják, hogy a témának van piaci/nézettségi jele.
              </p>
              <div className="space-y-2">
                {opportunityContext.evidence_videos.map((v, i) => (
                  <a key={v.video_id || i} href={v.url} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-2 rounded-lg p-2 transition-all hover:opacity-80"
                    style={{ background: '#0A0E18', border: '1px solid rgba(255,255,255,0.06)' }}>
                    <div className="w-16 h-10 rounded overflow-hidden flex-shrink-0" style={{ background: '#121826' }}>
                      {v.thumbnail_url && <img src={v.thumbnail_url} alt="" className="w-full h-full object-cover" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium line-clamp-1" style={{ color: '#F8FAFC' }}>{v.title}</p>
                      <p className="text-xs" style={{ color: '#94A3B8' }}>{v.channel_title} · 👁 {v.view_count?.toLocaleString('hu-HU') || 0}</p>
                    </div>
                  </a>
                ))}
              </div>
            </Block>
          )}

          {/* Források */}
          {result.sources_used && result.sources_used.length > 0 && (
            <Block title="🔍 Felhasznált források" accent="rgba(34,197,94,0.15)">
              <p className="text-xs mb-3" style={{ color: '#CBD5E1' }}>
                A narráció a következő ellenőrzött forrásokból dolgozott. A konkrét adatok, számok ezekből származnak.
              </p>
              <div className="space-y-2">
                {result.sources_used.map((src, i) => (
                  <a key={i} href={src.url} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-2 text-sm rounded-lg px-3 py-2 transition-all hover:opacity-80"
                    style={{ background: '#0A0E18', border: '1px solid rgba(255,255,255,0.06)', color: '#3B82F6' }}>
                    <span>🔗</span>
                    <span className="flex-1 truncate">{src.title}</span>
                  </a>
                ))}
              </div>
            </Block>
          )}
          {(!result.sources_used || result.sources_used.length === 0) && (
            <div className="rounded-xl px-4 py-3 text-xs" style={{ background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.15)', color: '#F59E0B' }}>
              ⚠️ Nem találtunk ellenőrzött forrást ehhez a témához — a narráció általános koncepció szinten készült, konkrét adatok nélkül. Publikálás előtt érdemes saját kutatást végezni.
            </div>
          )}
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
