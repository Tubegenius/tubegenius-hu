'use client'

import { useState, useEffect, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import CreditConfirmModal from '@/components/CreditConfirmModal'
import type { UsageCheckResult } from '@/lib/usage-protection'
import LoadingScreen, { LOADING_STEPS } from '@/components/ui/LoadingScreen'

type Platform = 'youtube_long' | 'youtube_shorts' | 'tiktok' | 'instagram_reels' | 'facebook_reels'
type RiskLevel = 'low' | 'medium' | 'high' | 'critical'

const PLATFORM_LABELS: Record<Platform, string> = {
  youtube_long: '▶ YouTube Long',
  youtube_shorts: '▶ YouTube Shorts',
  tiktok: '🎵 TikTok',
  instagram_reels: '📸 Instagram Reels',
  facebook_reels: '📘 Facebook Reels',
}

const DECISION_COLORS: Record<string, string> = {
  'Folytatás': 'text-green-400 bg-green-400/10 border-green-400/20',
  'Reupload': 'text-green-400 bg-green-400/10 border-green-400/20',
  'Rehook': 'text-cyan-400 bg-cyan-400/10 border-cyan-400/20',
  'Repackage': 'text-cyan-400 bg-cyan-400/10 border-cyan-400/20',
  'Remix': 'text-amber-400 bg-amber-400/10 border-amber-400/20',
  'Replatform': 'text-amber-400 bg-amber-400/10 border-amber-400/20',
  'Abandon': 'text-red-400 bg-red-400/10 border-red-400/20',
}

const RISK_COLORS: Record<RiskLevel, string> = {
  low: 'text-green-400',
  medium: 'text-amber-400',
  high: 'text-red-400',
  critical: 'text-red-500',
}

const RISK_LABELS: Record<RiskLevel, string> = {
  low: '● Alacsony kockázat',
  medium: '● Közepes kockázat',
  high: '● Magas kockázat',
  critical: '● Kritikus',
}

function scoreColor(s: number) {
  if (s >= 75) return 'text-green-400'
  if (s >= 60) return 'text-amber-400'
  return 'text-red-400'
}

function scoreBarColor(s: number) {
  if (s >= 75) return 'bg-green-400'
  if (s >= 60) return 'bg-amber-400'
  return 'bg-red-400'
}

interface AuditResult {
  audit_id?: string
  id?: string
  platform: Platform
  video_title: string
  overall_score: number
  overall_label: string
  overall_meaning?: string
  overall_risk?: RiskLevel
  overall_action?: string
  confidence: string
  decision: string
  weakest_dimension?: string
  decision_reason?: string
  final_scores: {
    hook_strength: number
    retention_potential: number
    engagement_quality: number
    platform_fit: number
    packaging_quality: number
  }
  claude_interpretation: {
    hook_strength?: { assessment: string; reason: string; suggested_fix: string }
    retention_potential?: { assessment: string; reason: string; suggested_fix: string }
    engagement_quality?: { assessment: string; reason: string; suggested_fix: string }
    platform_fit?: { assessment: string; reason: string; suggested_fix: string }
    packaging_quality?: { assessment: string; reason: string; suggested_fix: string }
    diagnosis?: string
    new_hook_suggestion?: string
    new_title_suggestion?: string
    new_caption_suggestion?: string
    hashtag_suggestions?: string[]
    upload_time_suggestion?: string
    platform_specific_tip?: string
  }
  recommendations: {
    new_hook?: string
    new_title?: string
    new_caption?: string
    hashtags?: string[]
    upload_time?: string
    platform_tip?: string
  }
  diagnosis?: string
}

// Supabase DB sor -> AuditResult konvertálás
function dbRowToResult(row: Record<string, unknown>): AuditResult {
  const finalScores = (row.final_scores as Record<string, number>) ?? {}
  const claudeInterp = (row.claude_interpretation as Record<string, unknown>) ?? {}
  const recommendations = (row.recommendations as Record<string, unknown>) ?? {}
  const overallScore = (row.overall_score as number) ?? 0

  let label = row.overall_label as string
  let meaning = ''
  let risk: RiskLevel = 'medium'
  let action = ''

  if (!label) {
    if (overallScore >= 90) { label = 'Kiváló'; meaning = 'Erős teljesítmény.'; risk = 'low'; action = 'Skálázd — készíts folytatást.' }
    else if (overallScore >= 75) { label = 'Jó'; meaning = 'Alapvetően működőképes.'; risk = 'low'; action = 'Publikálásra kész.' }
    else if (overallScore >= 60) { label = 'Közepes / javítható'; meaning = 'Van potenciál, de a csomagolás gyenge.'; risk = 'medium'; action = 'Remix vagy új hook javasolt.' }
    else if (overallScore >= 40) { label = 'Gyenge'; meaning = 'Több fő elem gyenge.'; risk = 'high'; action = 'Jelentős átdolgozás kell.' }
    else { label = 'Kritikus'; meaning = 'Nem versenyképes jelenlegi formában.'; risk = 'critical'; action = 'Új téma vagy teljes újratervezés.' }
  }

  return {
    audit_id: row.id as string,
    platform: row.platform as Platform,
    video_title: (row.video_title as string) ?? '',
    overall_score: overallScore,
    overall_label: label,
    overall_meaning: meaning,
    overall_risk: risk,
    overall_action: action,
    confidence: (row.confidence as string) ?? 'medium',
    decision: (row.decision as string) ?? '',
    weakest_dimension: '',
    decision_reason: '',
    final_scores: {
      hook_strength: finalScores.hook_strength ?? 0,
      retention_potential: finalScores.retention_potential ?? 0,
      engagement_quality: finalScores.engagement_quality ?? 0,
      platform_fit: finalScores.platform_fit ?? 0,
      packaging_quality: finalScores.packaging_quality ?? 0,
    },
    claude_interpretation: claudeInterp as AuditResult['claude_interpretation'],
    recommendations: {
      new_hook: recommendations.new_hook as string,
      new_title: recommendations.new_title as string,
      new_caption: recommendations.new_caption as string,
      hashtags: recommendations.hashtags as string[],
      upload_time: recommendations.upload_time as string,
      platform_tip: recommendations.platform_tip as string,
    },
    diagnosis: (row.diagnosis as string) ?? '',
  }
}

const DIM_LABELS: Record<string, string> = {
  hook_strength: 'Hook erőssége',
  retention_potential: 'Retenció potenciál',
  engagement_quality: 'Engagement minőség',
  platform_fit: 'Platform illeszkedés',
  packaging_quality: 'Csomagolás minősége',
}

const DIM_WEIGHTS: Record<string, string> = {
  hook_strength: '25%',
  retention_potential: '25%',
  engagement_quality: '20%',
  platform_fit: '15%',
  packaging_quality: '15%',
}

function auditDecisionMeta(result: AuditResult) {
  const decision = result.decision || 'Remix'
  const weakest = result.weakest_dimension && result.weakest_dimension !== '-' ? result.weakest_dimension : null
  const map: Record<string, { title: string; action: string; note: string; icon: string }> = {
    'Folytatás': { title: 'Skálázd tovább', action: 'Készíts folytatást vagy hasonló verziót ugyanarra az ígéretre.', note: 'A videó szerkezete működik, ezért itt nem újratervezés, hanem ismétlés és variálás a cél.', icon: 'ti-trending-up' },
    Reupload: { title: 'Újratöltés finomhangolással', action: 'Tartsd meg az alapötletet, de javíts címet, nyitást vagy csomagolást.', note: 'A videó nem rossz, inkább a belépési pontokon lehet még nyerni.', icon: 'ti-refresh' },
    Rehook: { title: 'Új hook kell', action: 'Írd újra az első 3-5 másodpercet és kezdd erősebb konfliktussal vagy ígérettel.', note: 'A téma menthető, de a nézőnek hamarabb kell okot adni a maradásra.', icon: 'ti-fish-hook' },
    Repackage: { title: 'Csomagold újra', action: 'Cserélj címet, thumbnail szöveget, captiont és első képi ígéretet.', note: 'A tartalom lehet jó, de a külső ígéret nem ad elég erős kattintási okot.', icon: 'ti-package' },
    Remix: { title: 'Remix / újravágás', action: 'Rendezd át a struktúrát, húzd előre a legerősebb részt, és vágd ki a lassú bevezetést.', note: 'A videóban van menthető jel, de a tempó vagy a felépítés nem elég feszes.', icon: 'ti-cut' },
    Replatform: { title: 'Más platformra való', action: 'Tartsd meg az ötletet, de alakítsd át a platform logikájára.', note: 'Nem feltétlen a téma rossz, hanem a forma és a platform illeszkedése gyenge.', icon: 'ti-arrows-exchange' },
    Abandon: { title: 'Ne erre építs', action: 'Válassz új témát vagy teljesen más szöget, mielőtt újabb gyártási időt teszel bele.', note: 'A jelenlegi forma túl sok fő ponton gyenge, ezért nem ez a legjobb következő lépés.', icon: 'ti-alert-triangle' },
  }
  return {
    ...(map[decision] || map.Remix),
    weakest,
    reason: result.decision_reason || result.overall_action || result.overall_meaning || 'A döntés a backend pontszámok és az audit dimenziók alapján készült.',
  }
}

export default function VideoAuditPage() {
  const searchParams = useSearchParams()
  const existingId = searchParams.get('id')

  const [platform, setPlatform] = useState<Platform>('youtube_long')
  const [videoUrl, setVideoUrl] = useState('')
  const [manualData, setManualData] = useState({
    topic: '', title: '', duration_seconds: 60,
    views: 0, likes: 0, comments: 0, shares: 0, saves: 0,
    hashtags: '', caption: '',
  })
  const [loading, setLoading] = useState(false)
  const [loadingExisting, setLoadingExisting] = useState(false)
  const [result, setResult] = useState<AuditResult | null>(null)
  const [error, setError] = useState('')
  const [creditCheck, setCreditCheck] = useState<UsageCheckResult | null>(null)
  const pendingActionRef = useRef<(() => void) | null>(null)

  const isYouTube = platform === 'youtube_long' || platform === 'youtube_shorts'

  // Visszanyitás: ha van ?id= param, betöltjük a mentett auditot
  useEffect(() => {
    if (existingId) {
      setLoadingExisting(true)
      fetch(`/api/video-audit?id=${existingId}`)
        .then(r => r.json())
        .then(data => {
          if (data.error) {
            setError(data.error)
          } else {
            setResult(dbRowToResult(data))
          }
        })
        .catch(() => setError('Hiba a betöltés során'))
        .finally(() => setLoadingExisting(false))
      return
    }
    // Keresési előzmény visszaállítása böngésző vissza gombhoz
    const saved = sessionStorage.getItem('willviral_video_audit_state')
    if (saved) {
      try {
        const state = JSON.parse(saved)
        if (state.result) setResult(state.result)
        if (state.platform) setPlatform(state.platform)
        if (state.videoUrl) setVideoUrl(state.videoUrl)
      } catch {}
    }
  }, [existingId])

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

  function handleRunAudit() {
    checkCreditsBeforeAction(4, 'Video Audit', runAudit)
  }

  async function runAudit() {
    setLoading(true)
    setError('')
    setResult(null)
    try {
      const body = isYouTube
        ? { platform, video_url: videoUrl }
        : {
            platform,
            manual_data: {
              ...manualData,
              platform,
              hashtags: manualData.hashtags.split(',').map((h: string) => h.trim()).filter(Boolean),
            },
          }
      const res = await fetch('/api/video-audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Hiba történt')
      setResult(data)

      // Mentés sessionStorage-ba — böngésző vissza gomb támogatás
      sessionStorage.setItem('willviral_video_audit_state', JSON.stringify({
        result: data,
        platform,
        videoUrl,
      }))
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Ismeretlen hiba')
    } finally {
      setLoading(false)
    }
  }

  // Betöltés alatt
  if (loadingExisting) {
    return (
      <div className="min-h-screen bg-[#080B12] flex items-center justify-center">
        <div className="text-[#CBD5E1] text-sm">Audit betöltése...</div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#080B12] text-white p-8 max-w-4xl mx-auto">

      {/* Header */}
      <div className="mb-8">
        <div className="text-xs font-semibold text-[#94A3B8] uppercase tracking-widest mb-2">Videó Audit</div>
        <h1 className="text-3xl font-black tracking-tight text-white leading-tight mb-2">
          {result ? result.video_title || 'Audit eredmény' : 'Elemezd a videódat'}
        </h1>
        <p className="text-[#CBD5E1] text-sm">
          {result ? `${PLATFORM_LABELS[result.platform]} · ${result.overall_score}/100` : 'Tudd meg miért nem működött — és pontosan mit kell csinálni.'}
        </p>
      </div>

      {/* Platform választó + form */}
      {!result && (
        <div className="bg-[#0F1420] border border-white/[0.08] rounded-2xl p-6 mb-6">
          <div className="text-xs font-semibold text-[#94A3B8] uppercase tracking-widest mb-4">Platform</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-5 mb-6">
            {(Object.keys(PLATFORM_LABELS) as Platform[]).map(p => (
              <button
                key={p}
                onClick={() => setPlatform(p)}
                className={`px-3 py-2 rounded-lg text-xs font-semibold border transition-all ${
                  platform === p
                    ? 'bg-[#3B82F6]/10 border-[#3B82F6]/40 text-[#3B82F6]'
                    : 'border-white/[0.08] text-[#CBD5E1] hover:border-white/10 hover:text-white'
                }`}
              >
                {PLATFORM_LABELS[p]}
              </button>
            ))}
          </div>

          {isYouTube ? (
            <div>
              <label className="text-xs font-semibold text-[#CBD5E1] mb-2 block">YouTube link</label>
              <input
                type="text"
                value={videoUrl}
                onChange={e => setVideoUrl(e.target.value)}
                placeholder="https://youtube.com/watch?v=..."
                className="w-full bg-[#121826] border border-white/[0.08] rounded-xl px-4 py-3 text-sm text-white placeholder-[#94A3B8] outline-none focus:border-[#3B82F6]/40 transition-colors"
              />
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {[
                { key: 'topic', label: 'Videó témája', placeholder: 'pl. Stressz és bélmikrobiom' },
                { key: 'title', label: 'Cím / Caption', placeholder: 'A videó pontos címe' },
              ].map(({ key, label, placeholder }) => (
                <div key={key}>
                  <label className="text-xs font-semibold text-[#CBD5E1] mb-2 block">{label}</label>
                  <input
                    type="text"
                    value={(manualData as Record<string, unknown>)[key] as string}
                    onChange={e => setManualData(d => ({ ...d, [key]: e.target.value }))}
                    placeholder={placeholder}
                    className="w-full bg-[#121826] border border-white/[0.08] rounded-xl px-4 py-3 text-sm text-white placeholder-[#94A3B8] outline-none focus:border-[#3B82F6]/40 transition-colors"
                  />
                </div>
              ))}
              {[
                { key: 'views', label: 'Megtekintés' },
                { key: 'likes', label: 'Like' },
                { key: 'comments', label: 'Komment' },
                { key: 'shares', label: 'Megosztás' },
                { key: 'saves', label: 'Mentés' },
                { key: 'duration_seconds', label: 'Hossz (másodperc)' },
              ].map(({ key, label }) => (
                <div key={key}>
                  <label className="text-xs font-semibold text-[#CBD5E1] mb-2 block">{label}</label>
                  <input
                    type="number"
                    value={(manualData as Record<string, unknown>)[key] as number}
                    onChange={e => setManualData(d => ({ ...d, [key]: parseInt(e.target.value) || 0 }))}
                    className="w-full bg-[#121826] border border-white/[0.08] rounded-xl px-4 py-3 text-sm text-white outline-none focus:border-[#3B82F6]/40 transition-colors"
                  />
                </div>
              ))}
              <div>
                <label className="text-xs font-semibold text-[#CBD5E1] mb-2 block">Hashtagek (vesszővel)</label>
                <input
                  type="text"
                  value={manualData.hashtags}
                  onChange={e => setManualData(d => ({ ...d, hashtags: e.target.value }))}
                  placeholder="#egészség, #tudomány"
                  className="w-full bg-[#121826] border border-white/[0.08] rounded-xl px-4 py-3 text-sm text-white placeholder-[#94A3B8] outline-none focus:border-[#3B82F6]/40 transition-colors"
                />
              </div>
            </div>
          )}

          {error && (
            <div className="mt-4 text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-xl px-4 py-3">
              {error}
            </div>
          )}

          <button
            onClick={handleRunAudit}
            disabled={loading || (isYouTube ? !videoUrl : !manualData.topic)}
            className="mt-6 w-full bg-[#3B82F6] text-black font-bold py-3 rounded-xl text-sm hover:bg-[#60A5FA] transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {loading ? 'Elemzés folyamatban... ⏳' : '🔍 Audit indítása — 4 kredit'}
          </button>
        </div>
      )}

      {loading && (
        <div className="bg-[#0F1420] border border-white/[0.08] rounded-2xl p-6 mt-6">
          <LoadingScreen steps={LOADING_STEPS.videoAudit} />
        </div>
      )}

      {/* RESULT */}
      {result && !loading && (
        <div className="space-y-6">

          {/* Overall Score Badge */}
          <div className="bg-[#0F1420] border border-white/[0.08] rounded-2xl p-6">
            <div className="flex items-start gap-6">
              <div className="flex-shrink-0">
                <div className={`text-6xl font-black tracking-tighter leading-none ${scoreColor(result.overall_score)}`}>
                  {result.overall_score}
                </div>
                <div className="text-xs text-[#94A3B8] mt-1">/100</div>
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-3 mb-2 flex-wrap">
                  <span className={`text-lg font-bold ${scoreColor(result.overall_score)}`}>{result.overall_label}</span>
                  {result.overall_risk && (
                    <span className={`text-xs font-semibold ${RISK_COLORS[result.overall_risk]}`}>
                      {RISK_LABELS[result.overall_risk]}
                    </span>
                  )}
                  <span className="text-xs text-[#94A3B8]">
                    {result.confidence === 'high' ? '🟢 Magas' : result.confidence === 'medium' ? '🟡 Közepes' : '🔴 Alacsony'} bizonyosság
                  </span>
                </div>
                {result.overall_meaning && (
                  <p className="text-[#CBD5E1] text-sm mb-3">{result.overall_meaning}</p>
                )}
                {result.overall_action && (
                  <div className={`inline-block text-sm font-semibold px-3 py-2 rounded-lg border ${DECISION_COLORS[result.decision] ?? 'text-white border-white/10'}`}>
                    → {result.overall_action}
                  </div>
                )}
              </div>
            </div>

            {(result.diagnosis || result.claude_interpretation?.diagnosis) && (
              <div className="mt-4 pt-4 border-t border-white/[0.08]">
                <div className="text-xs font-semibold text-[#94A3B8] uppercase tracking-widest mb-2">Diagnózis</div>
                <p className="text-sm text-[#CBD5E1]">{result.diagnosis || result.claude_interpretation?.diagnosis}</p>
              </div>
            )}
          </div>

          {/* Decision Block */}
          {result.decision && (() => {
            const decision = auditDecisionMeta(result)
            return (
              <div className={`rounded-2xl p-5 border ${DECISION_COLORS[result.decision] ?? 'border-white/10 bg-white/5'}`}>
                <div className="flex items-start gap-4">
                  <div className="w-11 h-11 rounded-xl bg-white/5 flex items-center justify-center flex-shrink-0">
                    <i className={`ti ${decision.icon}`} style={{ fontSize: '22px' }} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-semibold uppercase tracking-widest mb-1 opacity-70">Audit döntés</div>
                    <div className="text-xl font-black mb-1">{result.decision}: {decision.title}</div>
                    <p className="text-sm opacity-85 mb-3">{decision.reason}</p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div className="rounded-xl p-3 bg-black/15 border border-white/10">
                        <div className="text-[11px] uppercase tracking-widest opacity-60 mb-1">Első lépés</div>
                        <p className="text-sm font-medium">{decision.action}</p>
                      </div>
                      <div className="rounded-xl p-3 bg-black/15 border border-white/10">
                        <div className="text-[11px] uppercase tracking-widest opacity-60 mb-1">Miért ez?</div>
                        <p className="text-sm">{decision.weakest ? `Leggyengébb pont: ${decision.weakest}. ` : ''}{decision.note}</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )
          })()}

          {/* 5 Dimenzió */}
          <div className="bg-[#0F1420] border border-white/[0.08] rounded-2xl p-6">
            <div className="text-xs font-semibold text-[#94A3B8] uppercase tracking-widest mb-4">5 dimenzió részletesen</div>
            <div className="space-y-5">
              {(Object.keys(DIM_LABELS) as (keyof typeof DIM_LABELS)[]).map(dim => {
                const score = result.final_scores[dim as keyof typeof result.final_scores]
                const interp = result.claude_interpretation?.[dim as keyof typeof result.claude_interpretation] as { assessment?: string; reason?: string; suggested_fix?: string } | undefined
                return (
                  <div key={dim}>
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-white">{DIM_LABELS[dim]}</span>
                        <span className="text-xs text-[#94A3B8]">{DIM_WEIGHTS[dim]}</span>
                      </div>
                      <span className={`text-lg font-black ${scoreColor(score)}`}>{score}</span>
                    </div>
                    <div className="h-1.5 bg-[#121826] rounded-full overflow-hidden mb-2">
                      <div
                        className={`h-full rounded-full ${scoreBarColor(score)}`}
                        style={{ width: `${score}%` }}
                      />
                    </div>
                    {interp && (
                      <div className="text-xs text-[#CBD5E1] space-y-1">
                        {interp.reason && <p>{interp.reason}</p>}
                        {interp.suggested_fix && (
                          <p className="text-[#3B82F6]">→ {interp.suggested_fix}</p>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* Javaslatok */}
          <div className="bg-[#0F1420] border border-white/[0.08] rounded-2xl p-6">
            <div className="text-xs font-semibold text-[#94A3B8] uppercase tracking-widest mb-4">Konkrét javaslatok</div>
            <div className="space-y-4">
              {result.recommendations?.new_hook && (
                <div>
                  <div className="text-xs font-semibold text-[#3B82F6] mb-1">Új hook javaslat</div>
                  <p className="text-sm text-white bg-[#121826] border border-[#3B82F6]/20 rounded-xl px-4 py-3">
                    {result.recommendations.new_hook}
                  </p>
                </div>
              )}
              {result.recommendations?.new_title && (
                <div>
                  <div className="text-xs font-semibold text-[#CBD5E1] mb-1">Új cím javaslat</div>
                  <p className="text-sm text-white bg-[#121826] border border-white/[0.08] rounded-xl px-4 py-3">
                    {result.recommendations.new_title}
                  </p>
                </div>
              )}
              {result.recommendations?.new_caption && (
                <div>
                  <div className="text-xs font-semibold text-[#CBD5E1] mb-1">Új caption javaslat</div>
                  <p className="text-sm text-white bg-[#121826] border border-white/[0.08] rounded-xl px-4 py-3">
                    {result.recommendations.new_caption}
                  </p>
                </div>
              )}
              {result.recommendations?.upload_time && (
                <div>
                  <div className="text-xs font-semibold text-[#CBD5E1] mb-1">Feltöltési idő</div>
                  <p className="text-sm text-[#CBD5E1]">{result.recommendations.upload_time}</p>
                </div>
              )}
              {result.recommendations?.platform_tip && (
                <div>
                  <div className="text-xs font-semibold text-[#CBD5E1] mb-1">Platform-specifikus tipp</div>
                  <p className="text-sm text-[#CBD5E1]">{result.recommendations.platform_tip}</p>
                </div>
              )}
              {result.recommendations?.hashtags && result.recommendations.hashtags.length > 0 && (
                <div>
                  <div className="text-xs font-semibold text-[#CBD5E1] mb-2">Hashtag javaslatok</div>
                  <div className="flex flex-wrap gap-2">
                    {result.recommendations.hashtags.map((h, i) => (
                      <span key={i} className="text-xs px-2 py-1 rounded-full bg-[#121826] border border-white/[0.08] text-[#CBD5E1]">
                        {h.startsWith('#') ? h : `#${h}`}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Új audit gomb */}
          {!existingId && (
            <button
              onClick={() => { setResult(null); setVideoUrl('') }}
              className="w-full py-3 rounded-xl border border-white/[0.08] text-[#CBD5E1] text-sm font-semibold hover:bg-[#0F1420] hover:text-white transition-all"
            >
              + Új audit indítása
            </button>
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
