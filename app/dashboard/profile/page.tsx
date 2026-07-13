'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { NARRATION_STYLES } from '@/types'
import type { Platform, Language, CreatorLevel, VideoLength, Region, NarrationStyle } from '@/types'
import { MAIN_CATEGORIES, categoryLabel, type MainCategory } from '@/lib/search/search-context'
import { validateSpecificFocus } from '@/lib/search/validate-focus'
import type { ChannelUsageMode, ChannelConnectionType, NicheCandidate } from '@/types'
import type { ChannelSnapshot } from '@/lib/competitor-tracker'

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

const platforms: { value: Platform; label: string; icon: string }[] = [
  { value: 'youtube', label: 'YouTube', icon: '▶️' },
  { value: 'tiktok', label: 'TikTok', icon: '🎵' },
  { value: 'instagram', label: 'Instagram', icon: '📸' },
  { value: 'facebook', label: 'Facebook', icon: '👥' },
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
  const router = useRouter()
  const supabase = createClient()

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
      if (Array.isArray(data.detected_niche_candidates) && data.detected_niche_candidates.length > 0) {
        setNicheCandidates(data.detected_niche_candidates as NicheCandidate[])
      }
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

  async function handleResolveChannel() {
    if (!channelInputValue.trim()) return
    setResolving(true)
    setResolveError(null)
    setResolvePreview(null)
    const res = await fetch('/api/youtube/resolve-channel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: channelInputValue.trim() }),
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
    setMainCategory(candidate.main_category as MainCategory)
    setSpecificFocus(candidate.specific_focus)
    const res = await fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        main_category: candidate.main_category,
        specific_focus: candidate.specific_focus,
        niche: candidate.specific_focus,
        selected_main_niche: candidate.specific_focus,
        channel_usage_mode: channelUsageMode,
      }),
    })
    setPickingCandidate(false)
    if (res.ok) setNiche(candidate.specific_focus)
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
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-violet border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-text-primary mb-1">Creator Profil</h1>
        <p className="text-text-secondary text-sm">
          Ezek alapján személyre szabjuk az összes elemzést és generálást.
        </p>
      </div>

      {error && (
        <div className="mb-5 px-4 py-3 rounded-xl text-sm font-medium flex items-center gap-2" style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#FCA5A5' }}>
          <i className="ti ti-alert-circle" />
          <span>{error}</span>
        </div>
      )}

      <form onSubmit={handleSave} className="space-y-6">
        {/* YouTube csatorna — csatorna-első onboarding + channel_usage_mode */}
        <div className="card">
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
                <button type="button" onClick={() => { setChannelInputValue(connectedChannel.channelUrl || connectedChannel.channelId || ''); handleResolveChannel() }} disabled={resolving} className="btn-secondary text-xs px-3 py-1.5">
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
                    <button type="button" onClick={handleResolveChannel} disabled={resolving || !channelInputValue.trim()} className="btn-secondary text-sm px-4 whitespace-nowrap">
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

          {nicheCandidates && nicheCandidates.length > 0 && (
            <div className="mt-4">
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
        </div>

        {/* Csatorna neve */}
        <div className="card">
          <label className="block text-sm font-medium text-text-secondary mb-1.5">Csatorna neve</label>
          <input value={channelName} onChange={e => setChannelName(e.target.value)} placeholder="pl. Mr.MexBrain" className="input" />
        </div>

        {/* Platform */}
        <div className="card">
          <p className="text-sm font-medium text-text-secondary mb-3">Fő platform</p>
          <div className="grid grid-cols-2 gap-2">
            {platforms.map(p => (
              <button key={p.value} type="button" onClick={() => setPlatform(p.value)}
                className={`flex items-center gap-2.5 px-4 py-3 rounded-lg border text-sm font-medium transition-all duration-150 ${platform === p.value ? 'bg-violet/10 border-violet/40 text-violet' : 'bg-surface-2 border-border text-text-secondary hover:border-border-2'}`}>
                <span>{p.icon}</span>{p.label}
              </button>
            ))}
          </div>
        </div>

        {/* Tartalomirány — strukturált niche input */}
        <div className="card">
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

          {/* Kerülendő témák */}
          <div className="mt-5">
            <label className="block text-sm font-medium text-text-secondary mb-1.5">Kerülendő témák (opcionális)</label>
            <input value={avoidTopics} onChange={e => setAvoidTopics(e.target.value)}
              placeholder="Pl. politika, bulvár, egészségügyi tanácsadás" className="input" />
          </div>
        </div>

        {/* Narrációs stílus */}
        <div className="card">
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
            <div className="mt-4">
              <label className="block text-sm font-medium text-text-secondary mb-1.5">Egyéni prompt</label>
              <textarea
                value={customPrompt}
                onChange={e => setCustomPrompt(e.target.value)}
                placeholder='pl. "Írj Dylan Page stílusú, laza, pletykás narrációt magyarul."'
                className="input min-h-[100px] resize-none"
                rows={3}
              />
            </div>
          )}
        </div>

        {/* Creator szint */}
        <div className="card">
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

        {/* Videóhossz */}
        <div className="card">
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

        {/* Régió */}
        <div className="card">
          <p className="text-sm font-medium text-text-secondary mb-3">Piaci fókusz</p>
          <div className="grid grid-cols-3 gap-2">
            {[
              { value: 'HU', label: '🇭🇺 Magyar', desc: 'HU piac' },
              { value: 'US', label: '🌍 Globális', desc: 'EN piac' },
              { value: 'BOTH', label: '🌐 Mindkettő', desc: 'Hamarosan', disabled: true },
            ].map(r => (
              <button key={r.value} type="button" onClick={() => {
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

        {/* Feliratkozók */}
        <div className="card">
          <label className="block text-sm font-medium text-text-secondary mb-1.5">Feliratkozók száma (opcionális)</label>
          <input type="number" value={subscriberCount} onChange={e => setSubscriberCount(e.target.value)} placeholder="pl. 3100" className="input" min="0" />
        </div>

        <button type="submit" disabled={saving} className="btn-primary w-full">
          {saving ? 'Mentés...' : saved ? '✓ Mentve — visszairányítás...' : 'Profil mentése'}
        </button>
      </form>
    </div>
  )
}
