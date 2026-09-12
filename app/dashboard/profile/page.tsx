'use client'

import { useState, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import { ArrowRight, CheckCircle2, CircleAlert, Compass, Facebook, Globe2, Instagram, Layers3, Save, ShieldCheck, Sparkles, Target, UserRound, Youtube, Zap, type LucideIcon } from 'lucide-react'
import { createClient } from '@/lib/supabase'
import { useCreatorOS } from '@/components/dashboard/CreatorOSContext'
import { NARRATION_STYLES } from '@/types'
import type { Platform, Language, CreatorLevel, VideoLength, Region, NarrationStyle } from '@/types'
import { MAIN_CATEGORIES, categoryLabel, type MainCategory } from '@/lib/search/search-context'
import { validateSpecificFocus } from '@/lib/search/validate-focus'
import type { ChannelUsageMode, ChannelConnectionType, NicheCandidate } from '@/types'
import type { ChannelSnapshot } from '@/lib/competitor-tracker'
import { candidatesForActiveChannel, isNicheReviewRequired } from '@/lib/channel-scope'
import NicheReviewBanner from '@/components/dashboard/NicheReviewBanner'
import OnboardingStepper from '@/components/dashboard/OnboardingStepper'
import { CREATOR_PROFILE_LANE_GUIDE, creatorProfileMarketLabel, deriveCreatorProfileFocus } from '@/lib/creator-profile-presentation'

const channelUsageModes: { value: ChannelUsageMode; label: string; desc: string }[] = [
  { value: 'primary_profile', label: 'A csatornám legyen a fő profilom alapja', desc: 'A WillViral a csatornád eddigi videói alapján személyre szabja az ajánlásokat.' },
  { value: 'stats_only', label: 'Csak statisztikai elemzésre használja', desc: 'A niche-em még alakul. A rendszer elemezze a csatornámat, de ne kényszerítse rá a témáimra.' },
  { value: 'niche_discovery', label: 'Segítsen megtalálni a niche-emet', desc: 'A WillViral több lehetséges tartalomirányt javasol a csatornaadataid alapján.' },
  { value: 'manual', label: 'Nem kötök csatornát, kézzel állítom be', desc: 'A rendszer a kézi profilbeállításaid alapján dolgozik.' },
]

function connectionTypeBadge(type: ChannelConnectionType | null): { text: string; color: string } | null {
  if (type === 'public') return { text: 'Publikus YouTube-adatok alapján', color: '#60A5FA' }
  if (type === 'oauth') return { text: 'YouTube-fiókkal összekapcsolva', color: '#22C55E' }
  if (type === 'mismatch') return { text: 'Csatorna-eltérés — válaszd ki az aktív csatornát', color: '#F59E0B' }
  return null
}

const platforms: { value: Platform; label: string; icon: LucideIcon }[] = [
  { value: 'youtube', label: 'YouTube', icon: Youtube },
  { value: 'tiktok', label: 'TikTok', icon: Zap },
  { value: 'instagram', label: 'Instagram', icon: Instagram },
  { value: 'facebook', label: 'Facebook', icon: Facebook },
]

const creatorLevels: { value: CreatorLevel; label: string; desc: string }[] = [
  { value: 'beginner', label: 'Kezdő', desc: '0–1K követő' },
  { value: 'growing', label: 'Növekvő', desc: '1K–10K követő' },
  { value: 'advanced', label: 'Haladó', desc: '10K–100K követő' },
  { value: 'professional', label: 'Profi', desc: '100K+ követő' },
]

const videoLengths: { value: VideoLength; label: string; desc: string }[] = [
  { value: 'short', label: 'Rövid', desc: '< 3 perc' },
  { value: 'medium', label: 'Közepes', desc: '3–15 perc' },
  { value: 'long', label: 'Hosszú', desc: '15+ perc' },
]

export default function ProfilePage() {
  const searchParams = useSearchParams()
  const { creatorLane, setCreatorLane } = useCreatorOS()
  const [isOnboardingMode, setIsOnboardingMode] = useState(() => searchParams.get('onboarding') === '1')
  // A profil `onboarding_completed` mezője — csak a guided-mode
  // eldöntéséhez kell, a stepper mezőit/handleSave-et nem érinti.
  // Kezdetben null (még nem tudjuk), amíg a loadProfile() be nem tölti.
  const [onboardingCompletedFlag, setOnboardingCompletedFlag] = useState<boolean | null>(null)
  const supabase = createClient()

  // guidedMode = a query paraméter VAGY a profil onboarding_completed
  // mezője alapján dől el. A useSearchParams() hook a Next.js App Router
  // soft-navigation route-cache-e miatt néha nem veszi észre, ha csak a
  // query string változik ugyanazon az útvonalon belül — ezért mountkor és
  // a hook/flag értékének minden változásakor a tényleges böngésző URL-t
  // is ellenőrizzük, ami mindig a valódi forrás.
  useEffect(() => {
    const hookValue = searchParams.get('onboarding') === '1'
    const locationValue = typeof window !== 'undefined'
      && new URLSearchParams(window.location.search).get('onboarding') === '1'
    const guidedMode = hookValue || locationValue || onboardingCompletedFlag === false
    setIsOnboardingMode(guidedMode)
  }, [searchParams, onboardingCompletedFlag])

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [channelName, setChannelName] = useState('')
  const [platform, setPlatform] = useState<Platform>('youtube')
  const [language, setLanguage] = useState<Language>('hu')
  const [niche, setNiche] = useState('')
  const [mainCategory, setMainCategory] = useState<MainCategory>('other')
  const [specificFocus, setSpecificFocus] = useState('')
  const [audience, setAudience] = useState('')
  const [avoidTopics, setAvoidTopics] = useState('')
  const [videoLength, setVideoLength] = useState<VideoLength>('medium')
  const [creatorLevel, setCreatorLevel] = useState<CreatorLevel>('growing')
  const [region, setRegion] = useState<Region>('HU')
  const [subscriberCount, setSubscriberCount] = useState('')
  const [narrationStyle, setNarrationStyle] = useState<NarrationStyle>('storytelling')
  const [customPrompt, setCustomPrompt] = useState('')

  // Csatorna-első onboarding + channel_usage_mode
  const [channelUsageMode, setChannelUsageMode] = useState<ChannelUsageMode>('manual')
  const [pickerOpen, setPickerOpen] = useState(true)
  const [channelInputValue, setChannelInputValue] = useState('')
  const [resolving, setResolving] = useState(false)
  const [resolveError, setResolveError] = useState<string | null>(null)
  const [resolvePreview, setResolvePreview] = useState<ChannelSnapshot | null>(null)
  const [connectedChannel, setConnectedChannel] = useState<{
    channelId: string | null
    channelName: string | null
    avatarUrl: string | null
    channelUrl: string | null
    handle: string | null
    subscriberCount: number | null
    connectionType: ChannelConnectionType | null
  } | null>(null)
  const [discovering, setDiscovering] = useState(false)
  const [nicheCandidates, setNicheCandidates] = useState<NicheCandidate[] | null>(null)
  const [pickingCandidate, setPickingCandidate] = useState(false)
  const [nicheNeedsReview, setNicheNeedsReview] = useState(false)

  useEffect(() => { loadProfile() }, [])

  async function loadProfile() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    const { data } = await supabase
      .from('profiles')
      .select('*')
      .eq('user_id', user.id)
      .single()

    if (data) {
      // Ugyanaz a predikátum, mint az OnboardingGuard-ban (`=== true`
      // számít késznek, minden más nem) — csak a guided-mode döntéshez.
      setOnboardingCompletedFlag(data.onboarding_completed === true)
      setChannelName(data.channel_name || '')
      setPlatform(data.platform || 'youtube')
      setLanguage(data.language || 'hu')
      setNiche(data.niche || '')
      setMainCategory((data.main_category as MainCategory) || 'other')
      setSpecificFocus(data.specific_focus || data.niche || '')
      setAudience(data.audience || '')
      setAvoidTopics(data.avoid_topics || '')
      setVideoLength(data.video_length || 'medium')
      setCreatorLevel(data.creator_level || 'growing')
      setRegion(data.region || 'HU')
      setSubscriberCount(data.subscriber_count?.toString() || '')
      setNarrationStyle(data.narration_style || 'storytelling')
      setCustomPrompt(data.custom_prompt || '')

      setChannelUsageMode((data.channel_usage_mode as ChannelUsageMode) || 'manual')
      const loadedActiveChannelId = (data.active_channel_id as string | null) || null
      setNicheNeedsReview(isNicheReviewRequired({
        storedReviewFlag: Boolean(data.niche_needs_review),
        validatedForChannelId: (data.niche_validated_for_channel_id as string | null) || null,
        candidates: data.detected_niche_candidates as NicheCandidate[] | null,
        activeChannelId: loadedActiveChannelId,
      }))
      if (data.youtube_channel_id) {
        setConnectedChannel({
          channelId: data.youtube_channel_id,
          channelName: data.channel_name || null,
          avatarUrl: data.channel_avatar_url || null,
          channelUrl: data.youtube_channel_url || null,
          handle: data.youtube_handle || null,
          subscriberCount: data.subscriber_count ?? null,
          connectionType: (data.channel_connection_type as ChannelConnectionType) || null,
        })
        setPickerOpen(false)
      } else {
        setPickerOpen(true)
      }
      const activeCandidates = candidatesForActiveChannel(data.detected_niche_candidates as NicheCandidate[] | null, loadedActiveChannelId)
      setNicheCandidates(activeCandidates.length > 0 ? activeCandidates : null)
    }
    setLoading(false)
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!specificFocus.trim()) {
      setError('A specifikus fókusz mező kötelező.')
      return
    }
    setError(null)
    setSaving(true)

    const res = await fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel_name: channelName,
        platform,
        language,
        // A niche pipeline (decomposeNicheToLanes stb.) vesszőt/perjelet
        // kategória-elválasztónak értelmez — a kategória címke ("Tech / AI")
        // ezért SOHA nem kerülhet bele a niche stringbe, csak a tiszta fókusz.
        niche: specificFocus.trim(),
        main_category: mainCategory,
        specific_focus: specificFocus,
        audience: audience || null,
        avoid_topics: avoidTopics || null,
        video_length: videoLength,
        creator_level: creatorLevel,
        region,
        subscriber_count: subscriberCount ? parseInt(subscriberCount) : null,
        narration_style: narrationStyle,
        custom_prompt: narrationStyle === 'sajat' ? customPrompt : null,
        channel_usage_mode: channelUsageMode,
      }),
    })
    const data = await res.json()
    if (!res.ok) { setError(data.error || 'Nem sikerült menteni a profilt.'); setSaving(false); return }

    setSaving(false)
    setSaved(true)
    setTimeout(() => { window.location.href = '/dashboard?setup=complete' }, 1000)
  }

  async function handleResolveChannel(inputOverride?: string) {
    const channelInput = (inputOverride ?? channelInputValue).trim()
    if (!channelInput) return
    setResolving(true)
    setResolveError(null)
    setResolvePreview(null)
    const res = await fetch('/api/youtube/resolve-channel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: channelInput }),
    })
    const data = await res.json()
    setResolving(false)
    if (!res.ok) { setResolveError(data.message || 'Nem találtunk ilyen csatornát.'); return }
    setResolvePreview(data.snapshot as ChannelSnapshot)
  }

  async function handleConfirmChannel() {
    if (!resolvePreview) return
    setResolving(true)
    setResolveError(null)
    const res = await fetch('/api/youtube/confirm-channel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel_input: channelInputValue.trim(), channel_usage_mode: channelUsageMode }),
    })
    const data = await res.json()
    setResolving(false)
    if (!res.ok) { setResolveError(data.message || 'A csatorna elmentése sikertelen.'); return }

    setResolvePreview(null)
    setChannelInputValue('')
    setPickerOpen(false)
    await loadProfile()

    if (channelUsageMode === 'niche_discovery') {
      handleDiscoverNiches(false)
    }
  }

  async function handleDiscoverNiches(forceRefresh: boolean) {
    setDiscovering(true)
    setResolveError(null)
    const res = await fetch('/api/youtube/discover-niche', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force_refresh: forceRefresh }),
    })
    const data = await res.json()
    setDiscovering(false)
    if (!res.ok) { setResolveError(data.message || 'A niche-felismerés sikertelen.'); return }
    setNicheCandidates(data.candidates as NicheCandidate[])
  }

  async function handlePickCandidate(candidate: NicheCandidate) {
    setPickingCandidate(true)
    const res = await fetch('/api/youtube/resolve-niche-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'select_candidate',
        candidate,
      }),
    })
    setPickingCandidate(false)
    if (res.ok) {
      setMainCategory(candidate.main_category as MainCategory)
      setSpecificFocus(candidate.specific_focus)
      setNiche(candidate.specific_focus)
      setNicheNeedsReview(false)
    }
  }

  async function handleKeepCurrentNiche() {
    setPickingCandidate(true)
    const res = await fetch('/api/youtube/resolve-niche-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'keep_current' }),
    })
    setPickingCandidate(false)
    if (res.ok) setNicheNeedsReview(false)
  }

  async function handleResolveMismatch(choice: 'use_oauth' | 'keep_previous' | 'keep_both') {
    setResolving(true)
    const res = await fetch('/api/youtube/resolve-mismatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ choice }),
    })
    setResolving(false)
    if (res.ok) await loadProfile()
  }

  if (loading) {
    return (
      <div className="wv-destination wv-profile">
        <header className="wv-page-heading"><div><span className="wv-eyebrow">Creator Profile</span><h1>Az alkotói profil összeáll…</h1></div></header>
        <section className="wv-profile-loading" aria-label="Creator Profile betöltése"><i /><div><span /><span /><span /></div></section>
      </div>
    )
  }

  // ── Egyes mező-kártyák egyszer definiálva — a teljes (visszatérő user)
  // nézet és az OnboardingStepper (first-run) is ugyanezeket a JSX
  // elemeket használja, csak más csoportosításban. State/handler nem
  // változik, csak a JSX elrendezés.

  const channelNameCard = (
    <div className="card wv-profile-card">
      <label className="block text-sm font-medium text-text-secondary mb-1.5">Csatorna neve</label>
      <input value={channelName} onChange={e => setChannelName(e.target.value)} placeholder="pl. Mr.MexBrain" className="input" />
    </div>
  )

  const platformCard = (
    <div className="card wv-profile-card">
      <p className="text-sm font-medium text-text-secondary mb-3">Fő platform</p>
      <div className="grid grid-cols-2 gap-2">
        {platforms.map(p => (
          <button key={p.value} type="button" onClick={() => setPlatform(p.value)}
            className={`flex items-center gap-2.5 px-4 py-3 rounded-lg border text-sm font-medium transition-all duration-150 ${platform === p.value ? 'bg-violet/10 border-violet/40 text-violet' : 'bg-surface-2 border-border text-text-secondary hover:border-border-2'}`}>
            <p.icon aria-hidden="true" />{p.label}
          </button>
        ))}
      </div>
    </div>
  )

  const contentDirectionCard = (
    <div className="card wv-profile-card">
      <p className="text-sm font-medium text-text-secondary mb-1">Milyen tartalomirányban keressünk lehetőséget?</p>
      <p className="text-text-muted text-xs mb-4">Minél konkrétabb a fókusz, annál pontosabb trendtémákat kapsz.</p>

      {/* Fő kategória */}
      <label className="block text-sm font-medium text-text-secondary mb-1.5">Fő kategória</label>
      <p className="text-text-muted text-xs mb-2">Válassz egy nagy témakört.</p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-5">
        {MAIN_CATEGORIES.map(c => (
          <button key={c.value} type="button" onClick={() => setMainCategory(c.value)}
            className={`px-3 py-2 rounded-lg border text-xs font-medium transition-all duration-150 ${mainCategory === c.value ? 'bg-violet/10 border-violet/40 text-violet' : 'bg-surface-2 border-border text-text-secondary hover:border-border-2'}`}>
            {c.label}
          </button>
        ))}
      </div>

      {/* Specifikus fókusz */}
      <label className="block text-sm font-medium text-text-secondary mb-1.5">Specifikus fókusz</label>
      <p className="text-text-muted text-xs mb-2">Ne általános kategóriát írj. Egy konkrét tartalomirányt adj meg.</p>
      <input value={specificFocus} onChange={e => setSpecificFocus(e.target.value)}
        placeholder="Pl. AI-alapú rákdiagnózis, alvás és agy, James Webb felfedezések" className="input" required />
      {specificFocus.trim() && (() => {
        const v = validateSpecificFocus(specificFocus)
        return (
          <p className="text-xs mt-2" style={{ color: v.status === 'too_broad' ? '#F59E0B' : '#22C55E' }}>
            {v.message}
          </p>
        )
      })()}
      <div className="mt-3 text-xs text-text-muted space-y-1">
        <p><span style={{ color: '#EF4444' }}>Túl tág:</span> „tudomány, hírek, egészség”</p>
        <p><span style={{ color: '#F59E0B' }}>Jó:</span> „AI az orvoslásban”</p>
        <p><span style={{ color: '#22C55E' }}>Még jobb:</span> „AI-alapú rákdiagnózis magyar nézőknek”</p>
      </div>

      {/* Közönség */}
      <div className="mt-5">
        <label className="block text-sm font-medium text-text-secondary mb-1.5">Közönség (opcionális)</label>
        <input value={audience} onChange={e => setAudience(e.target.value)}
          placeholder="Pl. laikus magyar nézők, kezdő vállalkozók, fiatal TikTok-közönség" className="input" />
      </div>
    </div>
  )

  const narrationCard = (
    <div className="card wv-profile-card">
      <p className="text-sm font-medium text-text-secondary mb-1">Alapértelmezett narrációs stílus</p>
      <p className="text-text-muted text-xs mb-3">Minden videócsomag generálásnál ezt a stílust használjuk.</p>
      <div className="grid grid-cols-2 gap-2">
        {NARRATION_STYLES.map(s => (
          <button key={s.value} type="button" onClick={() => setNarrationStyle(s.value)}
            className={`flex flex-col items-start px-4 py-3 rounded-lg border text-sm transition-all duration-150 ${narrationStyle === s.value ? 'bg-violet/10 border-violet/40' : 'bg-surface-2 border-border hover:border-border-2'}`}>
            <span className={`font-medium ${narrationStyle === s.value ? 'text-violet' : 'text-text-primary'}`}>{s.label}</span>
            <span className="text-text-muted text-xs leading-tight">{s.desc}</span>
          </button>
        ))}
      </div>

      {narrationStyle === 'sajat' && (
        <p className="text-text-muted text-xs mt-3">Az egyéni prompt szövegét a Preferences szekcióban add meg.</p>
      )}
    </div>
  )

  const creatorLevelCard = (
    <div className="card wv-profile-card">
      <p className="text-sm font-medium text-text-secondary mb-3">Creator szint</p>
      <div className="grid grid-cols-2 gap-2">
        {creatorLevels.map(l => (
          <button key={l.value} type="button" onClick={() => setCreatorLevel(l.value)}
            className={`flex flex-col items-start px-4 py-3 rounded-lg border text-sm transition-all duration-150 ${creatorLevel === l.value ? 'bg-violet/10 border-violet/40' : 'bg-surface-2 border-border hover:border-border-2'}`}>
            <span className={`font-medium ${creatorLevel === l.value ? 'text-violet' : 'text-text-primary'}`}>{l.label}</span>
            <span className="text-text-muted text-xs">{l.desc}</span>
          </button>
        ))}
      </div>
    </div>
  )

  const videoLengthCard = (
    <div className="card wv-profile-card">
      <p className="text-sm font-medium text-text-secondary mb-3">Videó hossza</p>
      <div className="grid grid-cols-3 gap-2">
        {videoLengths.map(l => (
          <button key={l.value} type="button" onClick={() => setVideoLength(l.value)}
            className={`flex flex-col items-start px-4 py-3 rounded-lg border text-sm transition-all duration-150 ${videoLength === l.value ? 'bg-violet/10 border-violet/40' : 'bg-surface-2 border-border hover:border-border-2'}`}>
            <span className={`font-medium ${videoLength === l.value ? 'text-violet' : 'text-text-primary'}`}>{l.label}</span>
            <span className="text-text-muted text-xs leading-tight">{l.desc}</span>
          </button>
        ))}
      </div>
    </div>
  )

  const regionCard = (
    <div className="card wv-profile-card">
      <p className="text-sm font-medium text-text-secondary mb-3">Piaci fókusz</p>
      <div className="grid grid-cols-3 gap-2">
        {[
          { value: 'HU', label: '🇭🇺 Magyar', desc: 'HU piac' },
          { value: 'US', label: '🌍 Globális', desc: 'EN piac' },
          { value: 'BOTH', label: '🌐 Mindkettő', desc: 'Hamarosan', disabled: true },
        ].map(r => (
          <button key={r.value} type="button" disabled={r.disabled} onClick={() => {
            if (r.disabled) return
            setRegion(r.value as Region)
            // A régió és a keresési nyelv legyen mindig konzisztens —
            // eltérő régió/nyelv kombináció gyengítette a Serper/YouTube
            // találatok minőségét (US régió + hu nyelv keveredés).
            if (r.value === 'US') setLanguage('en')
            if (r.value === 'HU') setLanguage('hu')
          }}
            className={`flex flex-col items-start px-4 py-3 rounded-lg border text-sm transition-all duration-150 ${region === r.value ? 'bg-violet/10 border-violet/40' : 'bg-surface-2 border-border hover:border-border-2'}`}>
            <span className={`font-medium ${region === r.value ? 'text-violet' : 'text-text-primary'}`}>{r.label}</span>
            <span className="text-text-muted text-xs">{r.desc}</span>
          </button>
        ))}
      </div>
      <p className="text-text-muted text-xs mt-3">A régió automatikusan beállítja a keresési nyelvet is (Magyar → hu, Globális → en).</p>
    </div>
  )

  const subscriberCard = (
    <div className="card wv-profile-card">
      <label className="block text-sm font-medium text-text-secondary mb-1.5">Feliratkozók száma (opcionális)</label>
      <input type="number" value={subscriberCount} onChange={e => setSubscriberCount(e.target.value)} placeholder="pl. 3100" className="input" min="0" />
    </div>
  )

  const youtubeChannelCardInner = (
    <>
      <p className="text-sm font-medium text-text-secondary mb-1">YouTube csatorna</p>
      <p className="text-text-muted text-xs mb-4">Nem kötelező OAuth — elég a csatornád URL-je vagy @handle-je.</p>

      {connectedChannel && !pickerOpen && (
        <div>
          <div className="flex items-center gap-3 p-3 rounded-lg bg-surface-2 border border-border">
            {connectedChannel.avatarUrl ? (
              <img src={connectedChannel.avatarUrl} alt={connectedChannel.channelName || ''} className="w-11 h-11 rounded-full object-cover flex-shrink-0" />
            ) : (
              <div className="w-11 h-11 rounded-full bg-violet/20 text-violet flex items-center justify-center font-semibold flex-shrink-0">
                {(connectedChannel.channelName || '?').charAt(0).toUpperCase()}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-text-primary truncate">{connectedChannel.channelName}</p>
              <p className="text-text-muted text-xs truncate">
                {connectedChannel.handle ? `@${connectedChannel.handle}` : ''}
                {connectedChannel.subscriberCount != null ? ` · ${connectedChannel.subscriberCount.toLocaleString('hu-HU')} feliratkozó` : ''}
              </p>
            </div>
          </div>

          {connectionTypeBadge(connectedChannel.connectionType) && (
            <p className="text-xs mt-2 font-medium" style={{ color: connectionTypeBadge(connectedChannel.connectionType)!.color }}>
              {connectionTypeBadge(connectedChannel.connectionType)!.text}
            </p>
          )}

          <div className="flex flex-wrap gap-2 mt-3">
            <button type="button" onClick={() => { const channelInput = connectedChannel.channelUrl || connectedChannel.channelId || ''; setChannelInputValue(channelInput); void handleResolveChannel(channelInput) }} disabled={resolving} className="btn-secondary text-xs px-3 py-1.5">
              Újraelemzés
            </button>
            <button type="button" onClick={() => setPickerOpen(true)} className="btn-secondary text-xs px-3 py-1.5">
              Mód váltása
            </button>
            {connectedChannel.connectionType !== 'oauth' && connectedChannel.connectionType !== 'mismatch' && (
              <a href="/api/youtube/connect" className="btn-secondary text-xs px-3 py-1.5">
                YouTube-fiók összekötése mélyebb elemzéshez
              </a>
            )}
          </div>

          {connectedChannel.connectionType === 'mismatch' && (
            <div className="mt-4 p-3 rounded-lg" style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)' }}>
              <p className="text-sm text-text-primary mb-2">Az összekapcsolt YouTube-fiók csatornája eltér a profilban megadott csatornától. Melyiket szeretnéd használni fő csatornaként?</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => handleResolveMismatch('use_oauth')} disabled={resolving} className="btn-secondary text-xs px-3 py-1.5">OAuth csatorna használata</button>
                <button type="button" onClick={() => handleResolveMismatch('keep_previous')} disabled={resolving} className="btn-secondary text-xs px-3 py-1.5">Korábbi csatorna megtartása</button>
                <button type="button" onClick={() => handleResolveMismatch('keep_both')} disabled={resolving} className="btn-secondary text-xs px-3 py-1.5">Mindkettő megtartása</button>
              </div>
            </div>
          )}

          {channelUsageMode === 'niche_discovery' && (
            <div className="mt-4">
              <button type="button" onClick={() => handleDiscoverNiches(!!nicheCandidates)} disabled={discovering} className="btn-secondary text-xs px-3 py-1.5">
                {discovering ? 'Elemzés...' : nicheCandidates ? 'Niche újraelemzése (1 kredit)' : 'Niche felismerése'}
              </button>
            </div>
          )}
        </div>
      )}

      {pickerOpen && (
        <div>
          <p className="text-sm font-medium text-text-secondary mb-2">Hogyan használja a WillViral a YouTube csatornádat?</p>
          <div className="grid grid-cols-1 gap-2 mb-4">
            {channelUsageModes.map(m => (
              <button key={m.value} type="button" onClick={() => setChannelUsageMode(m.value)}
                className={`flex flex-col items-start px-4 py-3 rounded-lg border text-sm text-left transition-all duration-150 ${channelUsageMode === m.value ? 'bg-violet/10 border-violet/40' : 'bg-surface-2 border-border hover:border-border-2'}`}>
                <span className={`font-medium ${channelUsageMode === m.value ? 'text-violet' : 'text-text-primary'}`}>{m.label}</span>
                <span className="text-text-muted text-xs leading-tight">{m.desc}</span>
              </button>
            ))}
          </div>

          {channelUsageMode !== 'manual' && !connectedChannel && (
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1.5">Csatorna URL, @handle vagy channelId</label>
              <div className="flex gap-2">
                <input value={channelInputValue} onChange={e => setChannelInputValue(e.target.value)}
                  placeholder="pl. youtube.com/@csatornaneved" className="input flex-1" />
                <button type="button" onClick={() => void handleResolveChannel()} disabled={resolving || !channelInputValue.trim()} className="btn-secondary text-sm px-4 whitespace-nowrap">
                  {resolving ? 'Keresés...' : 'Csatorna elemzése'}
                </button>
              </div>
              {resolveError && <p className="text-xs mt-2" style={{ color: '#F87171' }}>{resolveError}</p>}

              {resolvePreview && (
                <div className="mt-3 p-3 rounded-lg bg-surface-2 border border-border">
                  <p className="text-xs text-text-muted mb-2">Ez a te csatornád?</p>
                  <div className="flex items-center gap-3">
                    {resolvePreview.thumbnailHigh || resolvePreview.thumbnail ? (
                      <img src={resolvePreview.thumbnailHigh || resolvePreview.thumbnail || ''} alt={resolvePreview.title} className="w-10 h-10 rounded-full object-cover flex-shrink-0" />
                    ) : (
                      <div className="w-10 h-10 rounded-full bg-violet/20 text-violet flex items-center justify-center font-semibold flex-shrink-0">
                        {resolvePreview.title.charAt(0).toUpperCase()}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-text-primary truncate">{resolvePreview.title}</p>
                      <p className="text-text-muted text-xs">{resolvePreview.subscriberCount.toLocaleString('hu-HU')} feliratkozó</p>
                    </div>
                    <button type="button" onClick={handleConfirmChannel} disabled={resolving} className="btn-primary text-xs px-3 py-1.5 whitespace-nowrap">
                      Megerősítés
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {channelUsageMode === 'manual' && (
            <p className="text-text-muted text-xs">A rendszer a lentebbi kézi profilbeállításaid alapján dolgozik.</p>
          )}
        </div>
      )}
    </>
  )
  const youtubeChannelCard = <div className="card wv-profile-card">{youtubeChannelCardInner}</div>

  const nicheValidationContent = (
    <>
      {nicheNeedsReview && (
        <div id="niche-review" className="mb-4">
          <NicheReviewBanner
            onKeepCurrent={handleKeepCurrentNiche}
            onReanalyze={() => handleDiscoverNiches(false)}
            loading={pickingCandidate || discovering}
          />
        </div>
      )}

      {nicheCandidates && nicheCandidates.length > 0 && (
        <div className="card wv-profile-card">
          <p className="text-sm font-medium text-text-secondary mb-2">Lehetséges tartalomirányok a csatornád alapján</p>
          <div className="space-y-2">
            {nicheCandidates.map((c, i) => (
              <button key={i} type="button" onClick={() => handlePickCandidate(c)} disabled={pickingCandidate}
                className={`w-full text-left px-4 py-3 rounded-lg border text-sm transition-all duration-150 ${specificFocus === c.specific_focus ? 'bg-violet/10 border-violet/40' : 'bg-surface-2 border-border hover:border-border-2'}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-text-primary">{categoryLabel(c.main_category)} — {c.specific_focus}</span>
                  <span className="text-text-muted text-xs flex-shrink-0">{Math.round(c.confidence * 100)}%</span>
                </div>
                {c.rationale && <p className="text-text-muted text-xs mt-1">{c.rationale}</p>}
              </button>
            ))}
          </div>
        </div>
      )}

      {!nicheNeedsReview && !(nicheCandidates && nicheCandidates.length > 0) && (
        <div className="card wv-profile-card flex items-center gap-2">
          <span className="text-emerald">✓</span>
          <p className="text-sm text-text-secondary">A niche-ed rendben van, nincs teendő.</p>
        </div>
      )}
    </>
  )

  const avoidTopicsCard = (
    <div className="card wv-profile-card">
      <label className="block text-sm font-medium text-text-secondary mb-1.5">Kerülendő témák (opcionális)</label>
      <input value={avoidTopics} onChange={e => setAvoidTopics(e.target.value)}
        placeholder="Pl. politika, bulvár, egészségügyi tanácsadás" className="input" />
    </div>
  )

  const customPromptCard = narrationStyle === 'sajat' ? (
    <div className="card wv-profile-card">
      <label className="block text-sm font-medium text-text-secondary mb-1.5">Egyéni narrációs prompt</label>
      <p className="text-text-muted text-xs mb-2">A Creator Profile-nál kiválasztott „Saját” narrációs stílushoz tartozó szöveg.</p>
      <textarea
        value={customPrompt}
        onChange={e => setCustomPrompt(e.target.value)}
        placeholder='pl. "Írj Dylan Page stílusú, laza, pletykás narrációt magyarul."'
        className="input min-h-[100px] resize-none"
        rows={3}
      />
    </div>
  ) : null

  const submitButton = (
    <button type="submit" disabled={saving} className="wv-primary-action w-full">
      {saving ? 'Mentés…' : saved ? 'Mentve — visszairányítás…' : 'Profil mentése'}<Save aria-hidden="true" />
    </button>
  )

  const onboardingSteps = [
    { key: 'youtube', label: 'YouTube csatorna', content: youtubeChannelCard },
    { key: 'niche', label: 'Niche állapot', content: nicheValidationContent },
    { key: 'basics', label: 'Alapadatok', content: <>{channelNameCard}{platformCard}</> },
    { key: 'direction', label: 'Tartalomirány', content: contentDirectionCard },
    { key: 'narration', label: 'Narrációs stílus', content: narrationCard },
    { key: 'level', label: 'Creator szint és videóhossz', content: <>{creatorLevelCard}{videoLengthCard}</> },
    { key: 'market', label: 'Piac és preferenciák', content: <>{regionCard}{subscriberCard}{avoidTopicsCard}{customPromptCard}</> },
  ]

  const profileFocus = deriveCreatorProfileFocus({ specificFocus, nicheNeedsReview })
  const creatorLevelLabel = creatorLevels.find(item => item.value === creatorLevel)?.label || creatorLevel
  const platformLabel = platforms.find(item => item.value === platform)?.label || platform

  return (
    <div className="wv-destination wv-profile" data-creator-lane={creatorLane}>
      <header className="wv-page-heading"><div><span className="wv-eyebrow">Creator Profile</span><h1>Innen lesz a platform valóban a tiéd.</h1></div><span className="wv-heading-meta">alkotói identitás<br />személyre szabott rendszer</span></header>

      {error && (
        <div className="wv-profile-alert" role="alert">
          <CircleAlert aria-hidden="true" /><span><strong>A profil most nem menthető.</strong>{error}</span>
        </div>
      )}

      <section className="wv-profile-stage" aria-label="Aktív alkotói profil és következő döntés">
        <div className="wv-profile-identity">
          <div className="wv-profile-avatar">{connectedChannel?.avatarUrl ? <img src={connectedChannel.avatarUrl} alt={connectedChannel.channelName || 'Csatorna'} /> : <UserRound aria-hidden="true" />}<i aria-hidden="true" /></div>
          <div className="wv-profile-identity-copy"><span className="wv-eyebrow">Aktív alkotói identitás</span><h2>{channelName || connectedChannel?.channelName || 'A csatornád karaktere'}</h2>{connectedChannel?.handle && <a href={connectedChannel.channelUrl || '#'} target="_blank" rel="noopener noreferrer">@{connectedChannel.handle}</a>}<p>{specificFocus || 'A konkrét tartalmi fókusz megadásával válik személyessé a lehetőségkeresés és az alkotói workflow.'}</p></div>
          <div className="wv-profile-facts"><div><span>Fő platform</span><strong>{platformLabel}</strong></div><div><span>Piaci fókusz</span><strong>{creatorProfileMarketLabel(region, language)}</strong></div><div><span>Creator szint</span><strong>{creatorLevelLabel}</strong></div></div>
        </div>
        <div className={`wv-profile-focus state-${profileFocus.kind}`}>
          <span className="wv-profile-focus-index"><Target aria-hidden="true" />01</span><div><span className="wv-eyebrow">{profileFocus.label}</span><h2>{profileFocus.title}</h2><p>{profileFocus.description}</p></div>
          <a href={profileFocus.kind === 'niche_review' ? '#niche-review' : '#profile-direction'} className="wv-primary-action">{profileFocus.kind === 'niche_review' ? 'Niche-döntés megnyitása' : profileFocus.kind === 'needs_focus' ? 'Fókusz megadása' : 'Profil finomhangolása'}<ArrowRight aria-hidden="true" /></a>
        </div>
      </section>

      <section className="wv-profile-lanes" aria-labelledby="wv-profile-lanes-title">
        <header><div><span className="wv-eyebrow">Két Creator Lane</span><h2 id="wv-profile-lanes-title">Két alkotói logika. Egy közös platformmag.</h2></div><span>Az aktuális projekt dönti el, melyik Lane vezeti a munkát.</span></header>
        <div>{(['evidence', 'entertainment'] as const).map((lane, index) => {
          const guide = CREATOR_PROFILE_LANE_GUIDE[lane]
          return <button key={lane} type="button" aria-pressed={creatorLane === lane} onClick={() => setCreatorLane(lane)}><span>{String(index + 1).padStart(2, '0')}</span><div><small>{guide.label}</small><h3>{guide.headline}</h3><p>{guide.role}</p><div>{guide.signals.map(signal => <em key={signal}>{signal}</em>)}</div></div>{creatorLane === lane && <CheckCircle2 aria-hidden="true" />}</button>
        })}</div>
        <p><ShieldCheck aria-hidden="true" /><span><strong>Ez munkanézet, nem globális korlátozás.</strong>Itt összehasonlíthatod a két alkotói logikát; a valódi Lane minden új projekt indításakor dől el.</span></p>
      </section>

      <form onSubmit={handleSave} className="wv-profile-form">
        {isOnboardingMode ? (
          <section className="wv-profile-onboarding"><OnboardingStepper steps={onboardingSteps} submitSlot={submitButton} /></section>
        ) : (
          <>
            <section className="wv-profile-section" id="profile-identity">
              <header><span>01</span><div><small>Identitás</small><h2>Hogyan jelenik meg az alkotói profilod?</h2></div><UserRound aria-hidden="true" /></header>
              <div className="wv-profile-grid">{channelNameCard}{platformCard}{creatorLevelCard}{subscriberCard}</div>
            </section>
            <section className="wv-profile-section" id="profile-direction">
              <header><span>02</span><div><small>Tartalmi irány</small><h2>Hol keressen neked valódi lehetőséget a rendszer?</h2></div><Compass aria-hidden="true" /></header>
              <div className="wv-profile-direction-grid">{contentDirectionCard}<div className="wv-profile-niche-state">{nicheValidationContent}</div></div>
            </section>
            <section className="wv-profile-section" id="profile-channel">
              <header><span>03</span><div><small>Csatornakapcsolat</small><h2>A publikus identitás és a privát analitika külön réteg.</h2></div><Youtube aria-hidden="true" /></header>
              {youtubeChannelCard}
            </section>
            <section className="wv-profile-section" id="profile-voice">
              <header><span>04</span><div><small>Hang és forma</small><h2>A megszólalás ritmusa illeszkedjen hozzád.</h2></div><Sparkles aria-hidden="true" /></header>
              <div className="wv-profile-grid">{narrationCard}{videoLengthCard}</div>
            </section>
            <section className="wv-profile-section" id="profile-market">
              <header><span>05</span><div><small>Piac és határok</small><h2>Hol keressünk, és mit hagyjunk tudatosan kívül?</h2></div><Globe2 aria-hidden="true" /></header>
              <div className="wv-profile-grid">{regionCard}{avoidTopicsCard}{customPromptCard}</div>
            </section>
            <div className="wv-profile-save-rail"><span>{saved ? <CheckCircle2 aria-hidden="true" /> : <Layers3 aria-hidden="true" />}<span><strong>{saved ? 'A profil mentve.' : 'A változtatások mentésre készek.'}</strong><small>A mentés a meglévő profilmezőket frissíti.</small></span></span>{submitButton}</div>
          </>
        )}
      </form>
    </div>
  )
}
