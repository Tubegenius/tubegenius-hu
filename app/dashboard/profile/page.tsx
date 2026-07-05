'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { NARRATION_STYLES } from '@/types'
import type { Platform, Language, CreatorLevel, VideoLength, Region, NarrationStyle } from '@/types'
import { MAIN_CATEGORIES, type MainCategory } from '@/lib/search/search-context'
import { validateSpecificFocus } from '@/lib/search/validate-focus'

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
      }),
    })
    const data = await res.json()
    if (!res.ok) { setError(data.error || 'Nem sikerült menteni a profilt.'); setSaving(false); return }

    setSaving(false)
    setSaved(true)
    setTimeout(() => { window.location.href = '/dashboard' }, 1000)
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
