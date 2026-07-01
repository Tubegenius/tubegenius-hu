'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { VideoCardData } from '@/types'

function ExtractingOverlay() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(7,10,18,0.85)', backdropFilter: 'blur(8px)' }}>
      <div className="text-center">
        <svg viewBox="0 0 100 100" width="64" height="64" className="mx-auto mb-4">
          <defs>
            <linearGradient id="lg-ext" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#3B82F6" />
              <stop offset="100%" stopColor="#8B5CF6" />
            </linearGradient>
          </defs>
          <rect width="100" height="100" rx="20" fill="#080B12" />
          <path d="M25 30 L37.5 70 L50 42 L62.5 70 L75 30" fill="none" stroke="url(#lg-ext)" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="120" strokeDashoffset="0">
            <animate attributeName="stroke-dashoffset" values="120;0;0;120" dur="2s" repeatCount="indefinite" />
          </path>
          <circle cx="75" cy="28" r="3" fill="#22D3EE" opacity="0.9">
            <animate attributeName="opacity" values="0;0.9;0.9;0" dur="2s" repeatCount="indefinite" />
          </circle>
        </svg>
        <p className="text-base font-semibold mb-2" style={{ color: '#F8FAFC' }}>Script kinyerese...</p>
        <p className="text-sm" style={{ color: '#94A3B8' }}>A forras video tartalmat automatikusan feldolgozzuk</p>
        <p className="text-xs mt-1" style={{ color: '#64748B' }}>Fact Safety Layer aktiv — csak ellenorzott tenyeket hasznal</p>
      </div>
    </div>
  )
}

interface VideoCardActionsProps {
  video: VideoCardData
  /** Kompakt mód — kisebb gombok, kevesebb szöveg (pl. Opportunity Engine evidence lista) */
  compact?: boolean
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return n.toString()
}

export default function VideoCardActions({ video, compact = false }: VideoCardActionsProps) {
  const router = useRouter()
  const [copied, setCopied] = useState(false)
  const [loadingAction, setLoadingAction] = useState<'extract' | 'inspire' | 'own_version' | null>(null)
  const [extracting, setExtracting] = useState(false)

  function handleCopyLink(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    navigator.clipboard.writeText(video.video_url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // "Script / struktúra kinyerése" — Script Extractor oldalra navigál a videó URL-jével
  function handleExtractStructure(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    setLoadingAction('extract')
    const params = new URLSearchParams({ url: video.video_url, source_context: video.source_context })
    router.push(`/dashboard/script-extractor?${params.toString()}`)
  }

  // "Használd inspirációként" — Script Extractor, jelezve hogy ez inspirációs mód (nem másolás)
  function handleUseAsInspiration(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    setLoadingAction('inspire')
    const params = new URLSearchParams({ url: video.video_url, source_context: video.source_context, mode: 'inspiration' })
    router.push(`/dashboard/script-extractor?${params.toString()}`)
  }

  // "Saját verzió készítése" — közvetlenül Video Package, a saját verzió workflow ott indul
  // (Script Extractor -> "Saját verzió" gomb -> Video Package már megvan; itt direkt útvonal)
  function storeVideoInspirationContext() {
    try {
      sessionStorage.setItem(`willviral_video_inspiration_${video.video_id}`, JSON.stringify({
        id: video.video_id,
        title: video.title,
        channel_title: video.channel_title,
        video_url: video.video_url,
        source_context: video.source_context,
        decision_status: video.decision_status,
        decision_label: video.decision_label,
        decision_score: video.decision_score,
        risk_flags: video.risk_flags || [],
        viral_video_score: video.viral_video_score,
        relevance_score: video.relevance_score,
        score_breakdown: video.score_breakdown,
        reason: video.reason,
        views: video.views,
        likes: video.likes,
        comments: video.comments,
        published_at: video.published_at,
      }))
    } catch {}
  }

  async function handleOwnVersion(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    setLoadingAction('own_version')
    storeVideoInspirationContext()

    if (video.decision_status === 'research' || video.decision_status === 'rejected') {
      const params = new URLSearchParams({ url: video.video_url, source_context: video.source_context, mode: 'inspiration' })
      router.push(`/dashboard/script-extractor?${params.toString()}`)
      return
    }

    // Auto-transcript kinyerés — gyors, kredit nélkül, WillViral loading overlay
    setExtracting(true)
    try {
      const extractRes = await fetch('/api/quick-extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ video_url: video.video_url }),
      })
      if (extractRes.ok) {
        const extractData = await extractRes.json()
        if (extractData.transcript_available) {
          sessionStorage.setItem(`willviral_source_video_${video.video_id}`, JSON.stringify({
            video_id: extractData.video_id,
            title: extractData.title,
            channel: extractData.channel,
            url: extractData.url,
            transcript_available: true,
            transcript_source: 'transcript',
            raw_transcript: extractData.raw_transcript,
            hook: extractData.hook,
            key_points: extractData.key_points || [],
          }))
        }
      }
    } catch {}
    setExtracting(false)

    const params = new URLSearchParams({
      topic: video.title,
      source_video_id: video.video_id,
      source_video_url: video.video_url,
      source_context: video.source_context,
      inspiration_context_id: video.video_id,
      mode: 'source_video',
    })
    router.push(`/dashboard/video-package?${params.toString()}`)
  }

  const ownVersionLabel = video.decision_status === 'research' || video.decision_status === 'rejected'
    ? 'Előbb script / inspiráció'
    : 'Saját verzió készítése'
  const ownVersionIcon = video.decision_status === 'research' || video.decision_status === 'rejected' ? '🔎' : '🚀'

  if (compact) {
    return (
      <>
      {extracting && <ExtractingOverlay />}
      <div className="flex items-center gap-1 flex-wrap">
        <a href={video.video_url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
          title="YouTube megnyitása"
          className="text-xs px-2 py-1 rounded transition-all hover:opacity-80"
          style={{ background: '#121826', border: '1px solid rgba(255,255,255,0.08)', color: '#CBD5E1' }}>
          ▶
        </a>
        <button onClick={handleCopyLink} title="Link másolása"
          className="text-xs px-2 py-1 rounded transition-all hover:opacity-80"
          style={{ background: copied ? 'rgba(34,197,94,0.1)' : '#121826', border: '1px solid rgba(255,255,255,0.08)', color: copied ? '#22C55E' : '#CBD5E1' }}>
          {copied ? '✓' : '📋'}
        </button>
        <button onClick={handleExtractStructure} disabled={loadingAction !== null} title="Script / struktúra kinyerése"
          className="text-xs px-2 py-1 rounded transition-all hover:opacity-80 disabled:opacity-50"
          style={{ background: '#121826', border: '1px solid rgba(255,255,255,0.08)', color: '#CBD5E1' }}>
          {loadingAction === 'extract' ? '...' : '📝'}
        </button>
        <button onClick={handleUseAsInspiration} disabled={loadingAction !== null} title="Használd inspirációként"
          className="text-xs px-2 py-1 rounded transition-all hover:opacity-80 disabled:opacity-50"
          style={{ background: '#121826', border: '1px solid rgba(255,255,255,0.08)', color: '#CBD5E1' }}>
          {loadingAction === 'inspire' ? '...' : '💡'}
        </button>
        <button onClick={handleOwnVersion} disabled={loadingAction !== null} title={ownVersionLabel}
          className="text-xs px-2.5 py-1 rounded font-medium transition-all hover:opacity-80 disabled:opacity-50"
          style={{ background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.3)', color: '#3B82F6' }}>
          {loadingAction === 'own_version' ? '...' : ownVersionIcon}
        </button>
      </div>
      </>
    )
  }

  return (
    <>
    {extracting && <ExtractingOverlay />}
    <div className="flex items-center gap-2 flex-wrap">
      <a href={video.video_url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
        className="text-xs px-3 py-1.5 rounded-lg transition-all hover:opacity-80"
        style={{ background: '#121826', border: '1px solid rgba(255,255,255,0.08)', color: '#CBD5E1' }}>
        ▶ YouTube megnyitása
      </a>
      <button onClick={handleCopyLink}
        className="text-xs px-3 py-1.5 rounded-lg transition-all hover:opacity-80"
        style={{ background: copied ? 'rgba(34,197,94,0.1)' : '#121826', border: copied ? '1px solid rgba(34,197,94,0.3)' : '1px solid rgba(255,255,255,0.08)', color: copied ? '#22C55E' : '#CBD5E1' }}>
        {copied ? '✓ Másolva' : '📋 Link másolása'}
      </button>
      <button onClick={handleExtractStructure} disabled={loadingAction !== null}
        className="text-xs px-3 py-1.5 rounded-lg transition-all hover:opacity-80 disabled:opacity-50"
        style={{ background: '#121826', border: '1px solid rgba(255,255,255,0.08)', color: '#CBD5E1' }}>
        {loadingAction === 'extract' ? '...' : '📝 Script / struktúra'}
      </button>
      <button onClick={handleUseAsInspiration} disabled={loadingAction !== null}
        className="text-xs px-3 py-1.5 rounded-lg transition-all hover:opacity-80 disabled:opacity-50"
        style={{ background: '#121826', border: '1px solid rgba(255,255,255,0.08)', color: '#CBD5E1' }}>
        {loadingAction === 'inspire' ? '...' : '💡 Inspirációként'}
      </button>
      <button onClick={handleOwnVersion} disabled={loadingAction !== null}
        className="text-xs px-3 py-1.5 rounded-lg font-medium transition-all hover:opacity-80 disabled:opacity-50"
        style={{ background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.3)', color: '#3B82F6' }}>
        {loadingAction === 'own_version' ? 'Indítás...' : `${ownVersionIcon} ${video.decision_status === 'research' || video.decision_status === 'rejected' ? 'Előbb inspiráció' : 'Saját verzió'}`}
      </button>
    </div>
    </>
  )
}
