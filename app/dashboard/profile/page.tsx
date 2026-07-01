'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { NARRATION_STYLES } from '@/types'
import type { Platform, Language, CreatorLevel, VideoLength, Region, NarrationStyle } from '@/types'

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

  const [channelName, setChannelName] = useState('')
  const [platform, setPlatform] = useState<Platform>('youtube')
  const [language, setLanguage] = useState<Language>('hu')
  const [niche, setNiche] = useState('')
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
    setSaving(true)

    const res = await fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel_name: channelName,
        platform,
        language,
        niche,
        video_length: videoLength,
        creator_level: creatorLevel,
        region,
        subscriber_count: subscriberCount ? parseInt(subscriberCount) : null,
        narration_style: narrationStyle,
        custom_prompt: narrationStyle === 'sajat' ? customPrompt : null,
      }),
    })
    const data = await res.json()
    if (!res.ok) { alert('Hiba: ' + data.error); setSaving(false); return; }

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

        {/* Niche */}
        <div className="card">
          <label className="block text-sm font-medium text-text-secondary mb-1.5">Niche / téma</label>
          <input value={niche} onChange={e => setNiche(e.target.value)} placeholder="pl. hírek, egészség, tudomány, tech, pénzügy..." className="input" required />
          <p className="text-text-muted text-xs mt-2">Minél pontosabb, annál jobb az Opportunity Engine ajánlása.</p>
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
              <button key={r.value} type="button" onClick={() => setRegion(r.value as Region)}
                className={`flex flex-col items-start px-4 py-3 rounded-lg border text-sm transition-all duration-150 ${region === r.value ? 'bg-violet/10 border-violet/40' : 'bg-surface-2 border-border hover:border-border-2'}`}>
                <span className={`font-medium ${region === r.value ? 'text-violet' : 'text-text-primary'}`}>{r.label}</span>
                <span className="text-text-muted text-xs">{r.desc}</span>
              </button>
            ))}
          </div>
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
