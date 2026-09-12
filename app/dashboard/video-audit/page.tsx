'use client'

import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { Activity, ArrowLeft, ArrowRight, BarChart3, CheckCircle2, CircleAlert, Clock3, Compass, Facebook, Gauge, History, Instagram, Link2, Play, RotateCcw, ShieldCheck, Sparkles, Target, Youtube, Zap, type LucideIcon } from 'lucide-react'
import CreditConfirmModal from '@/components/CreditConfirmModal'
import { useCreatorOS } from '@/components/dashboard/CreatorOSContext'
import LoadingScreen, { LOADING_STEPS } from '@/components/ui/LoadingScreen'
import { presentVideoAuditDecision, presentVideoAuditScore, videoAuditFormReadiness, videoAuditScoreTone, VIDEO_AUDIT_DIMENSIONS, VIDEO_AUDIT_LANE_COPY, VIDEO_AUDIT_PLATFORM_META } from '@/lib/creator-video-audit-presentation'
import type { Platform } from '@/lib/video-audit-scoring'
import type { UsageCheckResult } from '@/lib/usage-protection'

type RiskLevel = 'low' | 'medium' | 'high' | 'critical'
interface DimensionInterpretation { assessment?: string; reason?: string; suggested_fix?: string }
interface AuditResult {
  audit_id?: string; id?: string; platform: Platform; video_title: string; overall_score: number; overall_label: string
  overall_meaning?: string; overall_risk?: RiskLevel; overall_action?: string; confidence: string; decision: string
  weakest_dimension?: string; decision_reason?: string
  final_scores: Record<(typeof VIDEO_AUDIT_DIMENSIONS)[number]['key'], number>
  claude_interpretation: {
    hook_strength?: DimensionInterpretation; retention_potential?: DimensionInterpretation; engagement_quality?: DimensionInterpretation
    platform_fit?: DimensionInterpretation; packaging_quality?: DimensionInterpretation; diagnosis?: string
    new_hook_suggestion?: string; new_title_suggestion?: string; new_caption_suggestion?: string
    hashtag_suggestions?: string[]; upload_time_suggestion?: string; platform_specific_tip?: string
  }
  recommendations: { new_hook?: string; new_title?: string; new_caption?: string; hashtags?: string[]; upload_time?: string; platform_tip?: string }
  diagnosis?: string
}
interface AuditHistoryItem { id: string; platform: Platform; video_title: string; overall_score: number; decision_label?: string; created_at: string }
interface ManualData { topic: string; title: string; duration_seconds: number; views: number; likes: number; comments: number; shares: number; saves: number; hashtags: string; caption: string }

const PLATFORMS = Object.keys(VIDEO_AUDIT_PLATFORM_META) as Platform[]
const AUDIT_COST = 4

function PlatformIcon({ platform }: { platform: Platform }) {
  const icons: Record<Platform, LucideIcon> = { youtube_long: Youtube, youtube_shorts: Play, tiktok: Zap, instagram_reels: Instagram, facebook_reels: Facebook }
  const Icon = icons[platform]
  return <Icon aria-hidden="true" />
}

function confidenceLabel(confidence: string): string {
  if (confidence === 'high') return 'Magas bizonyosság'
  if (confidence === 'low') return 'Alacsony bizonyosság'
  return 'Közepes bizonyosság'
}

function riskLabel(risk?: RiskLevel): string | null {
  if (!risk) return null
  return { low: 'Alacsony kockázat', medium: 'Közepes kockázat', high: 'Magas kockázat', critical: 'Kritikus kockázat' }[risk]
}

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
    audit_id: row.id as string, platform: row.platform as Platform, video_title: (row.video_title as string) ?? '', overall_score: overallScore,
    overall_label: label, overall_meaning: meaning, overall_risk: risk, overall_action: action, confidence: (row.confidence as string) ?? 'medium',
    decision: (row.decision as string) ?? '', weakest_dimension: (row.weakest_dimension as string) ?? '', decision_reason: (row.decision_reason as string) ?? '',
    final_scores: { hook_strength: finalScores.hook_strength ?? 0, retention_potential: finalScores.retention_potential ?? 0, engagement_quality: finalScores.engagement_quality ?? 0, platform_fit: finalScores.platform_fit ?? 0, packaging_quality: finalScores.packaging_quality ?? 0 },
    claude_interpretation: claudeInterp as AuditResult['claude_interpretation'],
    recommendations: { new_hook: recommendations.new_hook as string, new_title: recommendations.new_title as string, new_caption: recommendations.new_caption as string, hashtags: recommendations.hashtags as string[], upload_time: recommendations.upload_time as string, platform_tip: recommendations.platform_tip as string },
    diagnosis: (row.diagnosis as string) ?? '',
  }
}

function AuditHistory({ audits, loading }: { audits: AuditHistoryItem[]; loading: boolean }) {
  return (
    <section className="wv-video-history" aria-labelledby="wv-video-history-title">
      <header><div><span className="wv-eyebrow">Alkotói memória</span><h2 id="wv-video-history-title">Korábbi diagnózisok.</h2></div><Link href="/dashboard/memory">Teljes memória<ArrowRight aria-hidden="true" /></Link></header>
      {loading ? <div className="wv-video-history-loading" aria-label="Audit-előzmények betöltése"><i /><i /><i /></div> : audits.length === 0 ? <div className="wv-video-history-empty"><History aria-hidden="true" /><div><strong>Az első diagnózisod itt válik emlékezetté.</strong><p>Az eredmények később a csatornamintát is építik.</p></div></div> : (
        <div className="wv-video-history-grid">{audits.slice(0, 6).map((audit, index) => {
          const score = presentVideoAuditScore(audit.overall_score)
          return <Link key={audit.id} href={`/dashboard/video-audit?id=${audit.id}`} data-tone={videoAuditScoreTone(score)}><span>{String(index + 1).padStart(2, '0')}</span><div><small>{VIDEO_AUDIT_PLATFORM_META[audit.platform]?.shortLabel || audit.platform} · {new Date(audit.created_at).toLocaleDateString('hu-HU')}</small><strong>{audit.video_title || 'Névtelen audit'}</strong><em>{audit.decision_label || 'Diagnózis megnyitása'}</em></div><b>{score}</b></Link>
        })}</div>
      )}
    </section>
  )
}

function AuditInput({ platform, videoUrl, manualData, loading, error, onPlatform, onVideoUrl, onManualData, onSubmit }: {
  platform: Platform; videoUrl: string; manualData: ManualData; loading: boolean; error: string
  onPlatform: (platform: Platform) => void; onVideoUrl: (value: string) => void; onManualData: (data: ManualData) => void; onSubmit: () => void
}) {
  const meta = VIDEO_AUDIT_PLATFORM_META[platform]
  const readiness = videoAuditFormReadiness({ platform, videoUrl, topic: manualData.topic, title: manualData.title, durationSeconds: manualData.duration_seconds })
  const isYouTube = meta.inputMode === 'url'
  const metrics: Array<{ key: keyof ManualData; label: string }> = [{ key: 'views', label: 'Megtekintés' }, { key: 'likes', label: 'Like' }, { key: 'comments', label: 'Komment' }, { key: 'shares', label: 'Megosztás' }, { key: 'saves', label: 'Mentés' }, { key: 'duration_seconds', label: 'Hossz · mp' }]
  return (
    <>
      <section className="wv-video-input-stage" aria-labelledby="wv-video-input-title">
        <div className="wv-video-input-main">
          <span className="wv-video-step"><Target aria-hidden="true" />01 · Forrás</span>
          <div><span className="wv-eyebrow">Új videódiagnózis</span><h2 id="wv-video-input-title">Mit szeretnél megérteni?</h2><p>Válaszd ki a platformot, majd add meg az elérhető jeleket. A rendszer csak a kapott adatokból dolgozik.</p></div>
          <div className="wv-video-platforms" role="group" aria-label="Platform kiválasztása">{PLATFORMS.map(item => <button key={item} type="button" aria-pressed={platform === item} onClick={() => onPlatform(item)}><PlatformIcon platform={item} /><span>{VIDEO_AUDIT_PLATFORM_META[item].shortLabel}</span><small>{VIDEO_AUDIT_PLATFORM_META[item].format}</small></button>)}</div>
        </div>
        <aside className="wv-video-protocol">
          <span className="wv-video-step"><ShieldCheck aria-hidden="true" />Diagnosztikai protokoll</span><h3>Egy videó. Öt dimenzió. Egy következő döntés.</h3>
          <ol><li><span>01</span><div><strong>Jelek rendezése</strong><small>A linkből vagy a megadott teljesítményadatokból.</small></div></li><li><span>02</span><div><strong>Dimenziók olvasása</strong><small>Hook, megtartás, aktivitás, platform és csomagolás.</small></div></li><li><span>03</span><div><strong>Alkotói mozdulat</strong><small>Mit tarts meg, és mit változtass meg először.</small></div></li></ol>
          <p><Sparkles aria-hidden="true" /><span><strong>{AUDIT_COST} kredit</strong>A feldolgozás csak megerősítés után indul.</span></p>
        </aside>
      </section>
      <section className="wv-video-source-console" data-mode={meta.inputMode}>
        <header><div><span className="wv-eyebrow">{meta.label}</span><h2>{isYouTube ? 'Illeszd be a videó linkjét.' : 'Add meg a videó és a teljesítmény jeleit.'}</h2></div><span><Activity aria-hidden="true" />{isYouTube ? 'Publikus videóadat-forrás' : 'Kézzel megadott adatok'}</span></header>
        {isYouTube ? <div className="wv-video-url-field"><Link2 aria-hidden="true" /><label htmlFor="video-audit-url"><span>YouTube-link</span><input id="video-audit-url" type="url" value={videoUrl} onChange={event => onVideoUrl(event.target.value)} placeholder="https://youtube.com/watch?v=..." autoComplete="url" /></label></div> : (
          <div className="wv-video-manual-fields">
            <label><span>Videó témája</span><input type="text" value={manualData.topic} onChange={event => onManualData({ ...manualData, topic: event.target.value })} placeholder="Például: fókusz és digitális zaj" /></label>
            <label><span>Cím vagy caption</span><input type="text" value={manualData.title} onChange={event => onManualData({ ...manualData, title: event.target.value })} placeholder="A videó pontos címe" /></label>
            <div className="wv-video-metric-fields">{metrics.map(metric => <label key={metric.key}><span>{metric.label}</span><input type="number" min="0" value={manualData[metric.key] as number} onChange={event => onManualData({ ...manualData, [metric.key]: Number.parseInt(event.target.value, 10) || 0 })} /></label>)}</div>
            <label className="wv-video-wide-field"><span>Hashtagek · vesszővel</span><input type="text" value={manualData.hashtags} onChange={event => onManualData({ ...manualData, hashtags: event.target.value })} placeholder="#creator, #fókusz" /></label>
          </div>
        )}
        {error && <div className="wv-video-alert" role="alert"><CircleAlert aria-hidden="true" /><span><strong>Az audit most nem indítható.</strong>{error}</span></div>}
        <footer><p data-ready={readiness.ready || undefined}><CheckCircle2 aria-hidden="true" />{readiness.hint}</p><button type="button" className="wv-primary-action" disabled={loading || !readiness.ready} onClick={onSubmit}>{loading ? 'Elemzés folyamatban…' : `Diagnózis indítása · ${AUDIT_COST} kredit`}<ArrowRight aria-hidden="true" /></button></footer>
      </section>
    </>
  )
}

function AuditResultView({ result, canStartNew, onStartNew }: { result: AuditResult; canStartNew: boolean; onStartNew: () => void }) {
  const { creatorLane } = useCreatorOS()
  const laneCopy = VIDEO_AUDIT_LANE_COPY[creatorLane]
  const score = presentVideoAuditScore(result.overall_score)
  const tone = videoAuditScoreTone(score)
  const decision = presentVideoAuditDecision({ decision: result.decision, weakestDimension: result.weakest_dimension, reason: result.decision_reason, overallAction: result.overall_action, overallMeaning: result.overall_meaning })
  const diagnosis = result.diagnosis || result.claude_interpretation?.diagnosis
  const recommendations = {
    hook: result.recommendations?.new_hook || result.claude_interpretation?.new_hook_suggestion,
    title: result.recommendations?.new_title || result.claude_interpretation?.new_title_suggestion,
    caption: result.recommendations?.new_caption || result.claude_interpretation?.new_caption_suggestion,
    hashtags: result.recommendations?.hashtags || result.claude_interpretation?.hashtag_suggestions,
    uploadTime: result.recommendations?.upload_time || result.claude_interpretation?.upload_time_suggestion,
    platformTip: result.recommendations?.platform_tip || result.claude_interpretation?.platform_specific_tip,
  }
  return (
    <>
      <header className="wv-page-heading wv-video-result-heading"><div><Link href="/dashboard/video-audit" className="wv-video-back"><ArrowLeft aria-hidden="true" />Új diagnózis</Link><span className="wv-eyebrow">Videódiagnózis · eredmény</span><h1>{result.video_title || 'Audit eredmény'}</h1></div><span className="wv-heading-meta">{VIDEO_AUDIT_PLATFORM_META[result.platform]?.label || result.platform}<br />{laneCopy.lens}</span></header>
      <section className="wv-video-result-stage" data-tone={tone}>
        <div className="wv-video-score-object"><span className="wv-eyebrow">Összesített auditpont</span><strong>{score}</strong><small>/100</small><i aria-hidden="true"><b style={{ '--video-score': `${score * 3.6}deg` } as React.CSSProperties} /></i><div><span>{result.overall_label}</span>{riskLabel(result.overall_risk) && <em>{riskLabel(result.overall_risk)}</em>}<small>{confidenceLabel(result.confidence)}</small></div></div>
        <div className="wv-video-decision-card"><span className="wv-video-step"><Zap aria-hidden="true" />Következő döntés</span><div><small>{decision.decision}</small><h2>{decision.title}</h2><p>{decision.reason}</p></div><article><span>Első mozdulat</span><strong>{decision.action}</strong></article>{decision.weakest && <footer><Target aria-hidden="true" />Legnagyobb fejlesztési tér: <strong>{decision.weakest}</strong></footer>}</div>
      </section>
      <p className="wv-video-lane-intent"><Sparkles aria-hidden="true" /><span><strong>{laneCopy.headline}</strong>{laneCopy.support}</span></p>
      <section className="wv-video-dimensions" aria-labelledby="wv-video-dimensions-title">
        <header><div><span className="wv-eyebrow">Jeltérkép</span><h2 id="wv-video-dimensions-title">Öt dimenzió, prioritási sorrendben.</h2></div><span>A súlyok a meglévő auditmodellből érkeznek.</span></header>
        <div>{VIDEO_AUDIT_DIMENSIONS.map((dimension, index) => {
          const dimensionScore = presentVideoAuditScore(result.final_scores[dimension.key])
          const interpretation = result.claude_interpretation?.[dimension.key] as DimensionInterpretation | undefined
          const isWeakest = result.weakest_dimension === dimension.key || result.weakest_dimension === dimension.label
          return <article key={dimension.key} data-tone={videoAuditScoreTone(dimensionScore)} data-weakest={isWeakest || undefined}><span>{String(index + 1).padStart(2, '0')}</span><div><header><strong>{dimension.label}</strong><small>{dimension.weight} súly</small></header><i><b style={{ width: `${dimensionScore}%` }} /></i>{interpretation?.reason && <p>{interpretation.reason}</p>}{interpretation?.suggested_fix && <em><ArrowRight aria-hidden="true" />{interpretation.suggested_fix}</em>}</div><b>{dimensionScore}</b></article>
        })}</div>
      </section>
      {diagnosis && <section className="wv-video-diagnosis"><Gauge aria-hidden="true" /><div><span className="wv-eyebrow">Diagnózis</span><h2>Mit mond együtt az öt jel?</h2><p>{diagnosis}</p></div></section>}
      <section className="wv-video-action-kit" aria-labelledby="wv-video-action-kit-title">
        <header><div><span className="wv-eyebrow">Alkotói akciókészlet</span><h2 id="wv-video-action-kit-title">A következő verzió építőelemei.</h2></div><span><Sparkles aria-hidden="true" />Csak a kapott javaslatok jelennek meg</span></header>
        <div className="wv-video-action-grid">
          {recommendations.hook && <article className="is-primary"><span>01 · Új hook</span><h3>Az első mondat</h3><p>{recommendations.hook}</p></article>}
          {recommendations.title && <article><span>02 · Új cím</span><h3>A külső ígéret</h3><p>{recommendations.title}</p></article>}
          {recommendations.caption && <article><span>03 · Új caption</span><h3>A kontextus</h3><p>{recommendations.caption}</p></article>}
          {(recommendations.platformTip || recommendations.uploadTime) && <article><span>04 · Platformmozdulat</span><h3>Publikálási fókusz</h3>{recommendations.platformTip && <p>{recommendations.platformTip}</p>}{recommendations.uploadTime && <small><Clock3 aria-hidden="true" />{recommendations.uploadTime}</small>}</article>}
        </div>
        {recommendations.hashtags && recommendations.hashtags.length > 0 && <div className="wv-video-hashtags"><span>Javasolt hashtagek</span><div>{recommendations.hashtags.map((hashtag, index) => <em key={`${hashtag}-${index}`}>{hashtag.startsWith('#') ? hashtag : `#${hashtag}`}</em>)}</div></div>}
      </section>
      <nav className="wv-video-next-rail" aria-label="A diagnózis következő lépései"><span><Activity aria-hidden="true" /><strong>Diagnózisból rendszer</strong></span><Link href="/dashboard/channel-audit"><BarChart3 aria-hidden="true" />Csatornaaudit</Link><Link href="/dashboard/discover"><Compass aria-hidden="true" />Felfedezés</Link><Link href="/dashboard/memory"><History aria-hidden="true" />Memória</Link>{canStartNew && <button type="button" onClick={onStartNew}><RotateCcw aria-hidden="true" />Új diagnózis</button>}</nav>
    </>
  )
}

export default function VideoAuditPage() {
  const searchParams = useSearchParams()
  const { creatorLane } = useCreatorOS()
  const existingId = searchParams.get('id')
  const paidResultId = searchParams.get('paidResultId')
  const laneCopy = VIDEO_AUDIT_LANE_COPY[creatorLane]
  const [platform, setPlatform] = useState<Platform>('youtube_long')
  const [videoUrl, setVideoUrl] = useState('')
  const [manualData, setManualData] = useState<ManualData>({ topic: '', title: '', duration_seconds: 60, views: 0, likes: 0, comments: 0, shares: 0, saves: 0, hashtags: '', caption: '' })
  const [loading, setLoading] = useState(false)
  const [loadingExisting, setLoadingExisting] = useState(false)
  const [result, setResult] = useState<AuditResult | null>(null)
  const [error, setError] = useState('')
  const [creditCheck, setCreditCheck] = useState<UsageCheckResult | null>(null)
  const [auditHistory, setAuditHistory] = useState<AuditHistoryItem[]>([])
  const [historyLoading, setHistoryLoading] = useState(true)
  const pendingActionRef = useRef<(() => void) | null>(null)

  useEffect(() => { fetch('/api/video-audits').then(response => response.json()).then(data => setAuditHistory(Array.isArray(data.audits) ? data.audits : [])).catch(() => setAuditHistory([])).finally(() => setHistoryLoading(false)) }, [])
  useEffect(() => {
    if (paidResultId) { setLoadingExisting(true); fetch(`/api/video-audit?paidResultId=${paidResultId}`).then(response => response.json()).then(data => data.error ? setError(data.error) : setResult(data)).catch(() => setError('Hiba a mentett diagnózis betöltésekor.')).finally(() => setLoadingExisting(false)); return }
    if (existingId) { setLoadingExisting(true); fetch(`/api/video-audit?id=${existingId}`).then(response => response.json()).then(data => data.error ? setError(data.error) : setResult(dbRowToResult(data))).catch(() => setError('Hiba a diagnózis betöltésekor.')).finally(() => setLoadingExisting(false)); return }
    try { const saved = sessionStorage.getItem('willviral_video_audit_state'); if (saved) { const state = JSON.parse(saved); if (state.result) setResult(state.result); if (state.platform) setPlatform(state.platform); if (state.videoUrl) setVideoUrl(state.videoUrl) } } catch {}
  }, [existingId, paidResultId])

  async function checkCreditsBeforeAction(onConfirm: () => void) {
    try {
      const response = await fetch('/api/credits'); const credits = await response.json(); const balance = Number(credits.balance ?? 0)
      pendingActionRef.current = balance >= AUDIT_COST ? onConfirm : null
      setCreditCheck({ feature: 'Video Audit', cost: AUDIT_COST, currency: 'credit', currentCredits: Math.round(balance), remainingCreditsAfterRun: balance >= AUDIT_COST ? Math.round(balance - AUDIT_COST) : Math.round(balance), requiresConfirmation: true, canRun: balance >= AUDIT_COST, reason: balance >= AUDIT_COST ? undefined : 'insufficient_credits', message: balance >= AUDIT_COST ? `A diagnózis ${AUDIT_COST} kreditbe kerül.` : `Nincs elég kredited. ${AUDIT_COST} kredit szükséges, neked ${Math.round(balance)} van.` })
    } catch { setError('A kreditegyenleg most nem ellenőrizhető. Próbáld újra.') }
  }

  function handleRunAudit() {
    const readiness = videoAuditFormReadiness({ platform, videoUrl, topic: manualData.topic, title: manualData.title, durationSeconds: manualData.duration_seconds })
    if (!readiness.ready) { setError(readiness.hint); return }
    setError(''); void checkCreditsBeforeAction(runAudit)
  }

  async function runAudit() {
    setLoading(true); setError(''); setResult(null)
    try {
      const isYouTube = VIDEO_AUDIT_PLATFORM_META[platform].inputMode === 'url'
      const body = isYouTube ? { platform, video_url: videoUrl } : { platform, manual_data: { ...manualData, platform, hashtags: manualData.hashtags.split(',').map(hashtag => hashtag.trim()).filter(Boolean) } }
      const response = await fetch('/api/video-audit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? 'A diagnózis nem készült el.')
      setResult(data); try { sessionStorage.setItem('willviral_video_audit_state', JSON.stringify({ result: data, platform, videoUrl })) } catch {}
    } catch (caught: unknown) { setError(caught instanceof Error ? caught.message : 'Ismeretlen hiba történt.') } finally { setLoading(false) }
  }

  function startNewAudit() { setResult(null); setVideoUrl(''); setError(''); try { sessionStorage.removeItem('willviral_video_audit_state') } catch {}; window.scrollTo({ top: 0, behavior: 'smooth' }) }

  if (loadingExisting) return <div className="wv-destination wv-video-audit"><header className="wv-page-heading"><div><span className="wv-eyebrow">Videódiagnózis</span><h1>A mentett döntés visszatér.</h1></div></header><section className="wv-video-loading-existing"><LoadingScreen steps={LOADING_STEPS.videoAudit} /></section></div>
  return (
    <div className="wv-destination wv-video-audit" data-creator-lane={creatorLane}>
      {creditCheck && <CreditConfirmModal check={creditCheck} onConfirm={() => { const action = pendingActionRef.current; setCreditCheck(null); pendingActionRef.current = null; action?.() }} onCancel={() => { setCreditCheck(null); pendingActionRef.current = null }} loading={loading} />}
      {result && !loading ? <AuditResultView result={result} canStartNew={!existingId && !paidResultId} onStartNew={startNewAudit} /> : <><header className="wv-page-heading"><div><span className="wv-eyebrow">Videódiagnózis</span><h1>Egy videóból legyen következő döntés.</h1></div><span className="wv-heading-meta">{laneCopy.lens}<br />alkotói döntéstámogatás</span></header><AuditInput platform={platform} videoUrl={videoUrl} manualData={manualData} loading={loading} error={error} onPlatform={setPlatform} onVideoUrl={setVideoUrl} onManualData={setManualData} onSubmit={handleRunAudit} />{loading && <section className="wv-video-analysis-progress"><LoadingScreen steps={LOADING_STEPS.videoAudit} /></section>}{!loading && <AuditHistory audits={auditHistory} loading={historyLoading} />}</>}
    </div>
  )
}
